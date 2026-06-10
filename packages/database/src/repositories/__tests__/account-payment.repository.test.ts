/**
 * Tests for AccountPaymentRepository — the per-account payments ledger.
 *
 * Uses the REAL schema from ensureSchema() so the partial unique indexes and
 * CHECK constraints are exercised exactly as deployed:
 *  - recordAuto is idempotent per (account_id, paid_date) for subscriptions
 *  - a soft-deleted (tombstoned) subscription row suppresses recordAuto
 *  - upsertSubscription resurrects + updates a tombstoned row
 *  - credits are NOT deduped by date (two purchases same day = two rows)
 *  - import_key gives credit seeding retry-idempotency
 *  - aggregation respects deleted_at and range bounds
 *  - CHECK constraints reject bad kind/source/negative amounts
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency. Same pattern as account-renewal.test.ts.
import "@clankermux/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import {
	AccountPaymentRepository,
	localMidnightMsOf,
} from "../account-payment.repository";

const NOW = new Date(2026, 5, 9, 12).getTime();

function makeDb(): { db: Database; repo: AccountPaymentRepository } {
	const db = new Database(":memory:");
	ensureSchema(db);
	const adapter = new BunSqlAdapter(db);
	const repo = new AccountPaymentRepository(adapter);
	return { db, repo };
}

describe("AccountPaymentRepository", () => {
	let db: Database;
	let repo: AccountPaymentRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	describe("localMidnightMsOf", () => {
		it("returns the local-midnight ms of a YYYY-MM-DD date", () => {
			expect(localMidnightMsOf("2026-06-09")).toBe(
				new Date(2026, 5, 9).getTime(),
			);
		});

		it("throws on an invalid calendar date", () => {
			expect(() => localMidnightMsOf("2026-02-31")).toThrow();
		});
	});

	describe("recordAuto", () => {
		it("inserts a subscription row and reports it", async () => {
			const inserted = await repo.recordAuto(
				"acc-1",
				"Account One",
				"2026-06-01",
				20_000_000,
				NOW,
			);
			expect(inserted).toBe(true);

			const rows = await repo.findRecent(10);
			expect(rows.length).toBe(1);
			expect(rows[0]?.kind).toBe("subscription");
			expect(rows[0]?.source).toBe("auto");
			expect(rows[0]?.paid_date).toBe("2026-06-01");
			expect(rows[0]?.paid_at_ms).toBe(new Date(2026, 5, 1).getTime());
			expect(rows[0]?.amount_usd_micros).toBe(20_000_000);
		});

		it("is idempotent — a second call for the same due date inserts nothing", async () => {
			await repo.recordAuto(
				"acc-1",
				"Account One",
				"2026-06-01",
				20_000_000,
				NOW,
			);
			const second = await repo.recordAuto(
				"acc-1",
				"Account One",
				"2026-06-01",
				25_000_000,
				NOW + 1,
			);
			expect(second).toBe(false);

			const rows = await repo.findRecent(10);
			expect(rows.length).toBe(1);
			expect(rows[0]?.amount_usd_micros).toBe(20_000_000);
		});

		it("tombstone suppression — recordAuto after softDelete inserts nothing", async () => {
			await repo.recordAuto(
				"acc-1",
				"Account One",
				"2026-06-01",
				20_000_000,
				NOW,
			);
			const rows = await repo.findRecent(10);
			const id = rows[0]?.id as string;
			expect(await repo.softDelete(id)).toBe(true);

			const reinserted = await repo.recordAuto(
				"acc-1",
				"Account One",
				"2026-06-01",
				20_000_000,
				NOW + 2,
			);
			expect(reinserted).toBe(false);
			// Still only the tombstoned row, hidden from findRecent.
			expect((await repo.findRecent(10)).length).toBe(0);
		});
	});

	describe("upsertSubscription", () => {
		it("resurrects and updates a tombstoned row", async () => {
			await repo.recordAuto(
				"acc-1",
				"Account One",
				"2026-06-01",
				20_000_000,
				NOW,
			);
			const id = (await repo.findRecent(10))[0]?.id as string;
			await repo.softDelete(id);

			await repo.upsertSubscription(
				"acc-1",
				"Account One Renamed",
				"2026-06-01",
				30_000_000,
				"manual",
				"corrected",
				NOW + 5,
			);

			const rows = await repo.findRecent(10);
			expect(rows.length).toBe(1);
			expect(rows[0]?.id).toBe(id); // same row, resurrected
			expect(rows[0]?.deleted_at).toBeNull();
			expect(rows[0]?.amount_usd_micros).toBe(30_000_000);
			expect(rows[0]?.source).toBe("manual");
			expect(rows[0]?.notes).toBe("corrected");
			expect(rows[0]?.account_name).toBe("Account One Renamed");
			expect(rows[0]?.recorded_at).toBe(NOW + 5);
		});

		it("inserts a fresh row when none exists for the date", async () => {
			await repo.upsertSubscription(
				"acc-1",
				"Account One",
				"2026-05-01",
				20_000_000,
				"backfill",
				null,
				NOW,
			);
			const rows = await repo.findRecent(10);
			expect(rows.length).toBe(1);
			expect(rows[0]?.source).toBe("backfill");
		});
	});

	describe("insertCredit", () => {
		it("two purchases on the same account+date create two rows", async () => {
			await repo.insertCredit(
				"acc-1",
				"Account One",
				"2026-06-01",
				5_000_000,
				"manual",
				null,
				null,
				NOW,
			);
			await repo.insertCredit(
				"acc-1",
				"Account One",
				"2026-06-01",
				10_000_000,
				"manual",
				null,
				null,
				NOW + 1,
			);
			expect((await repo.findRecent(10)).length).toBe(2);
		});

		it("the same import_key twice yields one (updated) row", async () => {
			await repo.insertCredit(
				"acc-1",
				"Account One",
				"2026-06-01",
				5_000_000,
				"backfill",
				null,
				"seed:acc-1:1",
				NOW,
			);
			const second = await repo.insertCredit(
				"acc-1",
				"Account One",
				"2026-06-02",
				7_000_000,
				"backfill",
				"updated",
				"seed:acc-1:1",
				NOW + 1,
			);
			expect(second).toBe(true);

			const rows = await repo.findRecent(10);
			expect(rows.length).toBe(1);
			expect(rows[0]?.amount_usd_micros).toBe(7_000_000);
			expect(rows[0]?.notes).toBe("updated");
			expect(rows[0]?.paid_date).toBe("2026-06-02");
			expect(rows[0]?.paid_at_ms).toBe(new Date(2026, 5, 2).getTime());
		});
	});

	describe("softDelete", () => {
		it("returns false for an unknown or already-deleted id", async () => {
			expect(await repo.softDelete("nope")).toBe(false);
			await repo.recordAuto(
				"acc-1",
				"Account One",
				"2026-06-01",
				1_000_000,
				NOW,
			);
			const id = (await repo.findRecent(10))[0]?.id as string;
			expect(await repo.softDelete(id)).toBe(true);
			expect(await repo.softDelete(id)).toBe(false);
		});
	});

	describe("aggregation", () => {
		it("sumByKindInRange respects deleted_at and range bounds", async () => {
			// In range: one subscription + one credit.
			await repo.recordAuto("acc-1", "A", "2026-06-01", 20_000_000, NOW);
			await repo.insertCredit(
				"acc-1",
				"A",
				"2026-06-02",
				5_000_000,
				"manual",
				null,
				null,
				NOW,
			);
			// In range but soft-deleted: excluded.
			await repo.insertCredit(
				"acc-1",
				"A",
				"2026-06-03",
				99_000_000,
				"manual",
				null,
				null,
				NOW,
			);
			const deletedId = (await repo.findRecent(10)).find(
				(r) => r.amount_usd_micros === 99_000_000,
			)?.id as string;
			await repo.softDelete(deletedId);
			// Outside range (May): excluded.
			await repo.recordAuto("acc-1", "A", "2026-05-01", 20_000_000, NOW);
			// At the exclusive upper bound (July 1): excluded.
			await repo.recordAuto("acc-2", "B", "2026-07-01", 20_000_000, NOW);

			const from = new Date(2026, 5, 1).getTime();
			const to = new Date(2026, 6, 1).getTime();
			const sums = await repo.sumByKindInRange(from, to);
			const byKind = new Map(sums.map((s) => [s.kind, s.total_micros]));
			expect(byKind.get("subscription")).toBe(20_000_000);
			expect(byKind.get("credits")).toBe(5_000_000);
		});

		it("sumByAccountInRange groups non-deleted rows per account", async () => {
			await repo.recordAuto("acc-1", "A", "2026-06-01", 20_000_000, NOW);
			await repo.insertCredit(
				"acc-1",
				"A",
				"2026-06-02",
				5_000_000,
				"manual",
				null,
				null,
				NOW,
			);
			await repo.recordAuto("acc-2", "B", "2026-06-05", 17_000_000, NOW);

			const from = new Date(2026, 5, 1).getTime();
			const to = new Date(2026, 6, 1).getTime();
			const sums = await repo.sumByAccountInRange(from, to);
			const byAccount = new Map(
				sums.map((s) => [s.account_id, s.total_micros]),
			);
			expect(byAccount.get("acc-1")).toBe(25_000_000);
			expect(byAccount.get("acc-2")).toBe(17_000_000);
		});

		it("findInRange uses [from, to) bounds and hides deleted rows", async () => {
			await repo.recordAuto("acc-1", "A", "2026-06-01", 1_000_000, NOW);
			await repo.recordAuto("acc-1", "A", "2026-07-01", 1_000_000, NOW);
			const from = new Date(2026, 5, 1).getTime();
			const to = new Date(2026, 6, 1).getTime();
			const rows = await repo.findInRange(from, to);
			expect(rows.length).toBe(1);
			expect(rows[0]?.paid_date).toBe("2026-06-01");
		});
	});

	describe("latestSubscriptionDueDate", () => {
		it("returns the max paid_date INCLUDING soft-deleted rows", async () => {
			await repo.recordAuto("acc-1", "A", "2026-05-01", 1_000_000, NOW);
			await repo.recordAuto("acc-1", "A", "2026-06-01", 1_000_000, NOW);
			const latest = (await repo.findRecent(10)).find(
				(r) => r.paid_date === "2026-06-01",
			)?.id as string;
			await repo.softDelete(latest);

			expect(await repo.latestSubscriptionDueDate("acc-1")).toBe("2026-06-01");
		});

		it("ignores credit rows and other accounts", async () => {
			await repo.insertCredit(
				"acc-1",
				"A",
				"2026-06-08",
				1_000_000,
				"manual",
				null,
				null,
				NOW,
			);
			await repo.recordAuto("acc-2", "B", "2026-06-05", 1_000_000, NOW);
			expect(await repo.latestSubscriptionDueDate("acc-1")).toBeNull();
		});
	});

	describe("CHECK constraints", () => {
		it("rejects a bad kind", () => {
			expect(() =>
				db.run(
					`INSERT INTO account_payments (id, account_id, account_name, kind, paid_date, paid_at_ms, amount_usd_micros, recorded_at, source)
					 VALUES ('x', 'a', 'A', 'refund', '2026-06-01', 0, 1, 0, 'manual')`,
				),
			).toThrow();
		});

		it("rejects a bad source", () => {
			expect(() =>
				db.run(
					`INSERT INTO account_payments (id, account_id, account_name, kind, paid_date, paid_at_ms, amount_usd_micros, recorded_at, source)
					 VALUES ('x', 'a', 'A', 'credits', '2026-06-01', 0, 1, 0, 'guess')`,
				),
			).toThrow();
		});

		it("rejects a negative amount", () => {
			expect(() =>
				db.run(
					`INSERT INTO account_payments (id, account_id, account_name, kind, paid_date, paid_at_ms, amount_usd_micros, recorded_at, source)
					 VALUES ('x', 'a', 'A', 'credits', '2026-06-01', 0, -1, 0, 'manual')`,
				),
			).toThrow();
		});
	});
});
