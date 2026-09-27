/**
 * The health card's reads over `sdk_bridge_turns`, against a real schema.
 * Every read is bounded by `started_at >= sinceMs`; a turn before it and an
 * inner request of that turn must never count.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type {
	SdkBridgeTurnInsert,
	SdkBridgeTurnStatus,
} from "@clankermux/types";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema } from "../migrations";
import { SdkBridgeTurnRepository } from "../repositories/sdk-bridge-turn.repository";

const SINCE = 1_000_000;

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

async function turn(
	id: string,
	startedAt: number,
	status: SdkBridgeTurnStatus,
	over: Partial<SdkBridgeTurnInsert> & {
		spawnMs?: number | null;
		firstEventMs?: number | null;
		durationMs?: number | null;
		toolRounds?: number;
		httpStatus?: number | null;
		errorType?: string | null;
		errorMessage?: string | null;
	} = {},
): Promise<void> {
	await repo.insertTurn({
		id,
		startedAt,
		historyMode: "fresh",
		systemPromptPolicy: "drop",
		accountId: "acct-a",
		clientHarness: "pi",
		model: "claude-opus-5-5",
		...over,
		status,
	});
	if (status !== "running" && status !== "released") {
		await repo.finishTurn(id, {
			finishedAt: startedAt + 1,
			status,
			spawnMs: over.spawnMs ?? null,
			firstEventMs: over.firstEventMs ?? null,
			durationMs: over.durationMs ?? null,
			httpStatus: over.httpStatus ?? null,
			errorType: over.errorType ?? null,
			errorMessage: over.errorMessage ?? null,
		});
	}
	if (over.toolRounds)
		await repo.bumpTurnCounters(id, { toolRounds: over.toolRounds });
}

function inner(
	id: string,
	turnId: string,
	tokens: { input: number; output: number; cost: number },
	servedBy = "acct-a",
): void {
	db.run(
		`INSERT INTO requests (id, timestamp, method, path, success,
			input_tokens, output_tokens, cache_read_input_tokens,
			cache_creation_input_tokens, cost_usd, sdk_bridge_turn_id,
			account_used)
		VALUES (?, ?, 'POST', '/v1/messages', 1, ?, ?, 10, 5, ?, ?, ?)`,
		[
			id,
			SINCE + 10,
			tokens.input,
			tokens.output,
			tokens.cost,
			turnId,
			servedBy,
		],
	);
}

async function seed(): Promise<void> {
	await turn("old", SINCE - 1, "failed", { errorType: "api_error" });
	await turn("t1", SINCE, "completed", {
		spawnMs: 100,
		firstEventMs: 300,
		durationMs: 1_000,
		toolRounds: 2,
		historyMode: "resume",
	});
	await turn("t2", SINCE + 1, "completed", {
		spawnMs: 200,
		durationMs: 3_000,
		toolRounds: 4,
		historyMode: "rebuild_flattened",
		rebuildReason: "dead_continuation",
	});
	await turn("t3", SINCE + 2, "failed", {
		spawnMs: 300,
		httpStatus: 529,
		errorType: "overloaded_error",
		errorMessage: "Overloaded",
	});
	await turn("t4", SINCE + 3, "rejected", {
		httpStatus: 400,
		errorType: "invalid_request_error",
		errorMessage: "sdk_bridge_prompt_refused",
		clientHarness: "codex",
		accountId: null,
	});
	await turn("t5", SINCE + 4, "released", { toolRounds: 1 });
	await turn("s1", SINCE + 5, "completed", {
		kind: "side_request",
		spawnMs: 400,
	});
	inner("r-old", "old", { input: 1_000, output: 1_000, cost: 9 });
	inner("r1", "t1", { input: 100, output: 20, cost: 0.5 });
	inner("r2", "t1", { input: 50, output: 10, cost: 0.25 });
	// Failover: t3's turn chose acct-a, and acct-b served its call.
	inner("r3", "t3", { input: 7, output: 3, cost: 0.125 }, "acct-b");
}

describe("SdkBridgeTurnRepository health reads", () => {
	it("counts rows in range by kind, status, history, harness and account", async () => {
		await seed();
		const rows = await repo.countHealthGroups(SINCE);
		const total = rows.reduce((n, r) => n + r.count, 0);
		expect(total).toBe(6);
		expect(rows).toContainEqual({
			kind: "turn",
			status: "rejected",
			historyMode: "fresh",
			rebuildReason: null,
			clientHarness: "codex",
			accountId: null,
			accountName: null,
			count: 1,
		});
		expect(rows).toContainEqual({
			kind: "turn",
			status: "completed",
			historyMode: "rebuild_flattened",
			rebuildReason: "dead_continuation",
			clientHarness: "pi",
			accountId: "acct-a",
			accountName: "Claude-a",
			count: 1,
		});
		expect(rows.some((r) => r.status === "failed" && r.count === 2)).toBe(
			false,
		);
	});

	it("groups errors by status, type and HTTP status for the named statuses", async () => {
		await seed();
		const rows = await repo.countHealthErrors(SINCE, [
			"failed",
			"timed_out",
			"rejected",
		]);
		expect(rows).toEqual([
			{
				status: "failed",
				errorType: "overloaded_error",
				httpStatus: 529,
				count: 1,
			},
			{
				status: "rejected",
				errorType: "invalid_request_error",
				httpStatus: 400,
				count: 1,
			},
		]);
	});

	it("takes nearest-rank percentiles over non-null values", async () => {
		await seed();
		// 100, 200, 300, 400: the lower median and the top value.
		expect(await repo.healthPercentiles(SINCE, "spawn_ms")).toEqual({
			samples: 4,
			p50: 200,
			p95: 400,
			total: 1_000,
		});
		expect(await repo.healthPercentiles(SINCE, "first_event_ms")).toEqual({
			samples: 1,
			p50: 300,
			p95: 300,
			total: 300,
		});
		expect(
			await repo.healthPercentiles(SINCE, "tool_round_count", {
				kind: "turn",
				statuses: ["completed", "failed"],
			}),
		).toEqual({ samples: 3, p50: 2, p95: 4, total: 6 });
	});

	it("answers no samples as nulls", async () => {
		expect(await repo.healthPercentiles(SINCE, "duration_ms")).toEqual({
			samples: 0,
			p50: null,
			p95: null,
			total: 0,
		});
	});

	it("sums inner requests of the range's turns by the account that served them", async () => {
		await seed();
		const rows = await repo.sumHealthInnerUsage(SINCE);
		expect(rows).toEqual([
			{
				clientHarness: "pi",
				servedAccountId: "acct-a",
				servedAccountName: "Claude-a",
				requestCount: 2,
				inputTokens: 150,
				outputTokens: 30,
				cacheReadInputTokens: 20,
				cacheCreationInputTokens: 10,
				costUsd: 0.75,
			},
			{
				clientHarness: "pi",
				servedAccountId: "acct-b",
				servedAccountName: "Claude-b",
				requestCount: 1,
				inputTokens: 7,
				outputTokens: 3,
				cacheReadInputTokens: 10,
				cacheCreationInputTokens: 5,
				costUsd: 0.125,
			},
		]);
	});

	it("lists the newest failures first, bounded by range and limit", async () => {
		await seed();
		const rows = await repo.listHealthFailures(
			SINCE,
			["failed", "timed_out", "rejected"],
			1,
		);
		expect(rows).toEqual([
			{
				id: "t4",
				kind: "turn",
				status: "rejected",
				startedAt: SINCE + 3,
				httpStatus: 400,
				errorType: "invalid_request_error",
				errorMessage: "sdk_bridge_prompt_refused",
				clientHarness: "codex",
				model: "claude-opus-5-5",
			},
		]);
	});
});

describe("health read query plans", () => {
	class RecordingAdapter extends BunSqlAdapter {
		readonly sent: Array<{ sql: string; params: unknown[] }> = [];

		override async query<R>(sql: string, params: unknown[] = []): Promise<R[]> {
			this.sent.push({ sql, params });
			return super.query<R>(sql, params);
		}

		override async get<R>(
			sql: string,
			params: unknown[] = [],
		): Promise<R | null> {
			this.sent.push({ sql, params });
			return super.get<R>(sql, params);
		}
	}

	async function planFor(
		call: (repo: SdkBridgeTurnRepository) => Promise<unknown>,
	): Promise<string[]> {
		const recorder = new RecordingAdapter(db);
		await call(new SdkBridgeTurnRepository(recorder));
		const sent = recorder.sent[0];
		if (!sent) throw new Error("the repository sent no query");
		const plan = db
			.query(`EXPLAIN QUERY PLAN ${sent.sql}`)
			.all(...(sent.params as Array<string | number | null>)) as Array<{
			detail: string;
		}>;
		return plan.map((step) => step.detail);
	}

	/**
	 * Statistics of a large live database: many requests, few of them inner
	 * calls, few turns. On such numbers an unpinned join may drive from the
	 * partial requests index and probe every turn ever retained.
	 */
	function skewStatistics(): void {
		db.exec("ANALYZE");
		db.run(
			"DELETE FROM sqlite_stat1 WHERE tbl IN ('requests', 'sdk_bridge_turns')",
		);
		db.run(
			`INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES
				('requests', NULL, '740000'),
				('requests', 'idx_requests_sdk_bridge_turn', '900 3'),
				('requests', 'idx_requests_timestamp', '740000 1'),
				('sdk_bridge_turns', NULL, '40000'),
				('sdk_bridge_turns', 'idx_sdk_bridge_turns_started', '40000 1')`,
		);
		db.exec("ANALYZE sqlite_schema");
	}

	const reads: Array<
		[string, (r: SdkBridgeTurnRepository) => Promise<unknown>]
	> = [
		["countHealthGroups", (r) => r.countHealthGroups(SINCE)],
		["countHealthErrors", (r) => r.countHealthErrors(SINCE, ["failed"])],
		["healthPercentiles", (r) => r.healthPercentiles(SINCE, "spawn_ms")],
		["sumHealthInnerUsage", (r) => r.sumHealthInnerUsage(SINCE)],
		["listHealthFailures", (r) => r.listHealthFailures(SINCE, ["failed"], 20)],
	];

	for (const [name, call] of reads) {
		it(`${name} reads turns through the started_at index`, async () => {
			skewStatistics();
			const details = await planFor(call);
			expect(
				details.some((d) => d.includes("idx_sdk_bridge_turns_started")),
			).toBe(true);
			expect(
				details.filter((d) => /^SCAN (t|sdk_bridge_turns)\b(?! USING)/.test(d)),
			).toEqual([]);
		});
	}

	it("sumHealthInnerUsage probes requests through the partial turn index", async () => {
		skewStatistics();
		const details = await planFor((r) => r.sumHealthInnerUsage(SINCE));
		expect(details[0]).toContain("idx_sdk_bridge_turns_started");
		expect(
			details.some(
				(d) =>
					d.startsWith("SEARCH r") &&
					d.includes("idx_requests_sdk_bridge_turn"),
			),
		).toBe(true);
		expect(details.filter((d) => d.startsWith("SCAN r"))).toEqual([]);
	});
});
