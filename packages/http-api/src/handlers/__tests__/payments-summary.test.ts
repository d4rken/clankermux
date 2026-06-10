/**
 * Tests for GET /api/payments/summary. The requests-table scans run through the
 * shared read-only dashboard worker (kind "payments-summary"), mirroring
 * history-worker-isolation.test.ts: real temp DB, the thin main-thread wrapper,
 * assembly assertions on the PaymentsSummary shape.
 */
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@clankermux/database";
import type { PaymentsSummary } from "@clankermux/types";
import {
	clearAnalyticsCachesForTests,
	terminateAnalyticsWorker,
} from "../analytics-runner";
import {
	createPaymentCreateHandler,
	createPaymentsSummaryHandler,
} from "../payments";
import { makeContext } from "./dashboard-test-helpers";

const DAY = 86_400_000;

let tmpDir: string;
let dbOps: DatabaseOperations;

beforeEach(() => {
	clearAnalyticsCachesForTests();
	tmpDir = mkdtempSync(join(tmpdir(), "clankermux-pay-summary-"));
	dbOps = new DatabaseOperations(join(tmpDir, "test.db"));
});

afterEach(async () => {
	clearAnalyticsCachesForTests();
	await dbOps.dispose();
	rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
	terminateAnalyticsWorker();
});

/** Local "YYYY-MM-DD" of the day containing `ms`. */
function localDateOf(ms: number): string {
	const d = new Date(ms);
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${mm}-${dd}`;
}

async function insertAccount(id: string, name: string): Promise<void> {
	await dbOps.getAdapter().run(
		`INSERT INTO accounts (id, name, provider, refresh_token, created_at, priority)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[id, name, "anthropic", "tok", Date.now(), 0],
	);
}

async function insertRequest(
	id: string,
	timestamp: number,
	accountId: string | null,
	costUsd: number,
	billingType: string | null,
): Promise<void> {
	await dbOps.getAdapter().run(
		`INSERT INTO requests (
			id, timestamp, method, path, account_used, status_code, success,
			response_time_ms, failover_attempts, model, total_tokens, cost_usd,
			billing_type
		) VALUES (?, ?, 'POST', '/v1/messages', ?, 200, 1, 100, 0, 'claude-test', 10, ?, ?)`,
		[id, timestamp, accountId, costUsd, billingType],
	);
}

/** Fetch the summary fresh (the runner caches worker responses for ~10s). */
async function fetchSummary(
	params: Record<string, string> = {},
): Promise<{ response: Response; data: PaymentsSummary }> {
	clearAnalyticsCachesForTests();
	const handler = createPaymentsSummaryHandler(makeContext(dbOps));
	const response = await handler(new URLSearchParams(params));
	const data = (await response.json()) as PaymentsSummary;
	return { response, data };
}

