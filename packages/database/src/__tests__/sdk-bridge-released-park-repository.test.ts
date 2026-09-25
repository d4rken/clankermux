/**
 * SdkBridgeReleasedParkRepository: the durable record of a released park and
 * its state transitions. Every transition is conditional on the state it
 * leaves, reports whether it applied, and throws on a database failure
 * instead of swallowing it.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { SdkBridgeReleasedParkInsert } from "@clankermux/types";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema } from "../migrations";
import { SdkBridgeReleasedParkRepository } from "../repositories/sdk-bridge-released-park.repository";
import { SdkBridgeTurnRepository } from "../repositories/sdk-bridge-turn.repository";

let db: Database;
let parks: SdkBridgeReleasedParkRepository;
let turns: SdkBridgeTurnRepository;

beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	db.run("PRAGMA foreign_keys = ON");
	const adapter = new BunSqlAdapter(db);
	parks = new SdkBridgeReleasedParkRepository(adapter);
	turns = new SdkBridgeTurnRepository(adapter);
});

afterEach(() => db.close());

function park(
	overrides: Partial<SdkBridgeReleasedParkInsert> = {},
): SdkBridgeReleasedParkInsert {
	return {
		turnId: "turn-1",
		ownerApiKeyId: "key-1",
		conversationKeyHash: "conv-1",
		sessionId: "00000000-0000-4000-8000-000000000001",
		sessionFile: "turn-1.jsonl",
		resumeAt: "00000000-0000-4000-8000-0000000000aa",
		awaitedToolUseIds: ["toolu_1", "toolu_2"],
		requestedModel: "claude-sonnet-5",
		descriptor: JSON.stringify({ v: 1 }),
		activeMs: 1234,
		parkedSince: 1_000,
		expiresAt: 90_000,
		fileBytes: 0,
		createdAt: 1_000,
		...overrides,
	};
}

async function insertTurn(id = "turn-1") {
	await turns.insertTurn({
		id,
		startedAt: 500,
		historyMode: "fresh",
		systemPromptPolicy: "drop",
	});
}

const statusOf = (id = "turn-1") =>
	(
		db.query("SELECT status FROM sdk_bridge_turns WHERE id = ?").get(id) as {
			status: string;
		} | null
	)?.status;

describe("SdkBridgeReleasedParkRepository", () => {
	it("walks preparing, released, claimed and consumed, keeping the turn's status in step", async () => {
		await insertTurn();
		await parks.insertPreparing(park());
		expect((await parks.find("turn-1"))?.state).toBe("preparing");
		expect(statusOf()).toBe("running");

		expect(
			await parks.markReleased("turn-1", {
				sessionFile: "turn-1.jsonl",
				fileBytes: 4096,
			}),
		).toBe(true);
		expect(statusOf()).toBe("released");
		expect(await parks.find("turn-1")).toMatchObject({
			state: "released",
			fileBytes: 4096,
			awaitedToolUseIds: ["toolu_1", "toolu_2"],
			descriptor: JSON.stringify({ v: 1 }),
			activeMs: 1234,
		});

		expect(await parks.claim("turn-1", "owner-a", 2_000)).toBe(true);
		// A second claimant finds it taken.
		expect(await parks.claim("turn-1", "owner-b", 2_001)).toBe(false);
		expect(statusOf()).toBe("running");
		expect(await parks.find("turn-1")).toMatchObject({
			state: "claimed",
			claimOwner: "owner-a",
			claimedAt: 2_000,
		});

		// Only the claim's owner consumes it.
		expect(await parks.markConsumed("turn-1", "owner-b")).toBe(false);
		expect(await parks.markConsumed("turn-1", "owner-a")).toBe(true);
		expect((await parks.find("turn-1"))?.state).toBe("consumed");
		// A consumed park is never released again.
		expect(await parks.unclaim("turn-1", "owner-a")).toBe(false);
	});

	it("gives a claim back to released, the turn's status with it", async () => {
		await insertTurn();
		await parks.insertPreparing(park());
		await parks.markReleased("turn-1", { sessionFile: "f", fileBytes: 1 });
		await parks.claim("turn-1", "owner-a", 2_000);
		expect(await parks.unclaim("turn-1", "owner-b")).toBe(false);
		expect(await parks.unclaim("turn-1", "owner-a")).toBe(true);
		expect(statusOf()).toBe("released");
		expect(await parks.find("turn-1")).toMatchObject({
			state: "released",
			claimOwner: null,
			claimedAt: null,
		});
		// Recovery takes back any owner's stale claim.
		await parks.claim("turn-1", "dead-owner", 2_000);
		expect(await parks.unclaim("turn-1", null)).toBe(true);
	});

	it("releases only a preparing record", async () => {
		await insertTurn();
		await parks.insertPreparing(park());
		await parks.markReleased("turn-1", { sessionFile: "f", fileBytes: 1 });
		expect(
			await parks.markReleased("turn-1", { sessionFile: "f", fileBytes: 1 }),
		).toBe(false);
		expect(
			await parks.markReleased("nope", { sessionFile: "f", fileBytes: 1 }),
		).toBe(false);
	});

	it("neither releases nor claims a park whose turn has finished", async () => {
		await insertTurn();
		await parks.insertPreparing(park());
		await turns.finishTurn("turn-1", { finishedAt: 700, status: "failed" });
		expect(
			await parks.markReleased("turn-1", { sessionFile: "f", fileBytes: 1 }),
		).toBe(false);
		expect(statusOf()).toBe("failed");
		db.run(
			"UPDATE sdk_bridge_released_parks SET state = 'released' WHERE turn_id = 'turn-1'",
		);
		expect(await parks.claim("turn-1", "owner-a", 2_000)).toBe(false);
		expect(statusOf()).toBe("failed");
	});

	it("closes the turn and deletes its park in one step", async () => {
		await insertTurn();
		await parks.insertPreparing(park());
		await parks.closeTurn("turn-1", {
			finishedAt: 5_000,
			status: "timed_out",
			httpStatus: 504,
			errorType: "timeout_error",
			errorMessage: "expired",
			durationMs: 4_500,
		});
		expect(await parks.find("turn-1")).toBeNull();
		expect(
			db
				.query(
					"SELECT status, finished_at, error_message FROM sdk_bridge_turns WHERE id = 'turn-1'",
				)
				.get(),
		).toEqual({
			status: "timed_out",
			finished_at: 5_000,
			error_message: "expired",
		});
	});

	it("closing never overwrites a turn that already finished, and still deletes the park", async () => {
		await insertTurn();
		await turns.finishTurn("turn-1", { finishedAt: 600, status: "completed" });
		await parks.insertPreparing(park());
		await parks.closeTurn("turn-1", {
			finishedAt: 9_000,
			status: "failed",
			errorMessage: "late",
		});
		expect(await parks.find("turn-1")).toBeNull();
		expect(statusOf()).toBe("completed");
	});

	it("reads a row whose awaited ids are not a JSON list of strings as awaiting nothing", async () => {
		await parks.insertPreparing(park());
		await parks.insertPreparing(park({ turnId: "turn-2", sessionFile: "t2" }));
		db.run(
			"UPDATE sdk_bridge_released_parks SET awaited_tool_use_ids = '{not json' WHERE turn_id = 'turn-1'",
		);
		db.run(
			`UPDATE sdk_bridge_released_parks SET awaited_tool_use_ids = '[1, null]' WHERE turn_id = 'turn-2'`,
		);
		const listed = await parks.list();
		expect(listed.map((p) => p.awaitedToolUseIds)).toEqual([[], []]);
	});

	it("lists every park and deletes one", async () => {
		await parks.insertPreparing(park());
		await parks.insertPreparing(park({ turnId: "turn-2", sessionFile: "t2" }));
		expect((await parks.list()).map((p) => p.turnId).sort()).toEqual([
			"turn-1",
			"turn-2",
		]);
		await parks.delete("turn-1");
		expect((await parks.list()).map((p) => p.turnId)).toEqual(["turn-2"]);
	});

	it("throws instead of swallowing a failed write", async () => {
		await parks.insertPreparing(park());
		await expect(parks.insertPreparing(park())).rejects.toThrow();
		db.run("DROP TABLE sdk_bridge_released_parks");
		await expect(parks.claim("turn-1", "o", 1)).rejects.toThrow();
	});

	it("closes open turns no park owns, and only those", async () => {
		await insertTurn("orphan");
		await insertTurn("parked");
		await insertTurn("done");
		await turns.finishTurn("done", { finishedAt: 600, status: "completed" });
		await insertTurn("fresh");
		db.run("UPDATE sdk_bridge_turns SET started_at = 9_000 WHERE id = 'fresh'");
		await parks.insertPreparing(park({ turnId: "parked" }));
		await parks.markReleased("parked", { sessionFile: "f", fileBytes: 1 });

		const closed = await parks.closeOpenTurnsWithoutPark(5_000, {
			finishedAt: 7_000,
			status: "failed",
			errorType: "api_error",
			errorMessage: "The bridge process ended",
		});
		expect(closed).toBe(1);
		expect(statusOf("orphan")).toBe("failed");
		expect(statusOf("parked")).toBe("released");
		expect(statusOf("done")).toBe("completed");
		expect(statusOf("fresh")).toBe("running");
	});
});

describe("the released-park lease", () => {
	const lease = (dir: string, token: string, pid = 100) => ({
		dir,
		pid,
		startTime: "1",
		token,
		at: 1_000,
	});
	const nobodyDead = () => false;
	const everyoneDead = () => true;

	it("goes to the first taker, to anyone on the same directory, and to anyone once its holder is dead", async () => {
		expect(
			await parks.acquireLease(lease("/root-a/ns", "t1"), nobodyDead),
		).toBe(true);
		// Its own token: still held.
		expect(
			await parks.acquireLease(lease("/root-a/ns", "t1"), nobodyDead),
		).toBe(true);
		// Another directory while the holder lives: refused.
		expect(
			await parks.acquireLease(lease("/root-b/ns", "t2"), nobodyDead),
		).toBe(false);
		// The same directory: its directory lock already decided.
		expect(
			await parks.acquireLease(lease("/root-a/ns", "t3"), nobodyDead),
		).toBe(true);
		// A dead holder's lease is taken over from anywhere.
		expect(
			await parks.acquireLease(lease("/root-b/ns", "t4", 200), everyoneDead),
		).toBe(true);
		expect(await parks.holdsLease("t4")).toBe(true);
		expect(await parks.holdsLease("t3")).toBe(false);
	});

	it("is given up only by its holder", async () => {
		await parks.acquireLease(lease("/root-a/ns", "t1"), nobodyDead);
		await parks.releaseLease("other");
		expect(await parks.holdsLease("t1")).toBe(true);
		await parks.releaseLease("t1");
		expect(await parks.holdsLease("t1")).toBe(false);
		expect(
			await parks.acquireLease(lease("/root-b/ns", "t2"), nobodyDead),
		).toBe(true);
	});
});
