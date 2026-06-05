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
				// t2: a=40/12, b reports nothing. b's 5h=80 is carried forward (its
				// reset is null, so the 5h fallback cap applies and t2 is well within
				// it) → avg5h=(40+80)/2=60 max5h=80; avg7d=12 max7d=12; count=2.
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

			// b's last 5h value (80) is carried into t2 instead of dropping out.
			const p2 = body.pool[1];
			expect(p2?.fiveHourAvg).toBe(60);
			expect(p2?.fiveHourMax).toBe(80);
			expect(p2?.sevenDayAvg).toBe(12);
			expect(p2?.sampledCount).toBe(2);
		});

		it("holds a maxed-out account's value in the pool until its window resets (no misleading drop)", async () => {
			// The reported bug: Main-me hits 100% and stops reporting; a still-active
			// peer keeps the buckets alive. Main-me must keep counting at 100% until
			// its 5h window resets — the pool must NOT drop the instant it maxes out.
			const t1 = 1_700_000_000_000;
			const t2 = t1 + HOUR;
			const t3 = t1 + 2 * HOUR;
			const fiveHourReset = t1 + 3 * HOUR; // Main-me's window resets after t3
			const snapshots: RankedSnapshot[] = [
				// t1: Main-me at 100% (reset in 3h), Peer at 20%.
				{
					accountId: "main",
					provider: "anthropic",
					ts: t1,
					fiveHourPct: 100,
					sevenDayPct: null,
					fiveHourReset,
					sevenDayReset: null,
				},
				{
					accountId: "peer",
					provider: "anthropic",
					ts: t1,
					fiveHourPct: 20,
					sevenDayPct: null,
					fiveHourReset: t1 + 5 * HOUR,
					sevenDayReset: null,
				},
				// t2 & t3: only Peer still reports (Main-me paused → no rows).
				{
					accountId: "peer",
					provider: "anthropic",
					ts: t2,
					fiveHourPct: 22,
					sevenDayPct: null,
					fiveHourReset: t1 + 5 * HOUR,
					sevenDayReset: null,
				},
				{
					accountId: "peer",
					provider: "anthropic",
					ts: t3,
					fiveHourPct: 24,
					sevenDayPct: null,
					fiveHourReset: t1 + 5 * HOUR,
					sevenDayReset: null,
				},
			];
			const dbOps = createDbOps({
				snapshots,
				accounts: [
					makeAccount("main", "Main-me", "anthropic"),
					makeAccount("peer", "Peer", "anthropic"),
				],
			});
			const { body } = await callHandler(dbOps, "24h");
			expect(body.pool.map((p) => p.ts)).toEqual([t1, t2, t3]);

			// t1: (100 + 20) / 2 = 60.
			expect(body.pool[0]?.fiveHourAvg).toBe(60);
			expect(body.pool[0]?.sampledCount).toBe(2);
			// t2/t3: Main-me carried at 100% → (100 + 22)/2 = 61, (100 + 24)/2 = 62.
			// Without carry-forward these would collapse to 22 and 24 (the bug).
			expect(body.pool[1]?.fiveHourAvg).toBe(61);
			expect(body.pool[1]?.sampledCount).toBe(2);
			expect(body.pool[2]?.fiveHourAvg).toBe(62);
			expect(body.pool[2]?.sampledCount).toBe(2);

			// Main-me's own series is also held flat at 100% across the gap.
			const main = body.series.find((s) => s.accountId === "main");
			expect(main?.points.map((p) => p.fiveHourPct)).toEqual([100, 100, 100]);
		});

		it("expires a carried value once its window reset passes", async () => {
			// Main-me maxes at t1 with a reset between t2 and t3. It carries through
			// t2 (still before reset) but drops out at t3 (reset has passed), and the
			// pool then reflects only the still-reporting peer.
			const t1 = 1_700_000_000_000;
			const t2 = t1 + HOUR;
			const t3 = t1 + 2 * HOUR;
			const fiveHourReset = t1 + 90 * 60 * 1000; // between t2 and t3
			const snapshots: RankedSnapshot[] = [
				{
					accountId: "main",
					provider: "anthropic",
					ts: t1,
					fiveHourPct: 100,
					sevenDayPct: null,
					fiveHourReset,
					sevenDayReset: null,
				},
				{
					accountId: "peer",
					provider: "anthropic",
					ts: t1,
					fiveHourPct: 20,
					sevenDayPct: null,
					fiveHourReset: t1 + 5 * HOUR,
					sevenDayReset: null,
				},
				{
					accountId: "peer",
					provider: "anthropic",
					ts: t2,
					fiveHourPct: 30,
					sevenDayPct: null,
					fiveHourReset: t1 + 5 * HOUR,
					sevenDayReset: null,
				},
				{
					accountId: "peer",
					provider: "anthropic",
					ts: t3,
					fiveHourPct: 40,
					sevenDayPct: null,
					fiveHourReset: t1 + 5 * HOUR,
					sevenDayReset: null,
				},
			];
			const dbOps = createDbOps({
				snapshots,
				accounts: [
					makeAccount("main", "Main-me", "anthropic"),
					makeAccount("peer", "Peer", "anthropic"),
				],
			});
			const { body } = await callHandler(dbOps, "24h");

			// t2: carried (100 + 30)/2 = 65, count 2.
			expect(body.pool[1]?.fiveHourAvg).toBe(65);
			expect(body.pool[1]?.sampledCount).toBe(2);
			// t3: Main-me's window has reset → it expires; pool is just Peer at 40.
			expect(body.pool[2]?.fiveHourAvg).toBe(40);
			expect(body.pool[2]?.sampledCount).toBe(1);

			// Main-me's series holds at 100% through t2, then ends (no t3 point).
			const main = body.series.find((s) => s.accountId === "main");
			expect(main?.points.map((p) => p.ts)).toEqual([t1, t2]);
			expect(main?.points.map((p) => p.fiveHourPct)).toEqual([100, 100]);
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
