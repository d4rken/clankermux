import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	BunSqlAdapter,
	ensureSchema,
	SdkBridgeTurnRepository,
} from "@clankermux/database";
import type {
	SdkBridgeHealthResponse,
	SdkBridgeTurnInsert,
	SdkBridgeTurnStatus,
} from "@clankermux/types";
import { createSdkBridgeHealthHandlerFromSources } from "../sdk-bridge-health-direct";

const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const HOUR = 3_600_000;

let db: Database;
let repo: SdkBridgeTurnRepository;

beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	repo = new SdkBridgeTurnRepository(new BunSqlAdapter(db));
	db.run(
		`INSERT INTO accounts (id, name, provider, refresh_token, created_at)
		VALUES ('acct-a', 'Claude-a', 'claude-oauth', 'tok', 0),
			('acct-b', 'Claude-b', 'claude-oauth', 'tok', 0)`,
	);
});

afterEach(() => {
	db.close();
});

type TurnOver = Partial<SdkBridgeTurnInsert> & {
	spawnMs?: number;
	durationMs?: number;
	toolRounds?: number;
	httpStatus?: number;
	errorType?: string;
	errorMessage?: string;
};

async function turn(
	id: string,
	ageMs: number,
	status: SdkBridgeTurnStatus,
	over: TurnOver = {},
): Promise<void> {
	const startedAt = NOW - ageMs;
	await repo.insertTurn({
		id,
		startedAt,
		historyMode: "fresh",
		systemPromptPolicy: "drop",
		accountId: "acct-a",
		clientHarness: "pi",
		...over,
		status,
	});
	if (status !== "running" && status !== "released")
		await repo.finishTurn(id, {
			finishedAt: startedAt + 1,
			status,
			spawnMs: over.spawnMs,
			durationMs: over.durationMs,
			httpStatus: over.httpStatus,
			errorType: over.errorType,
			errorMessage: over.errorMessage,
		});
	if (over.toolRounds)
		await repo.bumpTurnCounters(id, { toolRounds: over.toolRounds });
}

function inner(id: string, turnId: string, costUsd: number): void {
	db.run(
		`INSERT INTO requests (id, timestamp, method, path, success,
			input_tokens, output_tokens, cost_usd, sdk_bridge_turn_id)
		VALUES (?, ?, 'POST', '/v1/messages', 1, 100, 10, ?, ?)`,
		[id, NOW, costUsd, turnId],
	);
}

async function health(range = "24h"): Promise<SdkBridgeHealthResponse> {
	const handler = createSdkBridgeHealthHandlerFromSources(
		Object.assign(repo, { now: () => NOW }),
	);
	const response = await handler(new URLSearchParams({ range }));
	expect(response.status).toBe(200);
	return (await response.json()) as SdkBridgeHealthResponse;
}

