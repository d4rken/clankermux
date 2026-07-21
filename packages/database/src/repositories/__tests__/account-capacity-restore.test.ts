import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency (mirrors account-rate-limit-audit.test.ts).
import "@clankermux/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { AccountRepository } from "../account.repository";

function makeDb(): { db: Database; repo: AccountRepository } {
	const db = new Database(":memory:");
	db.run(`
		CREATE TABLE accounts (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			provider TEXT DEFAULT 'anthropic',
			refresh_token TEXT DEFAULT '',
			access_token TEXT,
			created_at INTEGER NOT NULL,
			rate_limited_until INTEGER,
			rate_limited_reason TEXT,
			rate_limited_at INTEGER,
			rate_limit_reset INTEGER,
			rate_limit_status TEXT,
			rate_limit_remaining INTEGER,
			consecutive_rate_limits INTEGER DEFAULT 0,
			identity_external_id TEXT,
			identity_email TEXT,
			identity_organization_name TEXT,
			identity_plan_tier TEXT,
			identity_rate_limit_tier TEXT,
			identity_captured_at INTEGER,
			identity_profile_fetched_at INTEGER
		)
	`);
	const adapter = new BunSqlAdapter(db);
	return { db, repo: new AccountRepository(adapter) };
}

/** Insert an account with a precise cooldown (deterministic, no Date.now()). */
function seedLock(
	db: Database,
	id: string,
	lock: { until: number | null; at: number | null; reason: string | null },
): void {
	db.run(
		`INSERT INTO accounts (id, name, created_at, rate_limited_until, rate_limited_at, rate_limited_reason)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[id, id, Date.now(), lock.until, lock.at, lock.reason],
	);
}

function readUntil(db: Database, id: string): number | null {
	return (
		db
			.query<{ rate_limited_until: number | null }, [string]>(
				"SELECT rate_limited_until FROM accounts WHERE id = ?",
			)
			.get(id)?.rate_limited_until ?? null
	);
}

describe("AccountRepository — clearRateLimitOnCapacityRestore (atomic compare-and-clear)", () => {
	let db: Database;
	let repo: AccountRepository;
	const UNTIL = Date.now() + 5 * 60 * 60 * 1000;
	const AT = Date.now();

	beforeEach(() => {
		({ db, repo } = makeDb());
	});
	afterEach(() => {
		db.close();
	});

	it("clears an ordinary cooldown when the observed until AND at are unchanged", async () => {
		seedLock(db, "acc-1", {
			until: UNTIL,
			at: AT,
			reason: "upstream_429_with_reset",
		});

		const changed = await repo.clearRateLimitOnCapacityRestore(
			"acc-1",
			UNTIL,
			AT,
		);

		expect(changed).toBe(true);
		expect(readUntil(db, "acc-1")).toBeNull();
	});

	it("does NOT clear when rate_limited_until changed between read and clear (TOCTOU)", async () => {
		const NEW_UNTIL = UNTIL + 60_000;
		// Current state carries the NEW deadline; caller clears with the STALE one.
		seedLock(db, "acc-1", {
			until: NEW_UNTIL,
			at: AT,
			reason: "upstream_429_with_reset",
		});

		const changed = await repo.clearRateLimitOnCapacityRestore(
			"acc-1",
			UNTIL,
			AT,
		);

		expect(changed).toBe(false);
		expect(readUntil(db, "acc-1")).toBe(NEW_UNTIL);
	});

	it("does NOT clear when rate_limited_at changed but the deadline is the SAME (reused upstream reset)", async () => {
		const NEW_AT = AT + 1000;
		// A concurrent NON-credit cooldown reused the same rate_limited_until but was
		// written at a later instant → different rate_limited_at. Must NOT clear.
		seedLock(db, "acc-1", {
			until: UNTIL,
			at: NEW_AT,
			reason: "upstream_429_with_reset",
		});

		const changed = await repo.clearRateLimitOnCapacityRestore(
			"acc-1",
			UNTIL,
			AT, // stale observed rate_limited_at
		);

		expect(changed).toBe(false);
		expect(readUntil(db, "acc-1")).toBe(UNTIL);
	});

	it("does NOT clear when a concurrent out_of_credits floor was written at the same until+at", async () => {
		seedLock(db, "acc-1", { until: UNTIL, at: AT, reason: "out_of_credits" });

		const changed = await repo.clearRateLimitOnCapacityRestore(
			"acc-1",
			UNTIL,
			AT,
		);

		expect(changed).toBe(false);
		expect(readUntil(db, "acc-1")).toBe(UNTIL);
	});

	it("null-safe matches a null rate_limited_at (IS ?) when the observation was also null", async () => {
		seedLock(db, "acc-1", {
			until: UNTIL,
			at: null,
			reason: "upstream_429_with_reset",
		});

		const changed = await repo.clearRateLimitOnCapacityRestore(
			"acc-1",
			UNTIL,
			null,
		);

		expect(changed).toBe(true);
		expect(readUntil(db, "acc-1")).toBeNull();
	});

	it("does NOT clear a null rate_limited_at row when the observation was a number", async () => {
		seedLock(db, "acc-1", {
			until: UNTIL,
			at: null,
			reason: "upstream_429_with_reset",
		});

		const changed = await repo.clearRateLimitOnCapacityRestore(
			"acc-1",
			UNTIL,
			AT,
		);

		expect(changed).toBe(false);
		expect(readUntil(db, "acc-1")).toBe(UNTIL);
	});

	it("returns false for an unknown account", async () => {
		const changed = await repo.clearRateLimitOnCapacityRestore(
			"nope",
			UNTIL,
			AT,
		);
		expect(changed).toBe(false);
	});
});
