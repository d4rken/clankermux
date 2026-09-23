import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	BunSqlAdapter,
	type DatabaseOperations,
	ensureSchema,
	RequestRepository,
	SdkBridgeTurnRepository,
} from "@clankermux/database";
import type { SdkBridgeTurnView } from "@clankermux/types";
import { createSdkBridgeTurnHandler } from "../sdk-bridge-turns";

let db: Database;
let turns: SdkBridgeTurnRepository;
let requests: RequestRepository;
let handler: ReturnType<typeof createSdkBridgeTurnHandler>;

beforeEach(async () => {
	db = new Database(":memory:");
	ensureSchema(db);
	db.run("PRAGMA foreign_keys = ON");
	const adapter = new BunSqlAdapter(db);
	turns = new SdkBridgeTurnRepository(adapter);
	requests = new RequestRepository(adapter);
	handler = createSdkBridgeTurnHandler({
		sdkBridgeTurns: turns,
		getAccount: async (id: string) =>
			id === "acct-a" ? { id, name: "Claude A" } : null,
	} as unknown as DatabaseOperations);
	await turns.insertTurn({
		id: "turn-1",
		startedAt: 1_000,
		historyMode: "rebuild_transcript",
		rebuildReason: "edit",
		systemPromptPolicy: "drop",
		accountId: "acct-a",
		ignoredFields: ["temperature"],
	});
	await turns.insertLeg({
		id: "leg-1",
		turnId: "turn-1",
		kind: "start",
		startedAt: 1_000,
	});
});

afterEach(() => db.close());

async function inner(id: string): Promise<void> {
	await requests.save({
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
		usage: { model: "claude-opus-5-5", inputTokens: 10, costUsd: 0.5 },
	});
}

describe("GET /api/sdk-bridge-turns/:id", () => {
	it("returns the turn, its legs and its inner calls", async () => {
		await inner("inner-1");
		await turns.bumpTurnCounters("turn-1", { innerCalls: 1 });

		const res = await handler("turn-1");
		expect(res.status).toBe(200);
		const view = (await res.json()) as SdkBridgeTurnView;
		expect(view.turn).toMatchObject({
			id: "turn-1",
			historyMode: "rebuild_transcript",
			rebuildReason: "edit",
			systemPromptPolicy: "drop",
			ignoredFields: ["temperature"],
		});
		expect(view.accountName).toBe("Claude A");
		expect(view.legs.map((l) => l.id)).toEqual(["leg-1"]);
		expect(view.innerRequests.map((r) => r.id)).toEqual(["inner-1"]);
		expect(view.inner.requestCount).toBe(1);
		expect(view.prunedInnerCalls).toBe(0);
		expect(view.matchedLegId).toBeNull();
	});

	it("resolves a leg id, which has no requests row, to its turn", async () => {
		const view = (await (await handler("leg-1")).json()) as SdkBridgeTurnView;
		expect(view.turn.id).toBe("turn-1");
		expect(view.matchedLegId).toBe("leg-1");
	});

	it("reports inner calls whose rows were pruned", async () => {
		await inner("inner-1");
		await turns.bumpTurnCounters("turn-1", { innerCalls: 3 });
		db.run("DELETE FROM requests");

		const view = (await (await handler("turn-1")).json()) as SdkBridgeTurnView;
		expect(view.innerRequests).toEqual([]);
		expect(view.prunedInnerCalls).toBe(3);
	});

	it("answers 404 for an unknown id", async () => {
		expect((await handler("nope")).status).toBe(404);
	});
});