describe("GET /api/payments/summary", () => {
	it("returns an empty-state summary with the now-30d fallback range for range=all", async () => {
		const before = Date.now();
		const { response, data } = await fetchSummary({ range: "all" });
		const after = Date.now();

		expect(response.status).toBe(200);
		expect(data.amortizedMonthlyUsd).toBe(0);
		expect(data.amortizedDailyUsd).toBe(0);
		expect(data.amortizedWeeklyUsd).toBe(0);
		expect(data.currentMonth.ledgerUsd).toBe(0);
		expect(data.currentMonth.totalUsd).toBe(0);
		expect(data.range.ledgerUsd).toBe(0);
		expect(data.range.tokenCostUsd).toBe(0);
		expect(data.range.valueRatio).toBeNull();
		expect(data.range.from).toBeGreaterThanOrEqual(before - 30 * DAY);
		expect(data.range.from).toBeLessThanOrEqual(after - 30 * DAY);
		expect(data.perAccount).toEqual([]);
		expect(data.recentPayments).toEqual([]);
	});

	it("computes token-billed vs plan vs overage splits and the full per-window math", async () => {
		const now = Date.now();
		const recent = now - 30_000;
		await insertAccount("acct-a", "Alpha");
		await insertAccount("acct-b", "Beta");

		// Alpha: $30/month subscription with a price → amortization basis.
		await dbOps.setAccountRenewal(
			"acct-a",
			localDateOf(now),
			"monthly",
			30_000_000,
			localDateOf(now),
		);

		// Requests: plan excluded from token cost; api/overage/NULL included.
		await insertRequest("r-plan", recent, "acct-a", 1.0, "plan");
		await insertRequest("r-api", recent, "acct-b", 0.2, "api");
		await insertRequest("r-overage", recent, "acct-b", 0.3, "overage");
		await insertRequest("r-null", recent, "acct-b", 0.4, null);

		// Ledger: Alpha sub today, Beta credits today, plus an old sub 45d back
		// (outside both the 30d range and the current month).
		const today = localDateOf(now);
		await dbOps.recordAutoPayment("acct-a", "Alpha", today, 30_000_000);
		await dbOps.insertCreditPayment(
			"acct-b",
			"Beta",
			today,
			50_000_000,
			"manual",
			null,
			null,
		);
		await dbOps.upsertSubscriptionPayment(
			"acct-a",
			"Alpha",
			localDateOf(now - 45 * DAY),
			30_000_000,
			"backfill",
			null,
		);

		const { response, data } = await fetchSummary({ range: "30d" });
		expect(response.status).toBe(200);

		// Amortization: one monthly $30 price.
		expect(data.amortizedMonthlyUsd).toBeCloseTo(30, 6);
		expect(data.amortizedDailyUsd).toBeCloseTo(1, 6);
		expect(data.amortizedWeeklyUsd).toBeCloseTo(7, 6);

		// Current month: only today's payments + today's token-billed requests.
		expect(data.currentMonth.subscriptionUsd).toBeCloseTo(30, 6);
		expect(data.currentMonth.creditsUsd).toBeCloseTo(50, 6);
		expect(data.currentMonth.ledgerUsd).toBeCloseTo(80, 6);
		expect(data.currentMonth.tokenCostUsd).toBeCloseTo(0.9, 6);
		expect(data.currentMonth.totalUsd).toBeCloseTo(80.9, 6);

		// 30d range: 45d-old subscription excluded.
		expect(data.range.days).toBeCloseTo(30, 3);
		expect(data.range.subscriptionUsd).toBeCloseTo(30, 6);
		expect(data.range.creditsUsd).toBeCloseTo(50, 6);
		expect(data.range.ledgerUsd).toBeCloseTo(80, 6);
		expect(data.range.tokenCostUsd).toBeCloseTo(0.9, 6);
		expect(data.range.totalUsd).toBeCloseTo(80.9, 6);
		expect(data.range.amortizedUsd).toBeCloseTo(30, 3);
		expect(data.range.planValueUsd).toBeCloseTo(1.0, 6);
		expect(data.range.valueRatio).toBeCloseTo(1.0 / 30, 4);
		expect(data.range.overageTokenCostUsd).toBeCloseTo(0.3, 6);

		// Per-account: Alpha via price, Beta via ledger rows.
		const alpha = data.perAccount.find((a) => a.accountId === "acct-a");
		expect(alpha).toBeDefined();
		expect(alpha?.accountName).toBe("Alpha");
		expect(alpha?.priceUsd).toBe(30);
		expect(alpha?.cadence).toBe("monthly");
		expect(alpha?.nextDueDate).toBe(today);
		expect(alpha?.amortizedMonthlyUsd).toBeCloseTo(30, 6);
		expect(alpha?.rangeLedgerUsd).toBeCloseTo(30, 6);
		// Alpha's only request is plan-billed → excluded from token cost.
		expect(alpha?.rangeTokenCostUsd).toBeCloseTo(0, 6);

		const beta = data.perAccount.find((a) => a.accountId === "acct-b");
		expect(beta).toBeDefined();
		expect(beta?.priceUsd).toBeNull();
		expect(beta?.cadence).toBeNull();
		expect(beta?.nextDueDate).toBeNull();
		expect(beta?.amortizedMonthlyUsd).toBe(0);
		expect(beta?.rangeLedgerUsd).toBeCloseTo(50, 6);
		expect(beta?.rangeTokenCostUsd).toBeCloseTo(0.9, 6);

		// Recent payments: all three non-deleted ledger rows, USD floats.
		expect(data.recentPayments).toHaveLength(3);
		expect(
			data.recentPayments.find((p) => p.kind === "credits")?.amountUsd,
		).toBe(50);
	});

	it("amortizes yearly prices at price/12 per month", async () => {
		const now = Date.now();
		await insertAccount("acct-y", "Yearly");
		await dbOps.setAccountRenewal(
			"acct-y",
			localDateOf(now),
			"yearly",
			120_000_000,
			localDateOf(now),
		);

		const { data } = await fetchSummary({ range: "30d" });
		expect(data.amortizedMonthlyUsd).toBeCloseTo(10, 6);
		expect(data.amortizedDailyUsd).toBeCloseTo(10 / 30, 6);
	});

	it("surfaces ledger rows whose account no longer exists with the snapshotted name", async () => {
		const now = Date.now();
		await dbOps.insertCreditPayment(
			"ghost-id",
			"Ghost",
			localDateOf(now),
			10_000_000,
			"manual",
			null,
			null,
		);

		const { data } = await fetchSummary({ range: "30d" });
		const ghost = data.perAccount.find((a) => a.accountId === "ghost-id");
		expect(ghost).toBeDefined();
		expect(ghost?.accountName).toBe("Ghost");
		expect(ghost?.priceUsd).toBeNull();
		expect(ghost?.rangeLedgerUsd).toBeCloseTo(10, 6);
		expect(ghost?.rangeTokenCostUsd).toBe(0);
	});

	it("excludes soft-deleted payments everywhere", async () => {
		const now = Date.now();
		await insertAccount("acct-a", "Alpha");
		const today = localDateOf(now);
		await dbOps.insertCreditPayment(
			"acct-a",
			"Alpha",
			today,
			99_000_000,
			"manual",
			null,
			null,
		);
		const row = await dbOps
			.getAdapter()
			.get<{ id: string }>("SELECT id FROM account_payments LIMIT 1", []);
		expect(row).toBeDefined();
		await dbOps.softDeletePayment(row?.id as string);

		const { data } = await fetchSummary({ range: "30d" });
		expect(data.currentMonth.ledgerUsd).toBe(0);
		expect(data.range.ledgerUsd).toBe(0);
		expect(data.recentPayments).toEqual([]);
		expect(data.perAccount).toEqual([]);
	});

	it("derives the range=all window start from the earliest request/payment", async () => {
		const now = Date.now();
		const oldTs = now - 60 * DAY;
		await insertAccount("acct-a", "Alpha");
		await insertRequest("r-old", oldTs, "acct-a", 0.5, "api");
		await dbOps.recordAutoPayment(
			"acct-a",
			"Alpha",
			localDateOf(now - 45 * DAY),
			30_000_000,
		);

		const { data } = await fetchSummary({ range: "all" });
		expect(data.range.from).toBe(oldTs);
		expect(data.range.days).toBeCloseTo(60, 1);
		// 45d-old payment now in range.
		expect(data.range.subscriptionUsd).toBeCloseTo(30, 6);
		expect(data.range.tokenCostUsd).toBeCloseTo(0.5, 6);
	});

	it("returns valueRatio null when no account has a price", async () => {
		const now = Date.now();
		await insertAccount("acct-a", "Alpha");
		await insertRequest("r-plan", now - 30_000, "acct-a", 1.0, "plan");

		const { data } = await fetchSummary({ range: "30d" });
		expect(data.amortizedMonthlyUsd).toBe(0);
		expect(data.range.planValueUsd).toBeCloseTo(1.0, 6);
		expect(data.range.valueRatio).toBeNull();
	});

	it("defaults to range=30d and serves through the dashboard worker", async () => {
		const { response, data } = await fetchSummary();
		expect(response.status).toBe(200);
		expect(response.headers.get("x-clankermux-analytics-mode")).toBe("worker");
		expect(data.range.to - data.range.from).toBeCloseTo(30 * DAY, -4);
	});

	it("reflects a new payment immediately after creation (runner cache invalidated)", async () => {
		const now = Date.now();
		await insertAccount("acct-a", "Alpha");

		// Prime the runner's response cache with the pre-mutation summary.
		// (No clearAnalyticsCachesForTests between requests in this test — that
		// is the point.)
		const summaryHandler = createPaymentsSummaryHandler(makeContext(dbOps));
		const primeParams = new URLSearchParams({ range: "30d" });
		const primed = await summaryHandler(primeParams);
		expect(primed.status).toBe(200);
		const primedData = (await primed.json()) as PaymentsSummary;
		expect(primedData.range.ledgerUsd).toBe(0);

		// Write through the mutation handler — must invalidate "payments-summary".
		const createHandler = createPaymentCreateHandler(dbOps);
		const created = await createHandler(
			new Request("http://localhost/api/payments", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					accountId: "acct-a",
					kind: "credits",
					paidDate: localDateOf(now),
					amountUsd: 10,
				}),
			}),
		);
		expect(created.status).toBe(201);

		// Same params, well within the 10s TTL: without invalidation this would
		// serve the cached pre-mutation body ("worker-cache" mode, ledgerUsd 0).
		const after = await summaryHandler(primeParams);
		expect(after.status).toBe(200);
		expect(after.headers.get("x-clankermux-analytics-mode")).toBe("worker");
		const afterData = (await after.json()) as PaymentsSummary;
		expect(afterData.range.ledgerUsd).toBeCloseTo(10, 6);
		expect(afterData.range.creditsUsd).toBeCloseTo(10, 6);
		expect(afterData.recentPayments).toHaveLength(1);
	});
});
