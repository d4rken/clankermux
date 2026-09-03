/**
 * Shaping tests for `/api/analytics/stops-history`, over the sources seam so
 * no database is involved.
 *
 * The assertions that matter are the ones about what this handler must NOT do.
 * Its three sibling history handlers all carry a reading forward across empty
 * buckets, because a utilization percentage is a level that stays true until
 * contradicted. A stop is an event. Carrying one forward would invent outages
 * on a surface whose entire purpose is to be trustworthy about how often they
 * happened.
 */

import { describe, expect, it } from "bun:test";
import type { StopsHistoryResponse } from "@clankermux/types";
import {
	createStopsHistoryHandlerFromSources,
	type StopsHistorySources,
} from "../stops-history-direct";

const HOUR = 60 * 60 * 1000;
/** Fixed clock so bucket boundaries are exact. 2026-09-03T12:00:00Z. */
const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);

type Bucketed = Awaited<ReturnType<StopsHistorySources["getStopsByBucket"]>>;
type Models = Awaited<ReturnType<StopsHistorySources["getStopModelBreakdown"]>>;

function makeSources(over: {
	buckets?: Bucketed;
	models?: Models;
	total?: number;
	candidates?: Array<{ candidatesCount: number; requests: number }>;
}): StopsHistorySources & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		now: () => NOW,
		getStopsByBucket: async () => {
			calls.push("getStopsByBucket");
			return over.buckets ?? [];
		},
		getStopModelBreakdown: async () => {
			calls.push("getStopModelBreakdown");
			return over.models ?? [];
		},
		countRequestsSince: async () => {
			calls.push("countRequestsSince");
			return over.total ?? 0;
		},
		getCandidateCountDistribution: async () => {
			calls.push("getCandidateCountDistribution");
			return over.candidates ?? [];
		},
	};
}

async function run(
	sources: StopsHistorySources,
	range = "24h",
): Promise<StopsHistoryResponse> {
	const response = await createStopsHistoryHandlerFromSources(sources)(
		new URLSearchParams({ range }),
	);
	expect(response.status).toBe(200);
	return (await response.json()) as StopsHistoryResponse;
}

