/**
 * SdkBridgeReleasedParkRepository: the durable record of a released park,
 * its state transitions and the lease that fences them. Every write names
 * the lease token it acts under and applies only while that token holds the
 * lease (0 changes otherwise: a failed transition), and every transition
 * names the state it leaves. Database failures throw.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	SDK_BRIDGE_LEG_OWNER_LOST,
	type SdkBridgeParkLease,
	type SdkBridgeReleasedParkInsert,
} from "@clankermux/types";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema } from "../migrations";
import { RequestRepository } from "../repositories/request.repository";
import { SdkBridgeReleasedParkRepository } from "../repositories/sdk-bridge-released-park.repository";
import { SdkBridgeTurnRepository } from "../repositories/sdk-bridge-turn.repository";

let db: Database;
let parks: SdkBridgeReleasedParkRepository;
let turns: SdkBridgeTurnRepository;

const T = "token-a";
const lease = (token = T, pid = 100): SdkBridgeParkLease => ({
	dir: `/root/released-parks/ns`,
	pid,
	startTime: "1",
	token,
	at: 1_000,
});
const nobodyDead = () => false;
const everyoneDead = () => true;
const owner = { pid: 4242, startTime: "77" };
/** A release that settles nothing it would not anyway: no legs exist. */
const NO_SETTLE = { at: 0, legIds: [] };

