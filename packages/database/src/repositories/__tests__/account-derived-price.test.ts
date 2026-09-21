/**
 * Tests for the derived renewal price — the list price seeded from an
 * account's captured plan tier on every identity write.
 *
 * The whole safety of writing an unverified amount rests on
 * `renewal_price_source`, so these cover who may write it and who may not:
 * a first seed, a re-derivation when the tier moves, and the three states an
 * operator can leave behind (entered, cleared, pre-provenance) that must all
 * survive a capture untouched.
 *
 * Uses the real `ensureSchema()` rather than a hand-written CREATE TABLE, so
 * the columns and their defaults are the deployed ones.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency. Same pattern as account-pause-reason.test.ts.
import "@clankermux/core";
import type { AccountIdentity } from "@clankermux/types";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { AccountRepository } from "../account.repository";

let db: Database;
let repo: AccountRepository;

/**
 * Claude Max 20x by default — the one Anthropic tier pair that resolves to a
 * single price, so a test only has to say what it changes.
 */
const identity = (
	overrides: Partial<AccountIdentity> = {},
): AccountIdentity => ({
	externalAccountId: "ext-price",
	email: null,
	organizationName: null,
	planTier: "max",
	rateLimitTier: "20x",
	...overrides,
});

function insertAccount(id: string, provider = "anthropic"): void {
	db.run(
		`INSERT INTO accounts (id, name, provider, created_at) VALUES (?, ?, ?, ?)`,
		[id, id, provider, Date.now()] as never[],
	);
}

/**
 * Codex accounts are the ones whose cadence a test can control: the anchor
 * seeder only runs for anthropic, so nothing re-stamps `renewal_cadence`
 * between the setup and the capture.
 */
function insertCodexAccount(id: string): void {
	insertAccount(id, "codex");
}

beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	repo = new AccountRepository(new BunSqlAdapter(db));
});

afterEach(() => {
	db.close();
});

describe("derived renewal price — what it writes", () => {
	it("offers the tier's list price, marked derived", async () => {
		insertAccount("price-1");

		await repo.setAccountIdentityFromProfile("price-1", identity());

		const account = await repo.findById("price-1");
		expect(account?.renewal_price_usd_micros).toBe(200_000_000);
		expect(account?.renewal_price_source).toBe("derived");
	});

	it("prices a Codex plan type too", async () => {
		insertCodexAccount("price-2");

		await repo.setAccountIdentityFromProfile(
			"price-2",
			identity({ planTier: "prolite", rateLimitTier: null }),
		);

		const account = await repo.findById("price-2");
		expect(account?.renewal_price_usd_micros).toBe(100_000_000);
		expect(account?.renewal_price_source).toBe("derived");
	});

	it("writes nothing when the tier does not pin one price", async () => {
		insertAccount("price-3");

		// Max without a multiplier covers two prices; a per-seat plan has no one
		// price. Neither may leave a source behind, which would look like a
		// decision and block the derivation that a later tier capture enables.
		await repo.setAccountIdentityFromProfile(
			"price-3",
			identity({ rateLimitTier: null }),
		);
		let account = await repo.findById("price-3");
		expect(account?.renewal_price_usd_micros).toBeNull();
		expect(account?.renewal_price_source).toBeNull();

		await repo.setAccountIdentityFromProfile(
			"price-3",
			identity({ planTier: "team", rateLimitTier: null }),
		);
		account = await repo.findById("price-3");
		expect(account?.renewal_price_usd_micros).toBeNull();
		expect(account?.renewal_price_source).toBeNull();
	});

	it("offers nothing for a yearly cycle — the table holds monthly prices", async () => {
		insertCodexAccount("price-4");
		db.run(`UPDATE accounts SET renewal_cadence = 'yearly' WHERE id = ?`, [
			"price-4",
		] as never[]);

		await repo.setAccountIdentityFromProfile(
			"price-4",
			identity({ planTier: "pro", rateLimitTier: null }),
		);

		const account = await repo.findById("price-4");
		expect(account?.renewal_price_usd_micros).toBeNull();
		expect(account?.renewal_price_source).toBeNull();
	});
});

describe("derived renewal price — what it must not overwrite", () => {
	it("never overwrites a price the operator entered", async () => {
		insertAccount("price-5");
		await repo.setRenewal("price-5", "2026-01-02", "monthly", 42_000_000, null);

		await repo.setAccountIdentityFromProfile("price-5", identity());

		const account = await repo.findById("price-5");
		expect(account?.renewal_price_usd_micros).toBe(42_000_000);
		expect(account?.renewal_price_source).toBe("manual");
	});

	it("never re-offers a price the operator cleared", async () => {
		insertAccount("price-6");
		// A clear writes source='manual' with a null price. Gating on the price
		// alone would re-offer the estimate on the next capture, forever.
		await repo.setRenewal("price-6", "2026-01-02", "monthly", null, null);

		await repo.setAccountIdentityFromProfile("price-6", identity());

		const account = await repo.findById("price-6");
		expect(account?.renewal_price_usd_micros).toBeNull();
		expect(account?.renewal_price_source).toBe("manual");
	});

	it("never touches a price stored before the provenance column existed", async () => {
		insertAccount("price-7");
		db.run(
			`UPDATE accounts SET renewal_price_usd_micros = 42000000,
			                     renewal_price_source = NULL WHERE id = ?`,
			["price-7"] as never[],
		);

		await repo.setAccountIdentityFromProfile("price-7", identity());

		const account = await repo.findById("price-7");
		expect(account?.renewal_price_usd_micros).toBe(42_000_000);
		expect(account?.renewal_price_source).toBeNull();
	});
});

