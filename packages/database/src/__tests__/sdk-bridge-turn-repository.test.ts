/**
 * Tests for SdkBridgeTurnRepository and `requests.sdk_bridge_turn_id`.
 *
 * Ownership: legs cascade from their turn; inner `requests` rows are linked by
 * a plain column, so either side can be deleted first without the other
 * failing.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema } from "../migrations";
import {
	type RequestData,
	RequestRepository,
} from "../repositories/request.repository";
import { SdkBridgeTurnRepository } from "../repositories/sdk-bridge-turn.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	db.run("PRAGMA foreign_keys = ON");
	return db;
}

function innerRequest(
	id: string,
	overrides: Partial<RequestData> = {},
): RequestData {
	return {
		id,
		method: "POST",
		path: "/v1/messages",
		accountUsed: "acct-a",
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTime: 900,
		failoverAttempts: 0,
		projectAttributionSource: null,
		sdkBridgeTurnId: "turn-1",
		...overrides,
	};
}

function turnIdOf(db: Database, id: string): string | null | undefined {
	const row = db
		.query("SELECT sdk_bridge_turn_id FROM requests WHERE id = ?")
		.get(id) as { sdk_bridge_turn_id: string | null } | null;
	return row?.sdk_bridge_turn_id;
}

describe("SdkBridgeTurnRepository", () => {
	let db: Database;
	let repo: SdkBridgeTurnRepository;
	let requests: RequestRepository;

	beforeEach(() => {
		db = makeDb();
		const adapter = new BunSqlAdapter(db);
		repo = new SdkBridgeTurnRepository(adapter);
		requests = new RequestRepository(adapter);
	});

	afterEach(() => {
		db.close();
	});

	async function insertTurn(id = "turn-1"): Promise<void> {
		await repo.insertTurn({
			id,
			startedAt: 1_000,
			historyMode: "fresh",
			systemPromptPolicy: "drop",
			apiKeyId: "key-1",
			apiKeyName: "pi",
			accountId: "acct-a",
			model: "claude-opus-5-5",
			clientHarness: "pi",
			project: "clankermux",
		});
	}

	it("inserts a running turn with zeroed counters", async () => {
		await insertTurn();
		const detail = await repo.getTurnWithLegs("turn-1");
		expect(detail).not.toBeNull();
		expect(detail?.turn).toMatchObject({
			id: "turn-1",
			startedAt: 1_000,
			finishedAt: null,
			status: "running",
			historyMode: "fresh",
			systemPromptPolicy: "drop",
			apiKeyId: "key-1",
			accountId: "acct-a",
			legCount: 0,
			toolRoundCount: 0,
			innerCallCount: 0,
			innerErrorCount: 0,
			sdkInputTokens: null,
			ignoredFields: null,
		});
		expect(detail?.legs).toEqual([]);
	});

	it("stores the fields a turn ignored as a JSON array", async () => {
		await repo.insertTurn({
			id: "turn-2",
			startedAt: 1_000,
			historyMode: "fresh",
			systemPromptPolicy: "drop",
			ignoredFields: ["temperature", "top_p"],
		});
		expect((await repo.getTurnWithLegs("turn-2"))?.turn.ignoredFields).toEqual([
			"temperature",
			"top_p",
		]);
		expect(
			db
				.query("SELECT ignored_fields FROM sdk_bridge_turns WHERE id = ?")
				.get("turn-2"),
		).toEqual({ ignored_fields: '["temperature","top_p"]' });
	});

	it("returns null for an unknown turn", async () => {
		expect(await repo.getTurnWithLegs("missing")).toBeNull();
	});

	it("finishes a turn with status, timings, error and SDK cross-check", async () => {
		await insertTurn();
		await repo.finishTurn("turn-1", {
			finishedAt: 5_000,
			status: "failed",
			httpStatus: 429,
			errorType: "rate_limit_error",
			errorMessage: "all accounts cooling",
			stopReason: null,
			ccSessionId: "sess-9",
			spawnMs: 120,
			firstEventMs: 800,
			durationMs: 4_000,
			sdkNumTurns: 2,
			sdkInputTokens: 10,
			sdkOutputTokens: 0,
			sdkCacheReadInputTokens: 3_000,
			sdkCacheCreationInputTokens: 0,
		});
		const turn = (await repo.getTurnWithLegs("turn-1"))?.turn;
		expect(turn).toMatchObject({
			finishedAt: 5_000,
			status: "failed",
			httpStatus: 429,
			errorType: "rate_limit_error",
			errorMessage: "all accounts cooling",
			ccSessionId: "sess-9",
			spawnMs: 120,
			firstEventMs: 800,
			durationMs: 4_000,
			sdkNumTurns: 2,
			sdkInputTokens: 10,
			// A reported zero stays a zero, distinct from "no reading".
			sdkOutputTokens: 0,
			sdkCacheReadInputTokens: 3_000,
			sdkCacheCreationInputTokens: 0,
		});
	});

	it("finishTurn keeps a session id learned earlier when the finish carries none", async () => {
		await repo.insertTurn({
			id: "turn-1",
			startedAt: 1_000,
			historyMode: "resume",
			systemPromptPolicy: "drop",
			ccSessionId: "sess-1",
		});
		await repo.finishTurn("turn-1", { finishedAt: 2_000, status: "completed" });
		const turn = (await repo.getTurnWithLegs("turn-1"))?.turn;
		expect(turn?.ccSessionId).toBe("sess-1");
		expect(turn?.status).toBe("completed");
	});

	it("bumps counters by the given deltas, cumulatively", async () => {
		await insertTurn();
		await repo.bumpTurnCounters("turn-1", { innerCalls: 1 });
		await repo.bumpTurnCounters("turn-1", {
			innerCalls: 2,
			innerErrors: 1,
			toolRounds: 1,
		});
		await Promise.all([
			repo.bumpTurnCounters("turn-1", { innerCalls: 1 }),
			repo.bumpTurnCounters("turn-1", { innerCalls: 1 }),
		]);
		const turn = (await repo.getTurnWithLegs("turn-1"))?.turn;
		expect(turn?.innerCallCount).toBe(5);
		expect(turn?.innerErrorCount).toBe(1);
		expect(turn?.toolRoundCount).toBe(1);
		expect(turn?.legCount).toBe(0);
	});

	it("inserts and finishes legs, counting them on the turn", async () => {
		await insertTurn();
		await repo.insertLeg({
			id: "leg-1",
			turnId: "turn-1",
			kind: "start",
			startedAt: 1_000,
		});
		await repo.finishLeg("leg-1", {
			finishedAt: 2_000,
			httpStatus: 200,
			stopReason: "tool_use",
			toolUseIds: ["toolu_a", "toolu_b"],
		});
		await repo.insertLeg({
			id: "leg-2",
			turnId: "turn-1",
			kind: "continue",
			startedAt: 3_000,
		});
		await repo.finishLeg("leg-2", {
			finishedAt: 3_500,
			httpStatus: 200,
			errorPhase: "mid_stream",
			errorType: "api_error",
			errorMessage: "client disconnected",
		});

		const detail = await repo.getTurnWithLegs("turn-1");
		expect(detail?.turn.legCount).toBe(2);
		expect(detail?.legs).toEqual([
			{
				id: "leg-1",
				turnId: "turn-1",
				kind: "start",
				startedAt: 1_000,
				finishedAt: 2_000,
				httpStatus: 200,
				errorPhase: null,
				stopReason: "tool_use",
				errorType: null,
				errorMessage: null,
				toolUseIds: ["toolu_a", "toolu_b"],
			},
			{
				id: "leg-2",
				turnId: "turn-1",
				kind: "continue",
				startedAt: 3_000,
				finishedAt: 3_500,
				httpStatus: 200,
				errorPhase: "mid_stream",
				stopReason: null,
				errorType: "api_error",
				errorMessage: "client disconnected",
				toolUseIds: null,
			},
		]);
	});

	it("rejects a leg whose turn does not exist", async () => {
		await expect(
			repo.insertLeg({
				id: "leg-x",
				turnId: "missing",
				kind: "start",
				startedAt: 1,
			}),
		).rejects.toThrow();
		expect(
			db.query("SELECT COUNT(*) AS n FROM sdk_bridge_turn_legs").get(),
		).toEqual({ n: 0 });
	});

	it("deleting a turn cascades to its legs", async () => {
		await insertTurn();
		await repo.insertLeg({
			id: "leg-1",
			turnId: "turn-1",
			kind: "start",
			startedAt: 1_000,
		});
		db.run("DELETE FROM sdk_bridge_turns WHERE id = 'turn-1'");
		expect(
			db.query("SELECT COUNT(*) AS n FROM sdk_bridge_turn_legs").get(),
		).toEqual({ n: 0 });
	});

	it("sums the inner requests rows at read time", async () => {
		await insertTurn();
		await requests.save(
			innerRequest("inner-1", {
				usage: {
					model: "claude-opus-5-5",
					inputTokens: 10,
					outputTokens: 200,
					cacheReadInputTokens: 30_000,
					cacheCreationInputTokens: 1_000,
					costUsd: 0.5,
				},
			}),
		);
		await requests.save(
			innerRequest("inner-2", {
				usage: {
					model: "claude-opus-5-5",
					inputTokens: 5,
					outputTokens: 50,
					cacheReadInputTokens: 31_000,
					cacheCreationInputTokens: 0,
					costUsd: 0.25,
				},
			}),
		);
		// Another turn's row and an unlinked row stay out of the sum.
		await requests.save(
			innerRequest("other-turn", {
				sdkBridgeTurnId: "turn-2",
				usage: { inputTokens: 999, costUsd: 9 },
			}),
		);
		await requests.save(
			innerRequest("unlinked", {
				sdkBridgeTurnId: null,
				usage: { inputTokens: 999, costUsd: 9 },
			}),
		);

		const inner = (await repo.getTurnWithLegs("turn-1"))?.inner;
		expect(inner).toEqual({
			requestCount: 2,
			inputTokens: 15,
			outputTokens: 250,
			cacheReadInputTokens: 61_000,
			cacheCreationInputTokens: 1_000,
			costUsd: 0.75,
		});
	});

	it("lists the inner rows that still exist, with the account's name", async () => {
		await insertTurn();
		db.run(
			"INSERT INTO accounts (id, name, provider, created_at) VALUES ('acct-a', 'Claude A', 'anthropic', 0)",
		);
		await requests.save(
			innerRequest("inner-1", {
				usage: {
					model: "claude-opus-5-5",
					inputTokens: 10,
					outputTokens: 200,
					costUsd: 0.5,
				},
			}),
		);
		await requests.save(
			innerRequest("inner-2", {
				accountUsed: "gone",
				statusCode: 429,
				success: false,
			}),
		);
		await requests.save(innerRequest("other", { sdkBridgeTurnId: "turn-2" }));

		const rows = await repo.listInnerRequests("turn-1", 10);
		expect(rows.map((r) => r.id)).toEqual(["inner-1", "inner-2"]);
		expect(rows[0]).toMatchObject({
			accountId: "acct-a",
			accountName: "Claude A",
			model: "claude-opus-5-5",
			statusCode: 200,
			success: true,
			inputTokens: 10,
			outputTokens: 200,
			costUsd: 0.5,
		});
		expect(rows[1]).toMatchObject({
			accountId: "gone",
			accountName: null,
			statusCode: 429,
			success: false,
			inputTokens: null,
		});
		expect(await repo.listInnerRequests("turn-1", 1)).toHaveLength(1);
		db.run("DELETE FROM requests");
		expect(await repo.listInnerRequests("turn-1", 10)).toEqual([]);
	});

	it("finds a turn by one of its legs", async () => {
		await insertTurn();
		await repo.insertLeg({
			id: "leg-1",
			turnId: "turn-1",
			kind: "start",
			startedAt: 1_000,
		});
		expect(await repo.findTurnIdByLeg("leg-1")).toBe("turn-1");
		expect(await repo.findTurnIdByLeg("turn-1")).toBeNull();
	});

	it("reports zero inner rows when they were already pruned", async () => {
		await insertTurn();
		await repo.bumpTurnCounters("turn-1", { innerCalls: 2 });
		await requests.save(innerRequest("inner-1", { usage: { inputTokens: 1 } }));
		db.run("DELETE FROM requests");

		const detail = await repo.getTurnWithLegs("turn-1");
		expect(detail?.turn.innerCallCount).toBe(2);
		expect(detail?.inner).toEqual({
			requestCount: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			costUsd: 0,
		});
	});
});

describe("requests.sdk_bridge_turn_id", () => {
	let db: Database;
	let requests: RequestRepository;
	let turns: SdkBridgeTurnRepository;

	beforeEach(() => {
		db = makeDb();
		const adapter = new BunSqlAdapter(db);
		requests = new RequestRepository(adapter);
		turns = new SdkBridgeTurnRepository(adapter);
	});

	afterEach(() => {
		db.close();
	});

	it("is written on insert and NULL when absent", async () => {
		await requests.save(innerRequest("inner-1"));
		await requests.save(innerRequest("plain", { sdkBridgeTurnId: undefined }));
		expect(turnIdOf(db, "inner-1")).toBe("turn-1");
		expect(turnIdOf(db, "plain")).toBeNull();
	});

	it("survives a later re-upsert that does not carry it", async () => {
		await requests.save(innerRequest("inner-1"));
		await requests.save(
			innerRequest("inner-1", {
				sdkBridgeTurnId: undefined,
				usage: { inputTokens: 7 },
			}),
		);
		expect(turnIdOf(db, "inner-1")).toBe("turn-1");
	});

	it("accepts a late usage write after its turn was deleted", async () => {
		await turns.insertTurn({
			id: "turn-1",
			startedAt: 1_000,
			historyMode: "fresh",
			systemPromptPolicy: "drop",
		});
		await requests.save(innerRequest("inner-1"));
		db.run("DELETE FROM sdk_bridge_turns WHERE id = 'turn-1'");

		// The recorder's two late-usage seams: the re-upsert and the patch.
		await requests.save(
			innerRequest("inner-1", { usage: { inputTokens: 7, outputTokens: 3 } }),
		);
		await requests.updateUsage("inner-1", { outputTokens: 4 });
		// A first write naming a turn that is already gone is accepted too.
		await requests.save(innerRequest("inner-2"));

		const row = db
			.query(
				"SELECT sdk_bridge_turn_id, input_tokens, output_tokens FROM requests WHERE id = 'inner-1'",
			)
			.get();
		expect(row).toEqual({
			sdk_bridge_turn_id: "turn-1",
			input_tokens: 7,
			output_tokens: 4,
		});
		expect(turnIdOf(db, "inner-2")).toBe("turn-1");
	});
});