describe("stops-history handler", () => {
	it("classifies raw messages into causes and totals them", async () => {
		const body = await run(
			makeSources({
				total: 1000,
				buckets: [
					{
						errorMessage: "all_accounts_failed",
						statusCode: 503,
						bucketMs: NOW - 3 * HOUR,
						count: 5,
						firstSeenMs: NOW - 3 * HOUR + 10,
						lastSeenMs: NOW - 3 * HOUR + 900,
					},
					{
						errorMessage: "family_weekly_exhausted_429",
						statusCode: 429,
						bucketMs: NOW - 2 * HOUR,
						count: 2,
						firstSeenMs: NOW - 2 * HOUR + 5,
						lastSeenMs: NOW - 2 * HOUR + 50,
					},
				],
			}),
		);

		expect(body.totalRequests).toBe(1000);
		expect(body.blockedRequests).toBe(7);
		expect(body.causes.map((c) => c.cause)).toEqual([
			"pool_quota_exhausted",
			"family_weekly_exhausted",
		]);
		expect(body.causes[0].count).toBe(5);
		expect(body.causes[1].count).toBe(2);
	});

	it("emits an explicit zero for buckets with no stops", async () => {
		// A gap in a stops series is a real measurement — "nothing was refused in
		// this hour" — and it is the measurement the reader most wants. Omitting
		// the bucket would let a chart interpolate across it.
		const body = await run(
			makeSources({
				total: 100,
				buckets: [
					{
						errorMessage: "all_accounts_failed",
						statusCode: 503,
						bucketMs: NOW - 3 * HOUR,
						count: 1,
						firstSeenMs: NOW - 3 * HOUR,
						lastSeenMs: NOW - 3 * HOUR,
					},
				],
			}),
		);

		const series = body.causes[0].series;
		expect(series.length).toBe(4); // -3h, -2h, -1h, now
		expect(series[0].count).toBe(1);
		// The three later buckets are zero, NOT a carried-forward 1.
		expect(series.slice(1).map((p) => p.count)).toEqual([0, 0, 0]);
	});

	it("names the top requested model on every cause row", async () => {
		// The production case this exists for: 300 blocks labelled as pool
		// exhaustion that were all one model. The label cannot be rewritten
		// retroactively, so the model name is what makes the row readable.
		const body = await run(
			makeSources({
				total: 500,
				buckets: [
					{
						errorMessage: "all_accounts_failed",
						statusCode: 503,
						bucketMs: NOW - HOUR,
						count: 12,
						firstSeenMs: NOW - HOUR,
						lastSeenMs: NOW - HOUR + 60,
					},
				],
				models: [
					{
						errorMessage: "all_accounts_failed",
						statusCode: 503,
						model: "gpt-5.2-codex",
						count: 10,
					},
					{
						errorMessage: "all_accounts_failed",
						statusCode: 503,
						model: "claude-opus-5",
						count: 2,
					},
				],
			}),
		);

		expect(body.causes[0].topRequestedModel).toBe("gpt-5.2-codex");
		expect(body.causes[0].topRequestedModelCount).toBe(10);
	});

	it("samples the message that dominates a cause, not the first one seen", async () => {
		// An `other` bucket is only actionable if it names its main contributor.
		const body = await run(
			makeSources({
				total: 50,
				buckets: [
					{
						errorMessage: "rare_unknown_thing",
						statusCode: null,
						bucketMs: NOW - 2 * HOUR,
						count: 1,
						firstSeenMs: NOW - 2 * HOUR,
						lastSeenMs: NOW - 2 * HOUR,
					},
					{
						errorMessage: "common_unknown_thing",
						statusCode: null,
						bucketMs: NOW - HOUR,
						count: 9,
						firstSeenMs: NOW - HOUR,
						lastSeenMs: NOW - HOUR,
					},
				],
			}),
		);

		expect(body.causes[0].cause).toBe("other");
		expect(body.causes[0].sampleErrorMessage).toBe("common_unknown_thing");
	});

	it("reports the candidate distribution and separates zero from unrecorded", async () => {
		// "No account was eligible" and "the column was never written" are
		// opposite readings, and only one of them is an outage.
		const body = await run(
			makeSources({
				total: 200,
				candidates: [
					{ candidatesCount: 0, requests: 3 },
					{ candidatesCount: 1, requests: 40 },
					{ candidatesCount: 5, requests: 157 },
				],
			}),
		);

		expect(body.candidates.observedRequests).toBe(200);
		expect(body.candidates.zeroCandidateRequests).toBe(3);
		expect(body.candidates.distribution).toHaveLength(3);
	});

	it("reports zero blocked with no causes rather than failing", async () => {
		// The healthy case, and the one the reader is hoping for. It must render
		// as a measured zero, not as an empty/unavailable surface.
		const body = await run(makeSources({ total: 4000 }));
		expect(body.totalRequests).toBe(4000);
		expect(body.blockedRequests).toBe(0);
		expect(body.causes).toEqual([]);
	});

	it("never looks up a predecessor reading", async () => {
		// The bounded-predecessor machinery the usage-history handlers need has
		// no analogue here, and importing it "for consistency" would fabricate
		// stops. Asserted on the source surface so the omission is enforced,
		// not merely documented.
		const sources = makeSources({ total: 10 });
		await run(sources);
		expect(sources.calls).toEqual([
			"getStopsByBucket",
			"getStopModelBreakdown",
			"countRequestsSince",
			"getCandidateCountDistribution",
		]);
		expect(
			Object.keys(sources).some((k) => k.toLowerCase().includes("before")),
		).toBe(false);
	});

	it("orders causes by count, biggest first", async () => {
		const body = await run(
			makeSources({
				total: 100,
				buckets: [
					{
						errorMessage: "family_weekly_exhausted",
						statusCode: 503,
						bucketMs: NOW - HOUR,
						count: 2,
						firstSeenMs: NOW - HOUR,
						lastSeenMs: NOW - HOUR,
					},
					{
						errorMessage: "model_not_served",
						statusCode: 400,
						bucketMs: NOW - HOUR,
						count: 30,
						firstSeenMs: NOW - HOUR,
						lastSeenMs: NOW - HOUR,
					},
					{
						errorMessage: "provider_overloaded",
						statusCode: 529,
						bucketMs: NOW - HOUR,
						count: 7,
						firstSeenMs: NOW - HOUR,
						lastSeenMs: NOW - HOUR,
					},
				],
			}),
		);

		expect(body.causes.map((c) => c.cause)).toEqual([
			"model_not_served",
			"provider_overloaded",
			"family_weekly_exhausted",
		]);
	});
});
