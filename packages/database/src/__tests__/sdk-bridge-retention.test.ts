/**
 * Retention of the SDK bridge turn tables in the cleanup worker.
 *
 * Outer bridge legs have routing_attempts but no `requests` row, so the
 * orphan-attempt prune must treat a leg as a parent. Turns age out on the
 * request-retention cutoff and take their legs with them.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { APPLIED_REQUEST_CUTOFF_KEY } from "../applied-request-cutoff";
import { DatabaseOperations } from "../database-operations";
import { RequestRepository } from "../repositories/request.repository";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function withDb<T>(dbPath: string, fn: (db: Database) => T): T {
	const db = new Database(dbPath);
	db.exec("PRAGMA busy_timeout = 5000");
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

function ids(dbPath: string, table: string): string[] {
	return withDb(dbPath, (db) =>
		(
			db.query(`SELECT id FROM ${table} ORDER BY id`).all() as Array<{
				id: string;
			}>
		).map((r) => r.id),
	);
}

function insertTurn(
	db: Database,
	id: string,
	startedAt: number,
	status = "completed",
): void {
	db.run(
		`INSERT INTO sdk_bridge_turns (id, started_at, status, history_mode, system_prompt_policy)
		 VALUES (?, ?, ?, 'fresh', 'drop')`,
		[id, startedAt, status],
	);
}

function insertPark(db: Database, turnId: string, state: string): void {
	db.run(
		`INSERT INTO sdk_bridge_released_parks (
			turn_id, state, session_id, session_path, resume_at,
			awaited_tool_use_ids, requested_model, descriptor, active_ms,
			parked_since, expires_at, file_bytes, created_at
		) VALUES (?, ?, 's', 'f', 'u', '[]', 'm', '{}', 0, 0, 0, 0, 0)`,
		[turnId, state],
	);
}

function insertLeg(
	db: Database,
	id: string,
	turnId: string,
	startedAt: number,
): void {
	db.run(
		`INSERT INTO sdk_bridge_turn_legs (id, turn_id, kind, started_at)
		 VALUES (?, ?, 'start', ?)`,
		[id, turnId, startedAt],
	);
}

function insertAttempt(
	db: Database,
	id: string,
	requestId: string,
	startedAt: number,
): void {
	db.run(
		"INSERT OR IGNORE INTO routing_snapshots(id, content) VALUES ('snap', '{}')",
	);
	db.run(
		`INSERT INTO routing_attempts(id, request_id, route_snapshot_id, requested_model, kind, started_at)
		 VALUES (?, ?, 'snap', 'claude-opus-5-5', 'upstream_send', ?)`,
		[id, requestId, startedAt],
	);
}

function appliedCutoff(dbPath: string): number | null {
	return withDb(dbPath, (db) => {
		const row = db
			.query("SELECT config FROM strategies WHERE name = ?")
			.get(APPLIED_REQUEST_CUTOFF_KEY) as { config: string } | null;
		return row ? (JSON.parse(row.config) as { cutoff: number }).cutoff : null;
	});
}

async function runCleanup(
	dbPath: string,
	requestRetentionMs: number | undefined,
): Promise<void> {
	const dbOps = new DatabaseOperations(dbPath);
	try {
		await dbOps.cleanupOldRequests(DAY, requestRetentionMs);
	} finally {
		await dbOps.close();
	}
}

describe("cleanup worker: SDK bridge turns", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clankermux-sdk-bridge-"));
		dbPath = path.join(tmpDir, "test.db");
		const dbOps = new DatabaseOperations(dbPath);
		await dbOps.close();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("keeps routing attempts whose request id is a live leg, and still prunes true orphans", async () => {
		const now = Date.now();
		const stale = now - 2 * DAY;
		withDb(dbPath, (db) => {
			insertTurn(db, "turn-live", now - HOUR);
			insertLeg(db, "leg-live", "turn-live", now - HOUR);
			insertAttempt(db, "attempt-leg", "leg-live", stale);
			insertAttempt(db, "attempt-orphan", "no-such-parent", stale);
			// Younger than the one-day grace: kept even with no parent at all.
			insertAttempt(db, "attempt-fresh-orphan", "not-yet-recorded", now);
		});

		await runCleanup(dbPath, 30 * DAY);

		expect(ids(dbPath, "routing_attempts")).toEqual([
			"attempt-fresh-orphan",
			"attempt-leg",
		]);
	});

	it("prunes turns older than the request cutoff with their legs and leg attempts", async () => {
		const now = Date.now();
		const old = now - 10 * DAY;
		withDb(dbPath, (db) => {
			insertTurn(db, "turn-old", old);
			insertLeg(db, "leg-old-1", "turn-old", old);
			insertLeg(db, "leg-old-2", "turn-old", old + 1_000);
			insertAttempt(db, "attempt-old", "leg-old-1", old);
			insertTurn(db, "turn-new", now - HOUR);
			insertLeg(db, "leg-new", "turn-new", now - HOUR);
			insertAttempt(db, "attempt-new", "leg-new", now - 2 * DAY);
		});

		await runCleanup(dbPath, 7 * DAY);

		expect(ids(dbPath, "sdk_bridge_turns")).toEqual(["turn-new"]);
		expect(ids(dbPath, "sdk_bridge_turn_legs")).toEqual(["leg-new"]);
		expect(ids(dbPath, "routing_attempts")).toEqual(["attempt-new"]);
	});

	it("leaves a kept turn's aged leg unreadable through the client API, never smaller", async () => {
		const now = Date.now();
		const old = now - 10 * DAY;
		withDb(dbPath, (db) => {
			insertTurn(db, "turn-released", old, "released");
			db.run("UPDATE sdk_bridge_turns SET api_key_id = 'key-1' WHERE id = ?", [
				"turn-released",
			]);
			insertPark(db, "turn-released", "released");
			db.run(
				`INSERT INTO sdk_bridge_turn_legs (id, turn_id, kind, started_at,
					finished_at, http_status, api_key_id, inner_call_count, settled_at)
				VALUES ('leg-tool', 'turn-released', 'start', ?, ?, 200, 'key-1', 1, ?)`,
				[old, old + 1_000, old + 1_000],
			);
			db.run(
				`INSERT INTO requests (id, timestamp, method, path, api_key_id,
					input_tokens, usage_source, sdk_bridge_turn_id, sdk_bridge_leg_id)
				VALUES ('inner-1', ?, 'POST', '/v1/messages', 'key-1', 10,
					'provider', 'turn-released', 'leg-tool')`,
				[old + 500],
			);
		});
		const readLeg = async (since: number) => {
			const dbOps = new DatabaseOperations(dbPath);
			try {
				return await new RequestRepository(dbOps.getAdapter()).getClientRequest(
					"key-1",
					"leg-tool",
					since,
				);
			} finally {
				await dbOps.close();
			}
		};
		expect(await readLeg(old - DAY)).toMatchObject({ input_tokens: 10 });

		await runCleanup(dbPath, 7 * DAY);

		// The turn and its leg outlive the cutoff with the park; the inner row
		// does not, and the leg is gone with it rather than read as smaller.
		expect(ids(dbPath, "sdk_bridge_turn_legs")).toEqual(["leg-tool"]);
		expect(ids(dbPath, "requests")).toEqual([]);
		expect(await readLeg(now - 7 * DAY)).toBeNull();
		// Retention raised to 30 days: the cutoff the pass applied still holds.
		expect(await readLeg(now - 30 * DAY)).toBeNull();
	});

	it("records the cutoff it applies before deleting any request, and only ever raises it", async () => {
		const now = Date.now();
		await runCleanup(dbPath, 7 * DAY);
		const first = appliedCutoff(dbPath);
		expect(first).toBeGreaterThanOrEqual(now - 7 * DAY);
		expect(first).toBeLessThanOrEqual(Date.now() - 7 * DAY);

		await runCleanup(dbPath, 30 * DAY);
		expect(appliedCutoff(dbPath)).toBe(first);

		withDb(dbPath, (db) => {
			db.run(
				`INSERT INTO requests (id, timestamp, method, path) VALUES ('old', ?, 'POST', '/v1/messages')`,
				[now - 10 * DAY],
			);
			db.run(
				"CREATE TRIGGER no_request_delete BEFORE DELETE ON requests BEGIN SELECT RAISE(ABORT, 'refused'); END",
			);
		});
		await runCleanup(dbPath, 2 * DAY).catch(() => {});
		expect(ids(dbPath, "requests")).toEqual(["old"]);
		expect(appliedCutoff(dbPath)).toBeGreaterThanOrEqual(now - 2 * DAY);
	});

	it("records no cutoff when request retention is disabled", async () => {
		await runCleanup(dbPath, undefined);
		expect(appliedCutoff(dbPath)).toBeNull();
	});

	it("keeps an old turn while a continuation of it is recent, and once it finished recently", async () => {
		const now = Date.now();
		const old = now - 10 * DAY;
		withDb(dbPath, (db) => {
			insertTurn(db, "turn-continued", old);
			db.run("UPDATE sdk_bridge_turns SET finished_at = ? WHERE id = ?", [
				old + HOUR,
				"turn-continued",
			]);
			insertLeg(db, "leg-start", "turn-continued", old);
			db.run(
				`INSERT INTO sdk_bridge_turn_legs (id, turn_id, kind, started_at)
				 VALUES ('leg-recent', 'turn-continued', 'continue', ?)`,
				[now - HOUR],
			);
			insertTurn(db, "turn-late-finish", old);
			db.run("UPDATE sdk_bridge_turns SET finished_at = ? WHERE id = ?", [
				now - HOUR,
				"turn-late-finish",
			]);
			insertTurn(db, "turn-old", old);
			db.run("UPDATE sdk_bridge_turns SET finished_at = ? WHERE id = ?", [
				old + HOUR,
				"turn-old",
			]);
		});

		await runCleanup(dbPath, 7 * DAY);

		expect(ids(dbPath, "sdk_bridge_turns")).toEqual([
			"turn-continued",
			"turn-late-finish",
		]);
		expect(ids(dbPath, "sdk_bridge_turn_legs")).toEqual([
			"leg-recent",
			"leg-start",
		]);
	});

	it("keeps an old finished turn that another key's refused continuation reached recently", async () => {
		const now = Date.now();
		const old = now - 10 * DAY;
		withDb(dbPath, (db) => {
			insertTurn(db, "turn-1", old);
			db.run("UPDATE sdk_bridge_turns SET finished_at = ? WHERE id = ?", [
				old + HOUR,
				"turn-1",
			]);
			db.run(
				`INSERT INTO sdk_bridge_turn_legs (id, turn_id, kind, started_at,
					finished_at, http_status, api_key_id, inner_call_count, settled_at)
				 VALUES ('refused', 'turn-1', 'continue', ?, ?, 409, 'key-2', 0, ?)`,
				[now - HOUR, now - HOUR, now - HOUR],
			);
		});

		await runCleanup(dbPath, 7 * DAY);

		expect(ids(dbPath, "sdk_bridge_turns")).toEqual(["turn-1"]);
		expect(ids(dbPath, "sdk_bridge_turn_legs")).toEqual(["refused"]);
	});

	it("keeps every turn when request retention is disabled", async () => {
		const old = Date.now() - 400 * DAY;
		withDb(dbPath, (db) => {
			insertTurn(db, "turn-ancient", old);
			insertLeg(db, "leg-ancient", "turn-ancient", old);
		});

		await runCleanup(dbPath, undefined);

		expect(ids(dbPath, "sdk_bridge_turns")).toEqual(["turn-ancient"]);
		expect(ids(dbPath, "sdk_bridge_turn_legs")).toEqual(["leg-ancient"]);
	});

	it("prunes legs whose turn was deleted without foreign-key enforcement", async () => {
		const now = Date.now();
		withDb(dbPath, (db) => {
			insertTurn(db, "turn-gone", now - HOUR);
			insertLeg(db, "leg-orphan", "turn-gone", now - HOUR);
			insertTurn(db, "turn-kept", now - HOUR);
			insertLeg(db, "leg-kept", "turn-kept", now - HOUR);
			// The sqlite3 shell defaults to foreign_keys = OFF, so a hand-run
			// delete skips the cascade.
			db.exec("PRAGMA foreign_keys = OFF");
			db.run("DELETE FROM sdk_bridge_turns WHERE id = 'turn-gone'");
		});
		expect(ids(dbPath, "sdk_bridge_turn_legs")).toEqual([
			"leg-kept",
			"leg-orphan",
		]);

		await runCleanup(dbPath, 30 * DAY);

		expect(ids(dbPath, "sdk_bridge_turn_legs")).toEqual(["leg-kept"]);
	});

	it("never prunes an open turn, or one a released park still owns", async () => {
		const old = Date.now() - 10 * DAY;
		withDb(dbPath, (db) => {
			insertTurn(db, "turn-done", old);
			insertTurn(db, "turn-running", old, "running");
			insertTurn(db, "turn-released", old, "released");
			insertPark(db, "turn-released", "released");
			// Closed on its row, but its park is being resumed right now.
			insertTurn(db, "turn-claimed", old, "failed");
			insertPark(db, "turn-claimed", "claimed");
		});

		await runCleanup(dbPath, 7 * DAY);

		expect(ids(dbPath, "sdk_bridge_turns")).toEqual([
			"turn-claimed",
			"turn-released",
			"turn-running",
		]);
	});
});
