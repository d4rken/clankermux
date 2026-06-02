import { describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import type {
	Account,
	RankedSnapshot,
	UsageHistoryResponse,
} from "@clankermux/types";
import { createUsageHistoryHandler } from "../usage-history";

const HOUR = 60 * 60 * 1000;

function makeAccount(id: string, name: string, provider: string): Account {
	return { id, name, provider } as Account;
}

/**
 * Build a mock DatabaseOperations exposing only the two methods the handler
 * uses. `captureOpts` lets a test assert the {sinceMs, bucketMs} the handler
 * derived from the range.
 */
function createDbOps(opts: {
	snapshots: RankedSnapshot[];
	accounts: Account[];
	captureOpts?: (o: { sinceMs: number; bucketMs: number }) => void;
}): DatabaseOperations {
	return {
		getUsageSnapshots: async (o: { sinceMs: number; bucketMs: number }) => {
			opts.captureOpts?.(o);
			return opts.snapshots;
		},
		getAllAccounts: async () => opts.accounts,
	} as unknown as DatabaseOperations;
}

async function callHandler(
	dbOps: DatabaseOperations,
	range?: string,
): Promise<{ status: number; body: UsageHistoryResponse }> {
	const handler = createUsageHistoryHandler(dbOps);
	const params = new URLSearchParams();
	if (range !== undefined) params.set("range", range);
	const res = await handler(params);
	return {
		status: res.status,
		body: (await res.json()) as UsageHistoryResponse,
	};
}

describe("usage-history handler", () => {
	describe("range → bucket mapping", () => {
		it("maps 6h → bucketMs 300000", async () => {
			let captured: { sinceMs: number; bucketMs: number } | null = null;
			const dbOps = createDbOps({
				snapshots: [],
				accounts: [],
				captureOpts: (o) => {
					captured = o;
				},
			});
			const { body } = await callHandler(dbOps, "6h");
			expect(captured?.bucketMs).toBe(300_000);
			expect(body.bucketMs).toBe(300_000);
			expect(body.range).toBe("6h");
		});

		it("maps 1h → bucketMs 60000", async () => {
			let captured: { sinceMs: number; bucketMs: number } | null = null;
			const dbOps = createDbOps({
				snapshots: [],
				accounts: [],
				captureOpts: (o) => {
					captured = o;
				},
			});
			const { body } = await callHandler(dbOps, "1h");
			expect(captured?.bucketMs).toBe(60_000);
			expect(body.bucketMs).toBe(60_000);
		});

		it("defaults to 7d (bucketMs 3600000) when range omitted", async () => {
			let captured: { sinceMs: number; bucketMs: number } | null = null;
			const dbOps = createDbOps({
				snapshots: [],
				accounts: [],
				captureOpts: (o) => {
					captured = o;
				},
			});
			const { body } = await callHandler(dbOps);
			expect(body.range).toBe("7d");
			expect(captured?.bucketMs).toBe(3_600_000);
		});

		it("falls back to the 7d default for an invalid range", async () => {
			let captured: { sinceMs: number; bucketMs: number } | null = null;
			const dbOps = createDbOps({
				snapshots: [],
				accounts: [],
				captureOpts: (o) => {
					captured = o;
				},
			});
			const { body } = await callHandler(dbOps, "bogus");
			expect(body.range).toBe("7d");
			expect(captured?.bucketMs).toBe(3_600_000);
		});

		it("computes sinceMs as now - windowMs for the range", async () => {
			let captured: { sinceMs: number; bucketMs: number } | null = null;
			const dbOps = createDbOps({
				snapshots: [],
				accounts: [],
				captureOpts: (o) => {
					captured = o;
				},
			});
			const before = Date.now();
			await callHandler(dbOps, "24h");
			const after = Date.now();
			const day = 24 * HOUR;
			expect(captured?.sinceMs).toBeGreaterThanOrEqual(before - day);
			expect(captured?.sinceMs).toBeLessThanOrEqual(after - day);
		});
	});

	describe("series grouping", () => {
		it("groups rows by account, resolves names, sorts points by ts", async () => {
			const t1 = 1_700_000_000_000;
			const t2 = t1 + HOUR;
			// Intentionally out-of-order ts to confirm the handler sorts points.
			const snapshots: RankedSnapshot[] = [
				{
					accountId: "a",
					provider: "anthropic",
					ts: t2,
					fiveHourPct: 40,
					sevenDayPct: 12,
					fiveHourReset: null,
					sevenDayReset: null,
				},
				{
					accountId: "a",
					provider: "anthropic",
					ts: t1,
					fiveHourPct: 20,
					sevenDayPct: 10,
					fiveHourReset: null,
					sevenDayReset: null,
				},
				{
					accountId: "b",
					provider: "codex",
					ts: t1,
					fiveHourPct: 80,
					sevenDayPct: null,
					fiveHourReset: null,
					sevenDayReset: null,
				},
			];
			const dbOps = createDbOps({
				snapshots,
				accounts: [
					makeAccount("a", "Alpha", "anthropic"),
					makeAccount("b", "Beta", "codex"),
				],
			});
			const { body } = await callHandler(dbOps, "24h");
			expect(body.series).toHaveLength(2);

			const a = body.series.find((s) => s.accountId === "a");
			expect(a?.name).toBe("Alpha");
			expect(a?.provider).toBe("anthropic");
			expect(a?.points.map((p) => p.ts)).toEqual([t1, t2]);
			expect(a?.points.map((p) => p.fiveHourPct)).toEqual([20, 40]);

			const b = body.series.find((s) => s.accountId === "b");
			expect(b?.name).toBe("Beta");
			expect(b?.points[0]?.sevenDayPct).toBeNull();
		});

		it("falls back to the accountId when the account is missing", async () => {
			const t1 = 1_700_000_000_000;
			const snapshots: RankedSnapshot[] = [
				{
					accountId: "ghost",
					provider: "codex",
					ts: t1,
					fiveHourPct: 5,
					sevenDayPct: null,
					fiveHourReset: null,
					sevenDayReset: null,
				},
			];
			const dbOps = createDbOps({ snapshots, accounts: [] });
			const { body } = await callHandler(dbOps, "24h");
			expect(body.series).toHaveLength(1);
			expect(body.series[0]?.name).toBe("ghost");
			expect(body.series[0]?.provider).toBe("codex");
		});
	});

	describe("pool aggregation", () => {
		it("averages and maxes non-null values, counts contributors, sorts by ts", async () => {
			const t1 = 1_700_000_000_000;
			const t2 = t1 + HOUR;
			const snapshots: RankedSnapshot[] = [
				// t1: a=20/10, b=80/null → avg5h=50 max5h=80; avg7d=10 max7d=10; count=2
				{
					accountId: "a",
					provider: "anthropic",
					ts: t1,
					fiveHourPct: 20,
					sevenDayPct: 10,
					fiveHourReset: null,
					sevenDayReset: null,
				},
				{
					accountId: "b",
					provider: "codex",
					ts: t1,
					fiveHourPct: 80,
					sevenDayPct: null,
					fiveHourReset: null,
					sevenDayReset: null,
				},
				// t2: a=40/12, b=null/null → avg5h=40 max5h=40; avg7d=12 max7d=12; count=1
				{
					accountId: "a",
					provider: "anthropic",
					ts: t2,
					fiveHourPct: 40,
					sevenDayPct: 12,
					fiveHourReset: null,
					sevenDayReset: null,
				},
				{
					accountId: "b",
					provider: "codex",
					ts: t2,
					fiveHourPct: null,
					sevenDayPct: null,
					fiveHourReset: null,
					sevenDayReset: null,
				},
			];
			const dbOps = createDbOps({
				snapshots,
				accounts: [
					makeAccount("a", "Alpha", "anthropic"),
					makeAccount("b", "Beta", "codex"),
				],
			});
			const { body } = await callHandler(dbOps, "24h");
			expect(body.pool.map((p) => p.ts)).toEqual([t1, t2]);

			const p1 = body.pool[0];
			expect(p1?.fiveHourAvg).toBe(50);
			expect(p1?.fiveHourMax).toBe(80);
			expect(p1?.sevenDayAvg).toBe(10);
			expect(p1?.sevenDayMax).toBe(10);
			expect(p1?.sampledCount).toBe(2);

			const p2 = body.pool[1];
			expect(p2?.fiveHourAvg).toBe(40);
			expect(p2?.fiveHourMax).toBe(40);
			expect(p2?.sevenDayAvg).toBe(12);
			expect(p2?.sampledCount).toBe(1);
		});

		it("yields null avg/max when every account is null at a ts", async () => {
			const t1 = 1_700_000_000_000;
			const snapshots: RankedSnapshot[] = [
				{
					accountId: "a",
					provider: "anthropic",
					ts: t1,
					fiveHourPct: null,
					sevenDayPct: null,
					fiveHourReset: null,
					sevenDayReset: null,
				},
				{
					accountId: "b",
					provider: "codex",
					ts: t1,
					fiveHourPct: null,
					sevenDayPct: null,
					fiveHourReset: null,
					sevenDayReset: null,
				},
			];
			const dbOps = createDbOps({
				snapshots,
				accounts: [
					makeAccount("a", "Alpha", "anthropic"),
					makeAccount("b", "Beta", "codex"),
				],
			});
			const { body } = await callHandler(dbOps, "24h");
			expect(body.pool).toHaveLength(1);
			const p = body.pool[0];
			expect(p?.fiveHourAvg).toBeNull();
			expect(p?.fiveHourMax).toBeNull();
			expect(p?.sevenDayAvg).toBeNull();
			expect(p?.sevenDayMax).toBeNull();
			expect(p?.sampledCount).toBe(0);
		});
	});
});
