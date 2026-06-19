import { describe, expect, it } from "bun:test";
import type { CacheKeepaliveWindowTotals } from "@clankermux/database";
import type { CacheEffectivenessResponse } from "@clankermux/types";
import {
	type AccountUsagePeak,
	buildCacheEffectiveness,
	createCacheEffectivenessHandlerFromSources,
	type WorkTotals,
} from "./cache-effectiveness-direct";

function totals(
	over: Partial<CacheKeepaliveWindowTotals> = {},
): CacheKeepaliveWindowTotals {
	return {
		keepalivesSent: 0,
		hits: 0,
		misses: 0,
		failures: 0,
		warmResumes: 0,
		spentUsd: 0,
		savedUsd: 0,
		savedUsd5m: 0,
		...over,
	};
}

const noWork: WorkTotals = {
	totalRequests: 0,
	inputTokens: 0,
	cacheReadTokens: 0,
	cacheCreationTokens: 0,
};

describe("buildCacheEffectiveness", () => {
	it("headlines the conservative net and hit rate from window totals", () => {
		const r = buildCacheEffectiveness(
			"7d",
			0,
			totals({
				hits: 6,
				misses: 2,
				warmResumes: 3,
				spentUsd: 1,
				savedUsd: 4,
				savedUsd5m: 2.4,
			}),
			[],
			noWork,
			[],
		);
		expect(r.hitRate).toBeCloseTo(0.75, 10);
		expect(r.warmResumes).toBe(3);
		expect(r.netUsd).toBeCloseTo(3, 10); // optimistic
		expect(r.netUsdConservative).toBeCloseTo(1.4, 10); // honest headline
		expect(r.savedUsdConservative).toBeCloseTo(2.4, 10);
	});

	it("maps per-account peaks, names them, and derives pool peaks (sorted by 7d desc)", () => {
		const peaks: AccountUsagePeak[] = [
			{ accountId: "a", peakFiveHourPct: 55, peakSevenDayPct: 40 },
			{ accountId: "b", peakFiveHourPct: 10, peakSevenDayPct: 80 },
		];
		const r = buildCacheEffectiveness("7d", 0, totals(), peaks, noWork, [
			{ id: "a", name: "Acct A" },
			{ id: "b", name: "Acct B" },
		]);
		expect(r.accounts[0].accountId).toBe("b"); // sorted by 7d peak desc
		expect(r.accounts[0].name).toBe("Acct B");
		expect(r.poolPeakFiveHourPct).toBe(55);
		expect(r.poolPeakSevenDayPct).toBe(80);
	});

	it("normalizes pool 7d peak per 1M prompt tokens of work", () => {
		const work: WorkTotals = {
			totalRequests: 100,
			inputTokens: 1_000_000,
			cacheReadTokens: 800_000,
			cacheCreationTokens: 200_000,
		};
		const r = buildCacheEffectiveness(
			"7d",
			0,
			totals(),
			[{ accountId: "a", peakFiveHourPct: 0, peakSevenDayPct: 50 }],
			work,
			[{ id: "a", name: "A" }],
		);
		expect(r.totalPromptTokens).toBe(2_000_000);
		expect(r.sevenDayPeakPer1MTokens).toBeCloseTo(25, 10); // 50 / 2.0M
	});

	it("normalizer is 0 when there are no prompt tokens", () => {
		const r = buildCacheEffectiveness(
			"7d",
			0,
			totals(),
			[{ accountId: "a", peakFiveHourPct: 0, peakSevenDayPct: 90 }],
			noWork,
			[{ id: "a", name: "A" }],
		);
		expect(r.sevenDayPeakPer1MTokens).toBe(0);
	});
});

describe("createCacheEffectivenessHandlerFromSources", () => {
	it("returns a 200 JSON response joining all sources", async () => {
		const handler = createCacheEffectivenessHandlerFromSources({
			getBridgeTotals: async () =>
				totals({ hits: 4, warmResumes: 2, savedUsd5m: 4, spentUsd: 1 }),
			getUsagePeaks: async () => [
				{ accountId: "a", peakFiveHourPct: 30, peakSevenDayPct: 60 },
			],
			getWorkTotals: async () => ({
				totalRequests: 10,
				inputTokens: 500_000,
				cacheReadTokens: 500_000,
				cacheCreationTokens: 0,
			}),
			getAllAccounts: async () => [{ id: "a", name: "A" }],
		});
		const res = await handler(new URLSearchParams({ range: "7d" }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as CacheEffectivenessResponse;
		expect(body.warmResumes).toBe(2);
		expect(body.netUsdConservative).toBeCloseTo(3, 10);
		expect(body.poolPeakSevenDayPct).toBe(60);
		expect(body.totalPromptTokens).toBe(1_000_000);
		expect(body.sevenDayPeakPer1MTokens).toBeCloseTo(60, 10);
	});
});
