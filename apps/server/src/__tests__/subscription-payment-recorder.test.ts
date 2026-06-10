/**
 * Tests for SubscriptionPaymentRecorder — the periodic job that books each
 * subscription account's renewal due dates into the `account_payments` ledger.
 *
 * Uses a REAL temp-file sqlite DB through the DatabaseOperations facade (the
 * exact surface server.ts wires in), so the partial unique index that makes
 * `recordAutoPayment` idempotent — and lets a soft-deleted tombstone suppress
 * re-inserts — is exercised exactly as deployed. The clock is injected.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency. Same pattern as account-payment.repository.test.ts.
import "@clankermux/core";
import { DatabaseOperations } from "@clankermux/database";
import type { AccountPaymentRow } from "@clankermux/types";
import {
	type AccountRenewalConfig,
	SubscriptionPaymentRecorder,
	type SubscriptionPaymentRecorderDeps,
} from "../subscription-payment-recorder";

/** Local noon, 2026-06-09 — fixed deterministic "today" for the injected clock. */
const TODAY = new Date(2026, 5, 9, 12).getTime();
const TODAY_STR = "2026-06-09";

function tempDbPath(): string {
	return join(
		tmpdir(),
		`test-payment-recorder-${randomBytes(6).toString("hex")}.db`,
	);
}