beforeEach(async () => {
	db = new Database(":memory:");
	ensureSchema(db);
	db.run("PRAGMA foreign_keys = ON");
	const adapter = new BunSqlAdapter(db);
	parks = new SdkBridgeReleasedParkRepository(adapter);
	turns = new SdkBridgeTurnRepository(adapter);
	await parks.acquireLease(lease(), nobodyDead);
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
		sessionPath:
			"/root/released-parks/ns/00000000-0000-4000-8000-000000000001.jsonl",
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

async function insertTurn(id = "turn-1", startedAt = 500) {
	await turns.insertTurn({
		id,
		startedAt,
		historyMode: "fresh",
		systemPromptPolicy: "drop",
		ownerPid: 99,
		ownerStartTime: "5",
	});
}

const turnOf = (id = "turn-1") =>
	db
		.query(
			"SELECT status, owner_pid, owner_start_time FROM sdk_bridge_turns WHERE id = ?",
		)
		.get(id) as {
		status: string;
		owner_pid: number | null;
		owner_start_time: string | null;
	} | null;
const statusOf = (id = "turn-1") => turnOf(id)?.status;
const turnOutcome = (id: string) =>
	db
		.query(
			"SELECT status, finished_at, error_message FROM sdk_bridge_turns WHERE id = ?",
		)
		.get(id);
const legRow = (id: string) =>
	db
		.query(
			`SELECT finished_at, http_status, error_phase, error_type, error_message,
				settled_at FROM sdk_bridge_turn_legs WHERE id = ?`,
		)
		.get(id) as {
		finished_at: number | null;
		http_status: number | null;
		error_phase: string | null;
		error_type: string | null;
		error_message: string | null;
		settled_at: number | null;
	} | null;

async function released(id = "turn-1") {
	await parks.insertPreparing(park({ turnId: id }), T);
	await parks.markReleased(
		id,
		{ sessionPath: park().sessionPath, fileBytes: 1 },
		T,
		NO_SETTLE,
	);
}

describe("SdkBridgeReleasedParkRepository", () => {
	it("walks preparing, released, claimed and consumed, keeping the turn in step", async () => {
		await insertTurn();
		expect(turnOf()).toMatchObject({ owner_pid: 99, owner_start_time: "5" });
		expect(await parks.insertPreparing(park(), T)).toBe(true);
		expect((await parks.find("turn-1"))?.state).toBe("preparing");

		expect(
			await parks.markReleased(
				"turn-1",
				{ sessionPath: park().sessionPath, fileBytes: 4096 },
				T,
				NO_SETTLE,
			),
		).toBe(true);
		expect(statusOf()).toBe("released");
		expect(await parks.find("turn-1")).toMatchObject({
			state: "released",
			sessionPath: park().sessionPath,
			fileBytes: 4096,
			awaitedToolUseIds: ["toolu_1", "toolu_2"],
		});

		expect(await parks.claim("turn-1", T, "c1", 2_000, owner)).toBe(true);
		// Claimed: a second claim finds it taken.
		expect(await parks.claim("turn-1", T, "c2", 2_001, owner)).toBe(false);
		// The claimant owns the turn now.
		expect(turnOf()).toMatchObject({
			status: "running",
			owner_pid: 4242,
			owner_start_time: "77",
		});
		expect(await parks.markConsumed("turn-1", T, "c2")).toBe(false);
		expect(await parks.markConsumed("turn-1", T, "c1")).toBe(true);
		expect((await parks.find("turn-1"))?.state).toBe("consumed");
		expect(await parks.unclaim("turn-1", T, { claimId: "c1" })).toBe(false);
	});

	it("gives a claim back, and recovery takes back any claimant's", async () => {
		await insertTurn();
		await released();
		await parks.claim("turn-1", T, "c1", 2_000, owner);
		expect(await parks.unclaim("turn-1", T, { claimId: "c1" })).toBe(true);
		expect(statusOf()).toBe("released");
		expect(await parks.find("turn-1")).toMatchObject({
			state: "released",
			claimOwner: null,
			claimedAt: null,
		});
		await parks.claim("turn-1", T, "c2", 2_000, owner);
		db.run(
			"UPDATE sdk_bridge_released_parks SET claim_owner = 'dead', claim_id = 'd1' WHERE turn_id = 'turn-1'",
		);
		expect(await parks.unclaim("turn-1", T, { claimId: "c2" })).toBe(false);
		expect(await parks.unclaim("turn-1", T, { anyClaimant: true })).toBe(true);
	});

	it("neither releases nor claims a park whose turn has finished", async () => {
		await insertTurn();
		await parks.insertPreparing(park(), T);
		await turns.finishTurn("turn-1", { finishedAt: 700, status: "failed" });
		expect(
			await parks.markReleased(
				"turn-1",
				{ sessionPath: "p", fileBytes: 1 },
				T,
				NO_SETTLE,
			),
		).toBe(false);
		db.run(
			"UPDATE sdk_bridge_released_parks SET state = 'released' WHERE turn_id = 'turn-1'",
		);
		expect(await parks.claim("turn-1", T, "c1", 2_000, owner)).toBe(false);
		expect(statusOf()).toBe("failed");
	});

	it("closes the turn and deletes its park in one step, never overwriting a finished turn", async () => {
		await insertTurn();
		await parks.insertPreparing(park(), T);
		expect(
			await parks.closeTurn(
				"turn-1",
				{ finishedAt: 5_000, status: "timed_out", errorMessage: "expired" },
				T,
			),
		).toBe("closed");
		expect(await parks.find("turn-1")).toBeNull();
		expect(statusOf()).toBe("timed_out");

		await insertTurn("turn-2");
		await turns.finishTurn("turn-2", { finishedAt: 600, status: "completed" });
		await parks.insertPreparing(park({ turnId: "turn-2" }), T);
		expect(
			await parks.closeTurn(
				"turn-2",
				{ finishedAt: 9_000, status: "failed" },
				T,
			),
		).toBe("kept");
		expect(await parks.find("turn-2")).toBeNull();
		expect(statusOf("turn-2")).toBe("completed");
	});

	it("reads awaited ids that are not a JSON list of strings as none", async () => {
		await parks.insertPreparing(park(), T);
		await parks.insertPreparing(park({ turnId: "turn-2" }), T);
		db.run(
			"UPDATE sdk_bridge_released_parks SET awaited_tool_use_ids = '{not json' WHERE turn_id = 'turn-1'",
		);
		db.run(
			`UPDATE sdk_bridge_released_parks SET awaited_tool_use_ids = '[1, null]' WHERE turn_id = 'turn-2'`,
		);
		expect((await parks.list()).map((p) => p.awaitedToolUseIds)).toEqual([
			[],
			[],
		]);
	});

	it("throws instead of swallowing a failed write", async () => {
		await parks.insertPreparing(park(), T);
		await expect(parks.insertPreparing(park(), T)).rejects.toThrow();
		db.run("DROP TABLE sdk_bridge_released_parks");
		await expect(parks.claim("turn-1", T, "c1", 1, owner)).rejects.toThrow();
	});
});

describe("fencing by the lease", () => {
	it("refuses every write under a token that no longer holds the lease", async () => {
		await insertTurn();
		await released();
		// The lease moves to another process (this one was declared dead).
		expect(await parks.acquireLease(lease("token-b", 200), everyoneDead)).toBe(
			true,
		);
		expect(await parks.insertPreparing(park({ turnId: "turn-9" }), T)).toBe(
			false,
		);
		expect(await parks.claim("turn-1", T, "c1", 2_000, owner)).toBe(false);
		expect(await parks.unclaim("turn-1", T, { anyClaimant: true })).toBe(false);
		expect(await parks.markConsumed("turn-1", T, "c1")).toBe(false);
		expect(await parks.delete("turn-1", T)).toBe(false);
		expect(
			await parks.closeTurn("turn-1", { finishedAt: 1, status: "failed" }, T),
		).toBe("refused");
		expect(
			await parks.closeOpenTurnsWithoutPark(
				10_000,
				{ finishedAt: 1, status: "failed" },
				T,
				() => true,
			),
		).toBe(0);
		expect(await parks.find("turn-9")).toBeNull();
		expect(await parks.find("turn-1")).toMatchObject({ state: "released" });
		expect(statusOf()).toBe("released");
		// The new holder can.
		expect(await parks.claim("turn-1", "token-b", "c9", 2_000, owner)).toBe(
			true,
		);
	});

	it("refuses a late release once the lease was given up", async () => {
		await insertTurn();
		await parks.insertPreparing(park(), T);
		await parks.releaseLease(T);
		expect(
			await parks.markReleased(
				"turn-1",
				{ sessionPath: "p", fileBytes: 1 },
				T,
				NO_SETTLE,
			),
		).toBe(false);
		expect((await parks.find("turn-1"))?.state).toBe("preparing");
		expect(statusOf()).toBe("running");
	});
});

describe("the lease", () => {
	it("goes to the first taker, stays with its token, and passes only from a dead holder", async () => {
		expect(await parks.holdsLease(T)).toBe(true);
		expect(await parks.acquireLease(lease(), nobodyDead)).toBe(true);
		// Another process, even on the same directory, while the holder lives.
		expect(await parks.acquireLease(lease("token-b", 200), nobodyDead)).toBe(
			false,
		);
		expect(await parks.holdsLease(T)).toBe(true);
		expect(await parks.acquireLease(lease("token-b", 200), everyoneDead)).toBe(
			true,
		);
		expect(await parks.holdsLease(T)).toBe(false);
	});

	it("is given up only by its holder", async () => {
		await parks.releaseLease("other");
		expect(await parks.holdsLease(T)).toBe(true);
		await parks.releaseLease(T);
		expect(await parks.acquireLease(lease("token-b", 200), nobodyDead)).toBe(
			true,
		);
	});
});

describe("closing turns left open", () => {
	it("closes only open turns no park owns whose owning process is gone", async () => {
		await insertTurn("dead-owner");
		await insertTurn("live-owner");
		db.run("UPDATE sdk_bridge_turns SET owner_pid = 7 WHERE id = 'live-owner'");
		await insertTurn("legacy");
		db.run(
			"UPDATE sdk_bridge_turns SET owner_pid = NULL, owner_start_time = NULL WHERE id = 'legacy'",
		);
		await insertTurn("parked");
		await released("parked");
		await insertTurn("done");
		await turns.finishTurn("done", { finishedAt: 600, status: "completed" });
		await insertTurn("fresh", 9_000);

		const closed = await parks.closeOpenTurnsWithoutPark(
			5_000,
			{ finishedAt: 7_000, status: "failed", errorMessage: "gone" },
			T,
			(o) => o.pid !== 7,
		);
		expect(closed).toBe(2);
		expect(statusOf("dead-owner")).toBe("failed");
		expect(statusOf("legacy")).toBe("failed");
		expect(statusOf("live-owner")).toBe("running");
		expect(statusOf("parked")).toBe("released");
		expect(statusOf("done")).toBe("completed");
		expect(statusOf("fresh")).toBe("running");
	});

	it("settles the finished legs of a turn it closes, and only those", async () => {
		await insertTurn("dead-owner");
		await insertTurn("live-owner");
		db.run("UPDATE sdk_bridge_turns SET owner_pid = 7 WHERE id = 'live-owner'");
		for (const [id, turnId] of [
			["finished", "dead-owner"],
			["open", "dead-owner"],
			["settled", "dead-owner"],
			["other", "live-owner"],
		])
			await turns.insertLeg({ id, turnId, kind: "start", startedAt: 600 });
		await turns.finishLeg("finished", { finishedAt: 650 });
		await turns.finishLeg("settled", { finishedAt: 650, settled: true });
		await turns.finishLeg("other", { finishedAt: 650 });

		await parks.closeOpenTurnsWithoutPark(
			5_000,
			{ finishedAt: 7_000, status: "failed", errorMessage: "gone" },
			T,
			(o) => o.pid !== 7,
		);
		const settledAt = (id: string) =>
			(
				db
					.query("SELECT settled_at FROM sdk_bridge_turn_legs WHERE id = ?")
					.get(id) as { settled_at: number | null }
			).settled_at;
		expect(settledAt("finished")).toBe(7_000);
		expect(settledAt("settled")).toBe(650);
		// Its owner died mid-leg: finished as lost with it, then settled.
		expect(settledAt("open")).toBe(7_000);
		expect(settledAt("other")).toBeNull();
	});
});

describe("repairing the legs a dead owner left", () => {
	const KEY = "key-1";
	const DEAD = () => true;
	const ALIVE = () => false;
	const FINISH = {
		finishedAt: 7_000,
		status: "failed" as const,
		errorMessage: "gone",
	};

	async function leg(
		id: string,
		turnId: string,
		finish?: { finishedAt: number; httpStatus?: number; settled?: boolean },
	) {
		await turns.insertLeg({
			id,
			turnId,
			kind: "start",
			startedAt: 600,
			apiKeyId: KEY,
		});
		if (finish) await turns.finishLeg(id, finish);
	}

	it("settles the finished leg of a completed turn whose only missing write was the settle", async () => {
		await insertTurn("done");
		await leg("done-leg", "done", { finishedAt: 650, httpStatus: 200 });
		await turns.finishTurn("done", { finishedAt: 660, status: "completed" });

		const closed = await parks.closeOpenTurnsWithoutPark(
			5_000,
			FINISH,
			T,
			DEAD,
		);
		expect(closed).toBe(0);
		expect(legRow("done-leg")).toMatchObject({
			finished_at: 650,
			http_status: 200,
			error_type: null,
			settled_at: 7_000,
		});
		expect(statusOf("done")).toBe("completed");
	});

	it("leaves such a turn alone while its owner lives", async () => {
		await insertTurn("done");
		await leg("done-leg", "done", { finishedAt: 650, httpStatus: 200 });
		await turns.finishTurn("done", { finishedAt: 660, status: "completed" });

		await parks.closeOpenTurnsWithoutPark(5_000, FINISH, T, ALIVE);
		expect(legRow("done-leg")?.settled_at).toBeNull();
	});

	it("finishes a finished turn's open leg as lost with its owner, keeping the turn's outcome", async () => {
		await insertTurn("done");
		await leg("open-leg", "done");
		await turns.finishTurn("done", { finishedAt: 660, status: "completed" });

		expect(await parks.closeOpenTurnsWithoutPark(5_000, FINISH, T, DEAD)).toBe(
			0,
		);
		expect(legRow("open-leg")).toMatchObject({
			finished_at: 7_000,
			error_type: SDK_BRIDGE_LEG_OWNER_LOST.errorType,
			settled_at: 7_000,
		});
		expect(turnOutcome("done")).toEqual({
			status: "completed",
			finished_at: 660,
			error_message: null,
		});
	});

	it("finishes the leg its owner died in, readable with the reconstructed outcome, and keeps what earlier legs stored", async () => {
		await insertTurn("dying");
		db.run("UPDATE sdk_bridge_turns SET api_key_id = ? WHERE id = 'dying'", [
			KEY,
		]);
		await leg("earlier", "dying", {
			finishedAt: 650,
			httpStatus: 200,
			settled: true,
		});
		await leg("mid", "dying");

		expect(await parks.closeOpenTurnsWithoutPark(5_000, FINISH, T, DEAD)).toBe(
			1,
		);
		expect(legRow("earlier")).toMatchObject({
			finished_at: 650,
			http_status: 200,
			error_type: null,
			settled_at: 650,
		});
		expect(legRow("mid")).toMatchObject({
			finished_at: 7_000,
			http_status: null,
			error_phase: null,
			error_type: SDK_BRIDGE_LEG_OWNER_LOST.errorType,
			error_message: SDK_BRIDGE_LEG_OWNER_LOST.message,
			settled_at: 7_000,
		});
		const read = await new RequestRepository(
			new BunSqlAdapter(db),
		).getClientRequest(KEY, "mid", 0);
		expect(read).toMatchObject({
			source: "sdk_bridge_leg",
			status_code: null,
			error_message: SDK_BRIDGE_LEG_OWNER_LOST.message,
			leg_settled: 1,
		});
	});

	it("repairs no turn a park owns, or one started after the cutoff", async () => {
		await insertTurn("parked");
		await leg("parked-leg", "parked");
		await released("parked");
		await insertTurn("fresh", 9_000);
		await leg("fresh-leg", "fresh", { finishedAt: 9_100 });
		await turns.finishTurn("fresh", { finishedAt: 9_200, status: "completed" });

		await parks.closeOpenTurnsWithoutPark(5_000, FINISH, T, DEAD);
		expect(legRow("parked-leg")?.finished_at).toBeNull();
		expect(legRow("fresh-leg")?.settled_at).toBeNull();
	});
});

describe("settling a parked turn's legs", () => {
	const settledAt = (id: string) =>
		(
			db
				.query("SELECT settled_at FROM sdk_bridge_turn_legs WHERE id = ?")
				.get(id) as { settled_at: number | null }
		).settled_at;

	/** Legs of `turnId`: finished, open, already settled, and one excluded. */
	async function legs(turnId: string) {
		for (const id of ["finished", "open", "settled", "uncounted"])
			await turns.insertLeg({
				id: `${turnId}-${id}`,
				turnId,
				kind: "start",
				startedAt: 600,
			});
		for (const id of ["finished", "uncounted"])
			await turns.finishLeg(`${turnId}-${id}`, { finishedAt: 650 });
		await turns.finishLeg(`${turnId}-settled`, {
			finishedAt: 650,
			settled: true,
		});
	}

	it("settles, as its park is released, only the finished legs it is given", async () => {
		await insertTurn("turn-1");
		await insertTurn("other");
		await legs("turn-1");
		await legs("other");
		await parks.insertPreparing(park(), T);

		expect(
			await parks.markReleased(
				"turn-1",
				{ sessionPath: park().sessionPath, fileBytes: 1 },
				T,
				{
					at: 9_000,
					legIds: [
						"turn-1-finished",
						"turn-1-settled",
						"turn-1-open",
						"other-finished",
					],
				},
			),
		).toBe(true);
		expect(settledAt("turn-1-finished")).toBe(9_000);
		expect(settledAt("turn-1-settled")).toBe(650);
		// Not finished, another turn's, or not named: left alone.
		expect(settledAt("turn-1-open")).toBeNull();
		expect(settledAt("other-finished")).toBeNull();
		expect(settledAt("turn-1-uncounted")).toBeNull();
	});

	it("settles nothing when the release is refused", async () => {
		await insertTurn();
		await legs("turn-1");
		await parks.insertPreparing(park(), T);
		await parks.releaseLease(T);

		await parks.markReleased("turn-1", { sessionPath: "p", fileBytes: 1 }, T, {
			at: 9_000,
			legIds: ["turn-1-finished"],
		});
		expect(settledAt("turn-1-finished")).toBeNull();
	});

	it("at recovery finishes the open legs of every turn a park owns as lost with their owner, and settles its legs; no other turn's", async () => {
		await insertTurn("parked");
		await insertTurn("unparked");
		await legs("parked");
		await legs("unparked");
		await released("parked");
		// As a crash leaves them: finished, their settle never written.
		db.run(
			"UPDATE sdk_bridge_turn_legs SET settled_at = NULL WHERE id IN ('parked-finished', 'parked-uncounted')",
		);

		expect(await parks.recoverParkedTurnLegs(9_500, T)).toBe(true);
		expect(settledAt("parked-finished")).toBe(9_500);
		// A dead owner's in-memory count failures are lost with it; the row
		// count against inner_call_count still gates finality.
		expect(settledAt("parked-uncounted")).toBe(9_500);
		expect(legRow("parked-open")).toMatchObject({
			finished_at: 9_500,
			http_status: null,
			error_phase: null,
			error_type: SDK_BRIDGE_LEG_OWNER_LOST.errorType,
			error_message: SDK_BRIDGE_LEG_OWNER_LOST.message,
			settled_at: 9_500,
		});
		expect(settledAt("unparked-finished")).toBeNull();
		expect(legRow("unparked-open")?.finished_at).toBeNull();
	});

	it("settles nothing at recovery without the lease", async () => {
		await insertTurn("parked");
		await legs("parked");
		await released("parked");
		db.run(
			"UPDATE sdk_bridge_turn_legs SET settled_at = NULL WHERE id = 'parked-finished'",
		);
		await parks.releaseLease(T);

		expect(await parks.recoverParkedTurnLegs(9_500, T)).toBe(false);
		expect(settledAt("parked-finished")).toBeNull();
	});
});

describe("a shorter busy-retry budget", () => {
	it("fails fast while another connection holds the write lock", async () => {
		const path = `${require("node:os").tmpdir()}/busy-${crypto.randomUUID()}.db`;
		const main = new Database(path);
		ensureSchema(main);
		const other = new Database(path);
		other.exec("BEGIN IMMEDIATE");
		try {
			const quick = new SdkBridgeReleasedParkRepository(
				new BunSqlAdapter(main).withBusyRetryBudget(200),
			);
			const t0 = Date.now();
			await expect(quick.acquireLease(lease(), nobodyDead)).rejects.toThrow();
			expect(Date.now() - t0).toBeLessThan(2_000);
		} finally {
			other.exec("ROLLBACK");
			other.close();
			main.close();
			require("node:fs").rmSync(path, { force: true });
		}
	});
});

describe("claim generations", () => {
	it("an unclaim or consumed mark applies only to the claim it belongs to", async () => {
		await insertTurn();
		await released();
		await parks.claim("turn-1", T, "c1", 2_000, owner);
		expect(await parks.unclaim("turn-1", T, { claimId: "c1" })).toBe(true);
		await parks.claim("turn-1", T, "c2", 3_000, owner);
		// The first claim's late unclaim, and a second copy of it.
		expect(await parks.unclaim("turn-1", T, { claimId: "c1" })).toBe(false);
		expect(await parks.unclaim("turn-1", T, { claimId: "c1" })).toBe(false);
		expect(await parks.markConsumed("turn-1", T, "c1")).toBe(false);
		expect(await parks.find("turn-1")).toMatchObject({
			state: "claimed",
			claimId: "c2",
		});
		expect(statusOf()).toBe("running");
	});
});

describe("fenced turn writes", () => {
	it("a park-owned turn's writes apply only while their token holds the lease", async () => {
		await insertTurn();
		await turns.bumpTurnCounters("turn-1", { toolRounds: 1 }, T);
		await turns.insertLeg(
			{ id: "leg-1", turnId: "turn-1", kind: "continue", startedAt: 600 },
			T,
		);
		// The lease moves on; the old holder's queued writes arrive late.
		await parks.acquireLease(lease("token-b", 200), everyoneDead);
		await turns.finishTurn(
			"turn-1",
			{ finishedAt: 9_000, status: "completed" },
			T,
		);
		await turns.bumpTurnCounters("turn-1", { toolRounds: 5 }, T);
		await turns.insertLeg(
			{ id: "leg-2", turnId: "turn-1", kind: "continue", startedAt: 700 },
			T,
		);
		await turns.finishLeg("leg-1", { finishedAt: 9_000, httpStatus: 200 }, T);
		expect(
			db
				.query(
					"SELECT status, finished_at, tool_round_count, leg_count FROM sdk_bridge_turns WHERE id = 'turn-1'",
				)
				.get(),
		).toEqual({
			status: "running",
			finished_at: null,
			tool_round_count: 1,
			leg_count: 1,
		});
		expect(
			db
				.query("SELECT id, http_status FROM sdk_bridge_turn_legs ORDER BY id")
				.all(),
		).toEqual([{ id: "leg-1", http_status: null }]);
		// An ordinary turn's writes carry no token and are never fenced.
		await turns.finishTurn("turn-1", { finishedAt: 9_500, status: "failed" });
		expect(statusOf()).toBe("failed");
	});
});
