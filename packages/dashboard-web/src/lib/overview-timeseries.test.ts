import { describe, expect, it } from "bun:test";
import type {
	ActiveSessionsTimePoint,
	AnalyticsResponse,
	TimePoint,
} from "@clankermux/types";
import { buildOverviewTimeSeries } from "./overview-timeseries";

/** Minimal TimePoint with every field the transform reads. */
function point(overrides: Partial<TimePoint> & { ts: number }): TimePoint {
	return {
		model: undefined,
		requests: 0,
		tokens: 0,
		costUsd: 0,
		planCostUsd: 0,
		apiCostUsd: 0,
		successRate: 100,
		errorRate: 0,
		cacheHitRate: 0,
		avgResponseTime: 0,
		avgTokensPerSecond: 0,
		...overrides,
	};
}

/**
 * Minimal AnalyticsResponse — only the two fields the transform touches. The
 * full response type is unwieldy to construct, so the rest is cast away.
 */
function analytics(
	timeSeries: TimePoint[],
	activeSessionsTimeSeries?: ActiveSessionsTimePoint[],
): AnalyticsResponse {
	return {
		timeSeries,
		...(activeSessionsTimeSeries
			? {
					activeSessions: {
						timeSeries: activeSessionsTimeSeries,
						totalDistinctSessions: 0,
						perAccount: [],
					},
				}
			: {}),
	} as unknown as AnalyticsResponse;
}

describe("buildOverviewTimeSeries", () => {
	it("returns an empty array for null analytics", () => {
		expect(buildOverviewTimeSeries(null)).toEqual([]);
	});

	it("returns an empty array for undefined analytics", () => {
		expect(buildOverviewTimeSeries(undefined)).toEqual([]);
	});

	it("omits the activeSessions key entirely when activeSessions is absent", () => {
		// Presence detection in the chart keys off the key's absence, so an
		// explicit `undefined` value would be wrong here.
		const rows = buildOverviewTimeSeries(
			analytics([point({ ts: 1, requests: 3 }), point({ ts: 2, requests: 4 })]),
		);

		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(Object.hasOwn(row, "activeSessions")).toBe(false);
		}
	});

	it("emits an explicit 0 on every row when activeSessions is present but its series is empty", () => {
		const rows = buildOverviewTimeSeries(
			analytics(
				[point({ ts: 1, requests: 3 }), point({ ts: 2, requests: 4 })],
				[],
			),
		);

		expect(rows.map((r) => r.activeSessions)).toEqual([0, 0]);
		for (const row of rows) {
			expect(Object.hasOwn(row, "activeSessions")).toBe(true);
		}
	});

	it("fills matched buckets with their total and unmatched buckets with 0", () => {
		const rows = buildOverviewTimeSeries(
			analytics(
				[
					point({ ts: 1, requests: 3 }),
					point({ ts: 2, requests: 4 }),
					point({ ts: 3, requests: 5 }),
				],
				[
					{ ts: 1, scope: "claude_session", sessions: 2 },
					{ ts: 1, scope: "codex_thread", sessions: 1 },
					{ ts: 3, scope: "project", sessions: 7 },
				],
			),
		);

		expect(rows.map((r) => r.activeSessions)).toEqual([3, 0, 7]);
	});

	it("drops a session bucket whose ts has no requests bucket", () => {
		// Merge policy: rows are requests-driven. A session-only bucket (possible
		// only via the transient read race between the two analytics queries) is
		// not rendered.
		const rows = buildOverviewTimeSeries(
			analytics(
				[point({ ts: 1, requests: 3 })],
				[
					{ ts: 1, scope: "claude_session", sessions: 2 },
					{ ts: 99, scope: "claude_session", sessions: 5 },
				],
			),
		);

		expect(rows.map((r) => r.ts)).toEqual([1]);
		expect(rows[0].activeSessions).toBe(2);
	});

	it("preserves the base field mapping", () => {
		const rows = buildOverviewTimeSeries(
			analytics([
				point({
					ts: 42,
					requests: 9,
					successRate: 87.5,
					avgResponseTime: 123.6,
					costUsd: 1.239,
					planCostUsd: 0.5,
					apiCostUsd: 0.25,
					avgTokensPerSecond: 31.5,
				}),
			]),
		);

		expect(rows[0]).toEqual({
			ts: 42,
			requests: 9,
			successRate: 87.5,
			responseTime: 124,
			cost: "1.24",
			planCost: 0.5,
			apiCost: 0.25,
			tokensPerSecond: 31.5,
		});
		expect(typeof rows[0].cost).toBe("string");
	});

	it("maps a null avgTokensPerSecond to 0", () => {
		const rows = buildOverviewTimeSeries(
			analytics([point({ ts: 1, avgTokensPerSecond: null })]),
		);

		expect(rows[0].tokensPerSecond).toBe(0);
	});
});