describe("SubscriptionPaymentRecorder", () => {
	let dbOps: DatabaseOperations;
	let dbPath: string;
	let nowMs: number;

	beforeEach(() => {
		dbPath = tempDbPath();
		dbOps = new DatabaseOperations(dbPath);
		nowMs = TODAY;
	});

	afterEach(() => {
		dbOps.dispose?.();
		for (const suffix of ["", "-wal", "-shm"]) {
			rmSync(`${dbPath}${suffix}`, { force: true });
		}
	});

	function makeRecorder(
		overrides?: Partial<SubscriptionPaymentRecorderDeps>,
	): SubscriptionPaymentRecorder {
		return new SubscriptionPaymentRecorder({
			getRenewalConfigs: () => dbOps.getAccountRenewalConfigs(),
			recordPayment: (accountId, accountName, dueDate, amountUsdMicros, now) =>
				dbOps.recordAutoPayment(
					accountId,
					accountName,
					dueDate,
					amountUsdMicros,
					now,
				),
			now: () => nowMs,
			...overrides,
		});
	}

	async function seedAccount(
		id: string,
		opts: {
			anchor?: string | null;
			cadence?: string | null;
			price?: number | null;
			autoStart?: string | null;
			paused?: boolean;
		} = {},
	): Promise<void> {
		await dbOps.getAdapter().run(
			`INSERT INTO accounts (id, name, provider, created_at, paused,
					renewal_anchor, renewal_cadence, renewal_price_usd_micros, renewal_auto_start_date)
				 VALUES (?, ?, 'anthropic', ?, ?, ?, ?, ?, ?)`,
			[
				id,
				id,
				TODAY,
				opts.paused ? 1 : 0,
				opts.anchor ?? null,
				opts.cadence ?? null,
				opts.price ?? null,
				opts.autoStart ?? null,
			],
		);
	}

	/** Non-deleted ledger rows for one account, oldest paid_date first. */
	async function paymentsFor(accountId: string): Promise<AccountPaymentRow[]> {
		const rows = await dbOps.getRecentPayments(100);
		return rows
			.filter((r) => r.account_id === accountId)
			.sort((a, b) => a.paid_date.localeCompare(b.paid_date));
	}

	it("first tick inserts only due dates >= auto_start_date, never anchor-era history", async () => {
		// Anchor is 24 monthly occurrences in the past; price configured "today"
		// with auto_start_date = today, so history must NOT be invented.
		await seedAccount("acc-1", {
			anchor: "2024-06-09",
			cadence: "monthly",
			price: 20_000_000,
			autoStart: TODAY_STR,
		});

		await makeRecorder().tick();

		const rows = await paymentsFor("acc-1");
		expect(rows.map((r) => r.paid_date)).toEqual([TODAY_STR]);
		expect(rows[0]?.kind).toBe("subscription");
		expect(rows[0]?.source).toBe("auto");
		expect(rows[0]?.amount_usd_micros).toBe(20_000_000);
	});

	it("inserts every occurrence between auto_start_date and now", async () => {
		await seedAccount("acc-1", {
			anchor: "2024-06-15",
			cadence: "monthly",
			price: 20_000_000,
			autoStart: "2026-04-01",
		});

		await makeRecorder().tick();

		const rows = await paymentsFor("acc-1");
		expect(rows.map((r) => r.paid_date)).toEqual(["2026-04-15", "2026-05-15"]);
	});

	it("is idempotent — a second tick inserts 0 rows", async () => {
		await seedAccount("acc-1", {
			anchor: "2024-06-09",
			cadence: "monthly",
			price: 20_000_000,
			autoStart: TODAY_STR,
		});
		const recorder = makeRecorder();

		await recorder.tick();
		await recorder.tick();

		const rows = await paymentsFor("acc-1");
		expect(rows).toHaveLength(1);
	});

	it("catches up after downtime — 3 months later, exactly the 3 missed rows", async () => {
		await seedAccount("acc-1", {
			anchor: "2024-06-09",
			cadence: "monthly",
			price: 20_000_000,
			autoStart: TODAY_STR,
		});
		const recorder = makeRecorder();
		await recorder.tick();
		expect(await paymentsFor("acc-1")).toHaveLength(1);

		// Simulate 3 months of downtime, then one catch-up tick.
		nowMs = new Date(2026, 8, 9, 12).getTime(); // 2026-09-09 local noon
		await recorder.tick();

		const rows = await paymentsFor("acc-1");
		expect(rows.map((r) => r.paid_date)).toEqual([
			TODAY_STR,
			"2026-07-09",
			"2026-08-09",
			"2026-09-09",
		]);
	});

	it("does not re-insert a soft-deleted (tombstoned) auto row", async () => {
		await seedAccount("acc-1", {
			anchor: "2024-06-09",
			cadence: "monthly",
			price: 20_000_000,
			autoStart: TODAY_STR,
		});
		const recorder = makeRecorder();
		await recorder.tick();

		const [row] = await paymentsFor("acc-1");
		expect(row).toBeDefined();
		expect(await dbOps.softDeletePayment(row?.id as string)).toBe(true);

		await recorder.tick();

		// Tombstone suppresses the re-insert: no visible rows, but the due date
		// still counts as handled.
		expect(await paymentsFor("acc-1")).toHaveLength(0);
		expect(await dbOps.latestSubscriptionPaymentDueDate("acc-1")).toBe(
			TODAY_STR,
		);
	});

	it("skips no-price / cadence-none / no-anchor accounts, but NOT paused ones", async () => {
		const base = {
			anchor: "2024-06-09",
			cadence: "monthly",
			price: 20_000_000,
			autoStart: TODAY_STR,
		};
		await seedAccount("no-price", { ...base, price: null });
		await seedAccount("zero-price", { ...base, price: 0 });
		await seedAccount("cadence-none", { ...base, cadence: "none" });
		await seedAccount("no-anchor", { ...base, anchor: null });
		// A paused subscription still costs money — it must be recorded.
		await seedAccount("paused-with-price", { ...base, paused: true });

		await makeRecorder().tick();

		expect(await paymentsFor("no-price")).toHaveLength(0);
		expect(await paymentsFor("zero-price")).toHaveLength(0);
		expect(await paymentsFor("cadence-none")).toHaveLength(0);
		expect(await paymentsFor("no-anchor")).toHaveLength(0);

		const paused = await paymentsFor("paused-with-price");
		expect(paused.map((r) => r.paid_date)).toEqual([TODAY_STR]);
	});

	it("falls back to today when auto_start_date is null (defensive: no invented history)", async () => {
		await seedAccount("acc-1", {
			anchor: "2024-06-09",
			cadence: "monthly",
			price: 20_000_000,
			autoStart: null,
		});

		await makeRecorder().tick();

		// Only today's occurrence — none of the 24 historical ones.
		const rows = await paymentsFor("acc-1");
		expect(rows.map((r) => r.paid_date)).toEqual([TODAY_STR]);
	});

	it("falls back to today when auto_start_date is malformed (no anchor-era backfill)", async () => {
		// computeAllDueDates treats an unparseable fromDate as "no lower bound",
		// so without validation a corrupted stored value would book all 24
		// historical occurrences back to the anchor.
		await seedAccount("acc-1", {
			anchor: "2024-06-09",
			cadence: "monthly",
			price: 20_000_000,
			autoStart: "garbage",
		});

		await makeRecorder().tick();

		const rows = await paymentsFor("acc-1");
		expect(rows.map((r) => r.paid_date)).toEqual([TODAY_STR]);
	});

	it("isolates per-account errors — one failing account doesn't block the others", async () => {
		const cfg = (id: string): AccountRenewalConfig => ({
			id,
			name: id,
			renewal_anchor: "2024-06-09",
			renewal_cadence: "monthly",
			renewal_price_usd_micros: 20_000_000,
			renewal_auto_start_date: TODAY_STR,
			paused: 0,
		});
		const recorded: Array<{ accountId: string; dueDate: string }> = [];
		const recorder = new SubscriptionPaymentRecorder({
			getRenewalConfigs: async () => [cfg("bad"), cfg("good")],
			recordPayment: async (accountId, _accountName, dueDate) => {
				if (accountId === "bad") throw new Error("boom");
				recorded.push({ accountId, dueDate });
				return true;
			},
			now: () => nowMs,
		});

		// Must not throw, and the healthy account must still be recorded.
		await recorder.tick();

		expect(recorded).toEqual([{ accountId: "good", dueDate: TODAY_STR }]);
	});

	it("records the price at tick time — a price change affects only future rows", async () => {
		await seedAccount("acc-1", {
			anchor: "2024-06-09",
			cadence: "monthly",
			price: 20_000_000,
			autoStart: TODAY_STR,
		});
		const recorder = makeRecorder();
		await recorder.tick();

		// Operator raises the price; one month later the next renewal falls due.
		await dbOps.setAccountRenewal(
			"acc-1",
			"2024-06-09",
			"monthly",
			25_000_000,
			TODAY_STR,
		);
		nowMs = new Date(2026, 6, 9, 12).getTime(); // 2026-07-09 local noon
		await recorder.tick();

		const rows = await paymentsFor("acc-1");
		expect(rows.map((r) => [r.paid_date, r.amount_usd_micros])).toEqual([
			[TODAY_STR, 20_000_000],
			["2026-07-09", 25_000_000],
		]);
	});
});
