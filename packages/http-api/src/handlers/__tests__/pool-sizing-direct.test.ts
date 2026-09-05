/**
 * The `/api/analytics/pool-sizing` read, through its sources seam.
 *
 * The shaping itself is covered exhaustively by the core suite
 * (packages/core/src/__tests__/pool-sizing.test.ts); what belongs here is what
 * the handler alone decides: the fixed lookback every read is asked for, the
 * reserve percentage the add signal fires at, and the failure mapping.
 */
import { describe, expect, it } from "bun:test";
import {
	POOL_SIZING_LOOKBACK_MS,
	type PoolSizingBurstTickRow,
	type PoolSizingPresenceRow,
	type PoolSizingResetPeakRow,
	type PoolSizingScopedPresenceRow,
	type PoolSizingScopedResetPeakRow,
	type PoolSizingStopRow,
} from "@clankermux/core";
import {
	POOL_SIZING_REJECTED_ATTEMPT_LABELS,
	POOL_SIZING_SEPARATE_STOP_LABELS,
	POOL_SIZING_TERMINAL_STOP_LABELS,
	type PoolSizingResponse,
} from "@clankermux/types";
import {
	createPoolSizingHandlerFromSources,
	type PoolSizingSources,
} from "../pool-sizing-direct";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 5, 12);
const RESET = Date.UTC(2026, 7, 23, 7);

interface Recorded {
	resetPeaks: number[];
	scopedResetPeaks: number[];
	presence: number[];
	scopedPresence: number[];
	burst: number[];
	stops: Array<{ sinceMs: number; labels: readonly string[] }>;
}

function makeSources(overrides: Partial<PoolSizingSources> = {}): {
	sources: PoolSizingSources;
	recorded: Recorded;
} {
	const recorded: Recorded = {
		resetPeaks: [],
		scopedResetPeaks: [],
		presence: [],
		scopedPresence: [],
		burst: [],
		stops: [],
	};
	const sources: PoolSizingSources = {
		getResetPeakRows: async (sinceMs) => {
			recorded.resetPeaks.push(sinceMs);
			return [
				{
					accountId: "acct-1",
					resetAt: RESET,
					peakPct: 90,
					sampleCount: 200,
					firstSampledAt: RESET - 6 * DAY,
					lastSampledAt: RESET - 5 * MINUTE,
					firstPct: 0,
					lastPct: 90,
					planTier: "max",
					rateLimitTier: "20x",
				},
			] satisfies PoolSizingResetPeakRow[];
		},
		getScopedResetPeakRows: async (sinceMs) => {
			recorded.scopedResetPeaks.push(sinceMs);
			return [] satisfies PoolSizingScopedResetPeakRow[];
		},
		getDailyPresence: async (sinceMs) => {
			recorded.presence.push(sinceMs);
			return [] satisfies PoolSizingPresenceRow[];
		},
		getScopedDailyPresence: async (sinceMs) => {
			recorded.scopedPresence.push(sinceMs);
			return [] satisfies PoolSizingScopedPresenceRow[];
		},
		getFiveHourSpentTicks: async (sinceMs) => {
			recorded.burst.push(sinceMs);
			return [] satisfies PoolSizingBurstTickRow[];
		},
		getStopRows: async (sinceMs, labels) => {
			recorded.stops.push({ sinceMs, labels });
			return [] satisfies PoolSizingStopRow[];
		},
		getAllAccounts: async () => [
			{
				id: "acct-1",
				name: "Alpha",
				provider: "anthropic",
				created_at: NOW - 40 * 7 * DAY,
			},
		],
		now: () => NOW,
		...overrides,
	};
	return { sources, recorded };
}

describe("pool sizing handler", () => {
	it("asks every read for the same fixed lookback", async () => {
		const { sources, recorded } = makeSources();
		const response = await createPoolSizingHandlerFromSources(sources)(
			new URLSearchParams(),
		);
		const body = (await response.json()) as PoolSizingResponse;

		const expected = NOW - POOL_SIZING_LOOKBACK_MS;
		expect(recorded.resetPeaks).toEqual([expected]);
		expect(recorded.scopedResetPeaks).toEqual([expected]);
		expect(recorded.presence).toEqual([expected]);
		expect(recorded.scopedPresence).toEqual([expected]);
		expect(recorded.burst).toEqual([expected]);
		expect(recorded.stops[0]?.sinceMs).toBe(expected);
		expect(body.sinceMs).toBe(expected);
		expect(body.generatedAt).toBe(NOW);
	});

	it("ignores query parameters entirely", async () => {
		const { sources, recorded } = makeSources();
		await createPoolSizingHandlerFromSources(sources)(
			new URLSearchParams({ range: "24h", family: "fable" }),
		);
		expect(recorded.resetPeaks).toEqual([NOW - POOL_SIZING_LOOKBACK_MS]);
	});

	it("reads every stop label the computation can place, in one query", async () => {
		const { sources, recorded } = makeSources();
		await createPoolSizingHandlerFromSources(sources)(new URLSearchParams());

		expect(recorded.stops).toHaveLength(1);
		expect([...(recorded.stops[0]?.labels ?? [])].sort()).toEqual(
			[
				...POOL_SIZING_TERMINAL_STOP_LABELS,
				...POOL_SIZING_REJECTED_ATTEMPT_LABELS,
				...POOL_SIZING_SEPARATE_STOP_LABELS,
			].sort(),
		);
	});

	it("returns the shaped rows with the reserve percentage it was given", async () => {
		const { sources } = makeSources();
		const response = await createPoolSizingHandlerFromSources(
			sources,
			35,
		)(new URLSearchParams());
		const body = (await response.json()) as PoolSizingResponse;

		expect(response.status).toBe(200);
		expect(body.reserveHeadroomPct).toBe(35);
		expect(body.rows).toHaveLength(1);
		expect(body.rows[0]?.classId).toBe("anthropic");
		expect(body.rows[0]?.classLabel).toBe("Claude");
		expect(body.rows[0]?.boundaryRule).toBe("reset_phase_gap");
		const cycle = body.rows[0]?.cycles.find((entry) =>
			entry.accounts.some((account) => account.accountId === "acct-1"),
		);
		expect(cycle?.consumed).toBeCloseTo(0.9, 6);
		expect(cycle?.accounts[0]?.tierLabel).toBe("Max 20x");
	});

	it("answers 500 when a read throws", async () => {
		const { sources } = makeSources({
			getResetPeakRows: async () => {
				throw new Error("db gone");
			},
		});
		const response = await createPoolSizingHandlerFromSources(sources)(
			new URLSearchParams(),
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "Failed to compute pool sizing",
		});
	});
});
