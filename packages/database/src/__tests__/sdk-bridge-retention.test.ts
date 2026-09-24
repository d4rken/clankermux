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
import { DatabaseOperations } from "../database-operations";

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

function insertTurn(db: Database, id: string, startedAt: number): void {
	db.run(
		`INSERT INTO sdk_bridge_turns (id, started_at, status, history_mode, system_prompt_policy)
		 VALUES (?, ?, 'completed', 'fresh', 'drop')`,
		[id, startedAt],
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
});