describe("SDK bridge health", () => {
	it("counts every status, released included, and only the range", async () => {
		await turn("old", 25 * HOUR, "failed");
		await turn("c1", HOUR, "completed");
		await turn("c2", HOUR, "completed");
		await turn("f1", HOUR, "failed");
		await turn("x1", HOUR, "timed_out");
		await turn("s1", HOUR, "shutdown");
		await turn("a1", HOUR, "aborted");
		await turn("r1", HOUR, "rejected");
		await turn("run", HOUR, "running");
		await turn("rel", HOUR, "released");
		await turn("side", HOUR, "completed", { kind: "side_request" });

		const data = await health();

		expect(data.range).toBe("24h");
		expect(data.windowStartsAt).toBe(NOW - 24 * HOUR);
		expect(data.total).toBe(10);
		expect(data.byStatus).toEqual({
			running: 1,
			released: 1,
			completed: 3,
			failed: 1,
			aborted: 1,
			timed_out: 1,
			shutdown: 1,
			rejected: 1,
		});
		expect(data.byKind).toEqual({ turn: 9, side_request: 1 });
		// Failed and timed out over everything that ended on the bridge's side:
		// running, released, rejected and aborted stay out of the denominator.
		expect(data.failureRate).toEqual({ failures: 2, finished: 6, rate: 2 / 6 });

		expect((await health("all")).total).toBe(11);
	});

	it("answers an empty range with zeros and a null rate", async () => {
		const data = await health();
		expect(data.total).toBe(0);
		expect(data.failureRate).toEqual({ failures: 0, finished: 0, rate: null });
		expect(data.byHistoryMode).toEqual({
			fresh: 0,
			resume: 0,
			rebuild_transcript: 0,
			rebuild_flattened: 0,
		});
		expect(data.timings.spawnMs).toEqual({ samples: 0, p50: null, p95: null });
		expect(data.recentFailures).toEqual([]);
		expect(data.inner).toEqual({
			requestCount: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			costUsd: 0,
		});
	});

	it("groups errors and lists the newest failures with truncated messages", async () => {
		const long = "x".repeat(400);
		await turn("f1", 3 * HOUR, "failed", {
			httpStatus: 529,
			errorType: "overloaded_error",
			errorMessage: long,
		});
		await turn("f2", 2 * HOUR, "failed", {
			httpStatus: 529,
			errorType: "overloaded_error",
			errorMessage: "Overloaded",
		});
		await turn("x1", HOUR, "timed_out", { errorType: "timeout" });
		await turn("r1", HOUR / 2, "rejected", {
			httpStatus: 400,
			errorType: "invalid_request_error",
			errorMessage: "sdk_bridge_prompt_refused",
			clientHarness: "codex",
		});
		await turn("a1", HOUR / 4, "aborted", { errorType: "client_disconnect" });

		const data = await health();

		expect(data.errors).toEqual([
			{
				status: "failed",
				errorType: "overloaded_error",
				httpStatus: 529,
				count: 2,
			},
			{
				status: "rejected",
				errorType: "invalid_request_error",
				httpStatus: 400,
				count: 1,
			},
			{ status: "timed_out", errorType: "timeout", httpStatus: null, count: 1 },
		]);
		expect(data.recentFailures.map((f) => f.id)).toEqual([
			"r1",
			"x1",
			"f2",
			"f1",
		]);
		expect(data.recentFailures[3]?.errorMessage).toHaveLength(160);
		expect(data.recentFailures[0]?.clientHarness).toBe("codex");
	});

	it("splits by harness and account, with inner cost", async () => {
		await turn("p1", HOUR, "completed");
		await turn("p2", HOUR, "failed", { accountId: "acct-b" });
		await turn("c1", HOUR, "rejected", {
			clientHarness: "codex",
			accountId: null,
		});
		await turn("gone", HOUR, "completed", { accountId: "acct-deleted" });
		inner("r1", "p1", 0.5);
		inner("r2", "p2", 0.25);

		const data = await health();

		expect(data.byHarness).toEqual([
			{
				key: "pi",
				name: null,
				total: 3,
				completed: 2,
				failures: 1,
				finished: 3,
				rejected: 0,
				aborted: 0,
				costUsd: 0.75,
			},
			{
				key: "codex",
				name: null,
				total: 1,
				completed: 0,
				failures: 0,
				finished: 0,
				rejected: 1,
				aborted: 0,
				costUsd: 0,
			},
		]);
		expect(
			data.byAccount.map((a) => [a.key, a.name, a.total, a.costUsd]),
		).toEqual([
			["acct-a", "Claude-a", 1, 0.5],
			["acct-b", "Claude-b", 1, 0.25],
			["acct-deleted", null, 1, 0],
			[null, null, 1, 0],
		]);
		expect(data.inner.requestCount).toBe(2);
		expect(data.inner.inputTokens).toBe(200);
		expect(data.inner.costUsd).toBe(0.75);
	});

	it("reports timings over non-null values and tool rounds over ended turns", async () => {
		await turn("t1", HOUR, "completed", {
			spawnMs: 100,
			durationMs: 1_000,
			toolRounds: 2,
		});
		await turn("t2", HOUR, "failed", { spawnMs: 300, toolRounds: 6 });
		await turn("rel", HOUR, "released", { toolRounds: 9 });
		await turn("side", HOUR, "completed", {
			kind: "side_request",
			spawnMs: 200,
		});
		await turn("rej", HOUR, "rejected");

		const data = await health();

		expect(data.timings.spawnMs).toEqual({ samples: 3, p50: 200, p95: 300 });
		expect(data.timings.durationMs).toEqual({
			samples: 1,
			p50: 1_000,
			p95: 1_000,
		});
		expect(data.timings.firstEventMs.samples).toBe(0);
		expect(data.toolRounds).toEqual({ samples: 2, p50: 2, p95: 6, total: 8 });
	});

	it("counts history modes and rebuild reasons", async () => {
		await turn("a", HOUR, "completed", { historyMode: "resume" });
		await turn("b", HOUR, "completed", {
			historyMode: "resume",
			rebuildReason: "account_change",
		});
		await turn("c", HOUR, "completed", {
			historyMode: "rebuild_flattened",
			rebuildReason: "dead_continuation",
		});

		const data = await health();

		expect(data.byHistoryMode).toEqual({
			fresh: 0,
			resume: 2,
			rebuild_transcript: 0,
			rebuild_flattened: 1,
		});
		expect(data.byRebuildReason).toEqual({
			continuation: 0,
			compaction: 0,
			edit: 0,
			unknown: 0,
			account_change: 1,
			dead_continuation: 1,
		});
	});
});
