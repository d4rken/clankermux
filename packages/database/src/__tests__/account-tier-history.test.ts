/**
 * Tests for the `account_tier_history` series.
 *
 * Three properties, one per way it can go wrong:
 *
 *  - Written on CHANGE only. The identity writes are COALESCE merges, so an
 *    incoming null PRESERVES the stored tier — recording that as a transition
 *    would fill the series with fictional "moved to null" events on every token
 *    refresh whose envelope omits the tier.
 *  - Never written for a write that did not happen. `updateTokens` guards on the
 *    refresh token it exchanged; a CAS-rejected call changes nothing and must
 *    leave no history claiming a tier the account never adopted.
 *  - Seeded exactly once, so the series starts from a known point without
 *    turning into a restart log.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { AccountIdentity } from "@clankermux/types";
import rootPackageJson from "../../../../package.json";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { runOneShotBackfills } from "../backfills";
import { ensureSchema } from "../migrations";
import { AccountRepository } from "../repositories/account.repository";

interface HistoryRow {
	account_id: string;
	observed_at: number;
	plan_tier: string | null;
	rate_limit_tier: string | null;
	source: string;
	app_version: string | null;
}

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	db.run("PRAGMA foreign_keys = ON");
	return db;
}

function insertAccount(
	db: Database,
	id: string,
	opts: {
		planTier?: string | null;
		rateLimitTier?: string | null;
		refreshToken?: string | null;
	} = {},
): void {
	db.run(
		`INSERT INTO accounts (
			id, name, provider, created_at, refresh_token,
			identity_plan_tier, identity_rate_limit_tier
		) VALUES (?, ?, 'anthropic', ?, ?, ?, ?)`,
		[
			id,
			id,
			Date.now(),
			opts.refreshToken ?? null,
			opts.planTier ?? null,
			opts.rateLimitTier ?? null,
		],
	);
}

function history(db: Database): HistoryRow[] {
	return db
		.query(`SELECT * FROM account_tier_history ORDER BY id`)
		.all() as HistoryRow[];
}

function identity(overrides: Partial<AccountIdentity> = {}): AccountIdentity {
	return {
		externalAccountId: null,
		email: null,
		organizationName: null,
		planTier: null,
		rateLimitTier: null,
		...overrides,
	};
}

describe("account_tier_history — identity-capture chokepoints", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		db = makeDb();
		repo = new AccountRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	describe("updateTokens", () => {
		it("appends a row when the plan tier changes", async () => {
			insertAccount(db, "acct-a", { planTier: "pro", rateLimitTier: "5x" });
			await repo.updateTokens(
				"acct-a",
				"access-1",
				123,
				undefined,
				identity({ planTier: "max" }),
			);
			const rows = history(db);
			expect(rows).toHaveLength(1);
			expect(rows[0].plan_tier).toBe("max");
			// COALESCE-merged: the incoming null kept the stored multiplier.
			expect(rows[0].rate_limit_tier).toBe("5x");
			expect(rows[0].source).toBe("identity-capture");
			// The ClankerMux release version, NOT the Claude CLI compat version that
			// getVersionSync falls back to when npm_package_version is unset (which
			// is every systemd start).
			expect(rows[0].app_version).toBe(rootPackageJson.version);
		});

		it("appends a row when only the rate-limit tier changes", async () => {
			insertAccount(db, "acct-a", { planTier: "max", rateLimitTier: "5x" });
			await repo.updateTokens(
				"acct-a",
				"access-1",
				123,
				undefined,
				identity({ rateLimitTier: "20x" }),
			);
			expect(history(db).map((r) => r.rate_limit_tier)).toEqual(["20x"]);
		});

		it("writes nothing when the tiers are unchanged", async () => {
			insertAccount(db, "acct-a", { planTier: "max", rateLimitTier: "20x" });
			await repo.updateTokens(
				"acct-a",
				"access-1",
				123,
				undefined,
				identity({ planTier: "max", rateLimitTier: "20x" }),
			);
			expect(history(db)).toHaveLength(0);
		});

		it("writes nothing when the incoming tiers are null (a null PRESERVES)", async () => {
			insertAccount(db, "acct-a", { planTier: "max", rateLimitTier: "20x" });
			await repo.updateTokens(
				"acct-a",
				"access-1",
				123,
				undefined,
				identity({ email: "a@example.com" }),
			);
			expect(history(db)).toHaveLength(0);
		});

		it("writes nothing when no identity is supplied at all", async () => {
			insertAccount(db, "acct-a", { planTier: "max" });
			await repo.updateTokens("acct-a", "access-1", 123);
			expect(history(db)).toHaveLength(0);
		});

		it("writes nothing when the CAS guard rejects the write", async () => {
			insertAccount(db, "acct-a", {
				planTier: "pro",
				refreshToken: "current-token",
			});
			const applied = await repo.updateTokens(
				"acct-a",
				"access-1",
				123,
				"rotated-token",
				identity({ planTier: "max" }),
				// The account no longer holds this token — the guarded WHERE misses.
				"stale-token",
			);
			expect(applied).toBe(false);
			expect(history(db)).toHaveLength(0);
			// And the tier itself was not written either.
			const row = db
				.query(
					`SELECT identity_plan_tier AS t FROM accounts WHERE id = 'acct-a'`,
				)
				.get() as { t: string | null };
			expect(row.t).toBe("pro");
		});

		it("appends when the CAS guard matches", async () => {
			insertAccount(db, "acct-a", {
				planTier: "pro",
				refreshToken: "current-token",
			});
			const applied = await repo.updateTokens(
				"acct-a",
				"access-1",
				123,
				"rotated-token",
				identity({ planTier: "max" }),
				"current-token",
			);
			expect(applied).toBe(true);
			expect(history(db).map((r) => r.plan_tier)).toEqual(["max"]);
		});
	});

	describe("setAccountIdentityFromProfile", () => {
		it("appends on change and stays silent on a no-op", async () => {
			insertAccount(db, "acct-a", { planTier: "pro", rateLimitTier: "5x" });
			await repo.setAccountIdentityFromProfile(
				"acct-a",
				identity({ planTier: "max", rateLimitTier: "20x" }),
			);
			await repo.setAccountIdentityFromProfile(
				"acct-a",
				identity({ planTier: "max", rateLimitTier: "20x" }),
			);
			const rows = history(db);
			expect(rows).toHaveLength(1);
			expect(rows[0].plan_tier).toBe("max");
			expect(rows[0].rate_limit_tier).toBe("20x");
		});

		it("stays silent when the incoming tiers are null", async () => {
			insertAccount(db, "acct-a", { planTier: "max" });
			await repo.setAccountIdentityFromProfile(
				"acct-a",
				identity({ email: "a@example.com" }),
			);
			expect(history(db)).toHaveLength(0);
		});
	});

	describe("setAccountIdentity", () => {
		it("appends on change and stays silent on a no-op", async () => {
			insertAccount(db, "acct-a", { planTier: null });
			await repo.setAccountIdentity("acct-a", identity({ planTier: "plus" }));
			await repo.setAccountIdentity("acct-a", identity({ planTier: "plus" }));
			expect(history(db).map((r) => r.plan_tier)).toEqual(["plus"]);
		});

		it("stays silent when the incoming tiers are null", async () => {
			insertAccount(db, "acct-a", { planTier: "plus" });
			await repo.setAccountIdentity(
				"acct-a",
				identity({ externalAccountId: "ext-1" }),
			);
			expect(history(db)).toHaveLength(0);
		});
	});

	it("cascades away when the owning account is deleted", async () => {
		insertAccount(db, "acct-a", { planTier: "pro" });
		insertAccount(db, "acct-b", { planTier: "pro" });
		await repo.setAccountIdentity("acct-a", identity({ planTier: "max" }));
		await repo.setAccountIdentity("acct-b", identity({ planTier: "max" }));
		db.run(`DELETE FROM accounts WHERE id = 'acct-a'`);
		expect(history(db).map((r) => r.account_id)).toEqual(["acct-b"]);
	});
});

describe("account_tier_history — the write's SQLITE_BUSY envelope", () => {
	let db: Database;
	let adapter: BunSqlAdapter;
	let repo: AccountRepository;

	beforeEach(() => {
		db = makeDb();
		adapter = new BunSqlAdapter(db);
		repo = new AccountRepository(adapter);
	});

	afterEach(() => {
		db.close();
	});

	it("keeps the no-identity write on the plain runWithChanges path", async () => {
		insertAccount(db, "acct-a", { planTier: "max" });
		const runWithChanges = spyOn(adapter, "runWithChanges");
		const runTransaction = spyOn(adapter, "runTransaction");

		await repo.updateTokens("acct-a", "access-1", 123);

		// No identity means nothing to compare and no history row to append, so the
		// write stays the single statement it was before the series existed.
		expect(runWithChanges).toHaveBeenCalledTimes(1);
		expect(runTransaction).not.toHaveBeenCalled();
	});

	it("retries the identity write when the writer slot is held", async () => {
		// The regression: running db.transaction(fn)() on the raw handle drops a
		// token refresh to the bare C-level busy_timeout, so a refresh racing the
		// vacuum/cleanup worker fails and takes the account out of the pool.
		insertAccount(db, "acct-a", { planTier: "pro", rateLimitTier: "5x" });
		const runTransaction = spyOn(adapter, "runTransaction");

		const original = db.run.bind(db);
		let calls = 0;
		// biome-ignore lint/suspicious/noExplicitAny: test stub replacing internal DB method
		(db as any).run = (...args: any[]) => {
			calls++;
			if (calls === 1) {
				throw Object.assign(new Error("database is locked"), {
					code: "SQLITE_BUSY",
				});
			}
			// biome-ignore lint/suspicious/noExplicitAny: delegating to real implementation
			return (original as any)(...args);
		};

		try {
			const applied = await repo.updateTokens(
				"acct-a",
				"access-1",
				123,
				undefined,
				identity({ planTier: "max" }),
			);
			expect(applied).toBe(true);
		} finally {
			// biome-ignore lint/suspicious/noExplicitAny: restoring original
			(db as any).run = original;
		}

		expect(runTransaction).toHaveBeenCalledTimes(1);
		// The busy attempt rolled back in full, so the retry left exactly one row.
		expect(history(db).map((r) => r.plan_tier)).toEqual(["max"]);
	});
});

describe("account_tier_history — one-shot seed backfill", () => {
	let db: Database;

	beforeEach(() => {
		db = makeDb();
	});

	afterEach(() => {
		db.close();
	});

	it("seeds one row per existing account, with its current tiers", () => {
		insertAccount(db, "acct-a", { planTier: "max", rateLimitTier: "20x" });
		insertAccount(db, "acct-b", { planTier: null, rateLimitTier: null });

		runOneShotBackfills(db);

		const rows = history(db);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.source === "seed")).toBe(true);
		// Same rule as the identity-capture rows: the seeded provenance must name
		// the ClankerMux build, never CLAUDE_CLI_VERSION.
		expect(rows.every((r) => r.app_version === rootPackageJson.version)).toBe(
			true,
		);
		expect(
			rows.map((r) => [r.account_id, r.plan_tier, r.rate_limit_tier]),
		).toEqual([
			["acct-a", "max", "20x"],
			["acct-b", null, null],
		]);
	});

	it("runs exactly once, however often startup repeats", () => {
		insertAccount(db, "acct-a", { planTier: "max" });
		runOneShotBackfills(db);
		runOneShotBackfills(db);
		runOneShotBackfills(db);
		expect(history(db)).toHaveLength(1);
	});

	it("records its marker with the account count", () => {
		insertAccount(db, "acct-a");
		insertAccount(db, "acct-b");
		runOneShotBackfills(db);
		const marker = db
			.query(
				`SELECT config FROM strategies WHERE name = 'backfill:account-tier-history-seed'`,
			)
			.get() as { config: string } | null;
		expect(marker).not.toBeNull();
		expect(JSON.parse(marker?.config ?? "{}").accountsSeeded).toBe(2);
	});
});
