/**
 * One-shot backfills: the pass must apply once and then never touch the data
 * again, because what it writes is a per-account toggle the operator owns from
 * that point on.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOneShotBackfills } from "../backfills";
import { ensureSchema } from "../migrations";

const MARKER = "backfill:auto-pause-overage-default";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clankermux-backfills-"));
	dbPath = path.join(tmpDir, "test.db");
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function insertAccount(db: Database, id: string, autoPause: number): void {
	db.run(
		`INSERT INTO accounts (id, name, provider, created_at, auto_pause_on_overage_enabled)
		 VALUES (?, ?, 'anthropic', ?, ?)`,
		[id, id, 1_700_000_000_000, autoPause],
	);
}

function autoPause(db: Database, id: string): number {
	return (
		db
			.prepare(
				`SELECT auto_pause_on_overage_enabled AS v FROM accounts WHERE id = ?`,
			)
			.get(id) as { v: number }
	).v;
}

function marker(db: Database): { config: string } | null {
	return db
		.prepare(`SELECT config FROM strategies WHERE name = ?`)
		.get(MARKER) as { config: string } | null;
}

describe("auto-pause-on-overage default backfill", () => {
	it("enables overage auto-pause on pre-existing rows and records the marker", () => {
		const db = new Database(dbPath, { create: true });
		try {
			ensureSchema(db);
			insertAccount(db, "old-acct", 0);
			insertAccount(db, "already-on", 1);

			runOneShotBackfills(db);

			expect(autoPause(db, "old-acct")).toBe(1);
			expect(autoPause(db, "already-on")).toBe(1);

			const row = marker(db);
			expect(row).not.toBeNull();
			expect(JSON.parse(row?.config ?? "{}").accountsUpdated).toBe(1);
		} finally {
			db.close();
		}
	});

	it("never re-enables an account the operator turned off afterwards", () => {
		// The whole reason this is one-shot: a level-triggered pass would read
		// "0" as "not yet backfilled" and silently undo a deliberate opt-out on
		// every single restart.
		const db = new Database(dbPath, { create: true });
		try {
			ensureSchema(db);
			insertAccount(db, "old-acct", 0);
			runOneShotBackfills(db);

			db.run(
				`UPDATE accounts SET auto_pause_on_overage_enabled = 0 WHERE id = ?`,
				["old-acct"],
			);
			runOneShotBackfills(db);

			expect(autoPause(db, "old-acct")).toBe(0);
		} finally {
			db.close();
		}
	});

	it("stays applied across a reopen", () => {
		const first = new Database(dbPath, { create: true });
		try {
			ensureSchema(first);
			insertAccount(first, "old-acct", 0);
			runOneShotBackfills(first);
		} finally {
			first.close();
		}

		const second = new Database(dbPath);
		try {
			const before = marker(second);
			second.run(
				`UPDATE accounts SET auto_pause_on_overage_enabled = 0 WHERE id = ?`,
				["old-acct"],
			);

			runOneShotBackfills(second);

			expect(autoPause(second, "old-acct")).toBe(0);
			// The marker is the persisted record, not an in-process flag.
			expect(marker(second)?.config).toBe(before?.config ?? "");
		} finally {
			second.close();
		}
	});

	it("is a no-op on a database whose accounts are all enabled", () => {
		const db = new Database(dbPath, { create: true });
		try {
			ensureSchema(db);
			insertAccount(db, "a", 1);
			insertAccount(db, "b", 1);

			runOneShotBackfills(db);

			expect(JSON.parse(marker(db)?.config ?? "{}").accountsUpdated).toBe(0);
			expect(autoPause(db, "a")).toBe(1);
			expect(autoPause(db, "b")).toBe(1);
		} finally {
			db.close();
		}
	});
});