describe("derived renewal price — keeping up with the tier", () => {
	it("re-derives when the plan tier moves", async () => {
		insertAccount("price-8");
		await repo.setAccountIdentityFromProfile(
			"price-8",
			identity({ rateLimitTier: "5x" }),
		);
		expect((await repo.findById("price-8"))?.renewal_price_usd_micros).toBe(
			100_000_000,
		);

		await repo.setAccountIdentityFromProfile("price-8", identity());

		const account = await repo.findById("price-8");
		expect(account?.renewal_price_usd_micros).toBe(200_000_000);
		expect(account?.renewal_price_source).toBe("derived");
	});

	it("clears its own estimate once the tier stops resolving", async () => {
		insertCodexAccount("price-9");
		await repo.setAccountIdentityFromProfile(
			"price-9",
			identity({ planTier: "pro", rateLimitTier: null }),
		);
		expect((await repo.findById("price-9"))?.renewal_price_usd_micros).toBe(
			200_000_000,
		);

		// Moving onto a per-seat plan would leave the old plan's price standing
		// unless the derivation is allowed to take its own estimate back.
		await repo.setAccountIdentityFromProfile(
			"price-9",
			identity({ planTier: "team", rateLimitTier: null }),
		);

		const account = await repo.findById("price-9");
		expect(account?.renewal_price_usd_micros).toBeNull();
		expect(account?.renewal_price_source).toBeNull();
	});

	it("is idempotent across repeated captures of the same tier", async () => {
		insertAccount("price-10");

		// The capture runs every few hours; an unchanged tier must not churn the
		// row, and must not promote or demote the provenance it already wrote.
		await repo.setAccountIdentityFromProfile("price-10", identity());
		await repo.setAccountIdentityFromProfile("price-10", identity());
		await repo.setAccountIdentityFromProfile("price-10", identity());

		const account = await repo.findById("price-10");
		expect(account?.renewal_price_usd_micros).toBe(200_000_000);
		expect(account?.renewal_price_source).toBe("derived");
	});

	it("takes the estimate back when a provider sync turns the cycle yearly", async () => {
		insertCodexAccount("price-12");
		await repo.setAccountIdentityFromProfile(
			"price-12",
			identity({ planTier: "pro", rateLimitTier: null }),
		);
		expect((await repo.findById("price-12"))?.renewal_price_usd_micros).toBe(
			200_000_000,
		);

		// The cadence sync is the only writer that can turn a cycle yearly, and
		// the table holds monthly prices. Leaving the monthly amount standing
		// beside a yearly cycle would put a wrong number in front of the one
		// click that confirms it.
		const moved = await repo.syncProviderRenewalAnchor("price-12", {
			endsAtMs: Date.now() + 30 * 86_400_000,
			cadence: "yearly",
			graceEndsAtMs: null,
		});
		expect(moved).toBe(true);

		const account = await repo.findById("price-12");
		expect(account?.renewal_cadence).toBe("yearly");
		expect(account?.renewal_price_usd_micros).toBeNull();
		expect(account?.renewal_price_source).toBeNull();
	});

	it("leaves an operator price alone when a provider sync changes the cycle", async () => {
		insertCodexAccount("price-13");
		// A provider-owned anchor with an operator price: the sync is free to
		// move the date, so its follow-up derivation really does run.
		await repo.setRenewal(
			"price-13",
			"2026-01-02",
			"monthly",
			42_000_000,
			null,
		);
		db.run(
			`UPDATE accounts SET renewal_anchor_source = 'provider' WHERE id = ?`,
			["price-13"] as never[],
		);

		const moved = await repo.syncProviderRenewalAnchor("price-13", {
			endsAtMs: Date.now() + 30 * 86_400_000,
			cadence: "yearly",
			graceEndsAtMs: null,
		});
		expect(moved).toBe(true);

		const account = await repo.findById("price-13");
		expect(account?.renewal_cadence).toBe("yearly");
		expect(account?.renewal_price_usd_micros).toBe(42_000_000);
		expect(account?.renewal_price_source).toBe("manual");
	});

	it("offers an estimate to an account whose identity was inserted directly", async () => {
		// The Codex OAuth creation path writes its tier columns in the INSERT,
		// bypassing the identity transaction that normally derives the price.
		db.run(
			`INSERT INTO accounts (id, name, provider, created_at, identity_plan_tier)
			 VALUES (?, ?, 'codex', ?, 'pro')`,
			["price-14", "price-14", Date.now()] as never[],
		);

		await repo.resyncDerivedRenewalPrice("price-14");

		const account = await repo.findById("price-14");
		expect(account?.renewal_price_usd_micros).toBe(200_000_000);
		expect(account?.renewal_price_source).toBe("derived");
	});

	it("is reoffered after a hand-back to automatic tracking", async () => {
		insertAccount("price-11");
		await repo.setRenewal(
			"price-11",
			"2026-01-02",
			"monthly",
			42_000_000,
			null,
		);
		await repo.resetRenewalToAutomatic("price-11");

		await repo.setAccountIdentityFromProfile("price-11", identity());

		const account = await repo.findById("price-11");
		expect(account?.renewal_price_usd_micros).toBe(200_000_000);
		expect(account?.renewal_price_source).toBe("derived");
	});
});
