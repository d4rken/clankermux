/**
 * `GET /public/v1/stops` — the credential-free record of what the pool refused.
 *
 * What is pinned here is not the classification (that is
 * `stops-history-direct.test.ts`'s job, over the same computation) but the three
 * properties that exist BECAUSE the surface is unauthenticated: the range is
 * fixed rather than caller-chosen, only what gets published is computed, and a
 * poll loop cannot set the query rate.
 */

import { describe, expect, it } from "bun:test";
import type { RequestFilters } from "@clankermux/database";
import type { StopsHistorySources } from "../../handlers/stops-history-direct";
import { createPublicStopsReaderFromSources } from "../public-stops";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Fixed clock so the window edges are exact. 2026-09-03T12:00:00Z. */
const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);

type Bucketed = Awaited<ReturnType<StopsHistorySources["getStopsByBucket"]>>;

function makeSources(
	over: {
		buckets?: Bucketed;
		total?: number;
		candidates?: Array<{ candidatesCount: number; requests: number }>;
		now?: () => number;
		/** Held open so several readers can be inside one scan at once. */
		gate?: Promise<void>;
	} = {},
): StopsHistorySources & {
	calls: string[];
	sinceValues: number[];
	bucketValues: number[];
	/** The filter selection each source was handed, in call order. */
	filterArgs: Array<RequestFilters | undefined>;
} {
	const calls: string[] = [];
	const sinceValues: number[] = [];
	const bucketValues: number[] = [];
	const filterArgs: Array<RequestFilters | undefined> = [];
	return {
		calls,
		sinceValues,
		bucketValues,
		filterArgs,
		now: over.now ?? (() => NOW),
		getStopsByBucket: async (opts) => {
			calls.push("getStopsByBucket");
			sinceValues.push(opts.sinceMs);
			bucketValues.push(opts.bucketMs);
			filterArgs.push(opts.filters);
			if (over.gate) await over.gate;
			return over.buckets ?? [];
		},
		getStopModelBreakdown: async () => {
			calls.push("getStopModelBreakdown");
			return [];
		},
		countRequestsSince: async (opts) => {
			calls.push("countRequestsSince");
			filterArgs.push(opts.filters);
			return over.total ?? 0;
		},
		getCandidateCountDistribution: async (opts) => {
			calls.push("getCandidateCountDistribution");
			filterArgs.push(opts.filters);
			return over.candidates ?? [];
		},
	};
}

const BLOCKS: Bucketed = [
	{
		errorMessage: "all_accounts_failed",
		statusCode: 503,
		bucketMs: NOW - 3 * HOUR,
		count: 5,
		firstSeenMs: NOW - 3 * HOUR + 10,
		lastSeenMs: NOW - 3 * HOUR + 900,
	},
	{
		errorMessage: "model_not_served",
		statusCode: 400,
		bucketMs: NOW - 2 * HOUR,
		count: 2,
		firstSeenMs: NOW - 2 * HOUR + 5,
		lastSeenMs: NOW - 2 * HOUR + 50,
	},
];

describe("the public stops reader", () => {
	it("counts a FIXED seven days, with no caller-chosen range", async () => {
		// A range parameter here would be an anonymous caller choosing how far
		// back the server scans the request table, at whatever rate it likes.
		const sources = makeSources({ buckets: BLOCKS, total: 1_000 });
		const { summary } = await createPublicStopsReaderFromSources(sources)();
		expect(summary.range).toBe("7d");
		expect(summary.windowEndsAt - summary.windowStartsAt).toBe(7 * DAY);
		expect(sources.sinceValues).toEqual([NOW - 7 * DAY]);
	});

	it("computes only what it publishes: no model breakdown, no series", async () => {
		const sources = makeSources({ buckets: BLOCKS, total: 1_000 });
		const { summary } = await createPublicStopsReaderFromSources(sources)();
		// A second full scan of the range, purely to name a model this surface
		// does not serve.
		expect(sources.calls).not.toContain("getStopModelBreakdown");
		expect(summary.causes.every((c) => c.series.length === 0)).toBe(true);
		expect(summary.causes.every((c) => c.topRequestedModel === null)).toBe(
			true,
		);
		// The counts it DOES publish are unaffected by the omission.
		expect(summary.blockedRequests).toBe(7);
		expect(summary.causes.map((c) => c.cause)).toEqual([
			"pool_quota_exhausted",
			"model_not_served",
		]);
	});

	it("narrows to NOTHING: the pool-level record carries no filter selection", async () => {
		// The dashboard route scopes to the filter panel a signed-in session had
		// open. Honoring one here would publish which accounts, keys and projects
		// exist — the identities this route exists not to disclose — and would
		// make the memo per-caller.
		const sources = makeSources({ buckets: BLOCKS, total: 1_000 });
		await createPublicStopsReaderFromSources(sources)();
		expect(sources.filterArgs).toEqual([undefined, undefined, undefined]);
	});

	it("serves the memo inside the TTL instead of re-scanning", async () => {
		let now = NOW;
		const sources = makeSources({ buckets: BLOCKS, now: () => now });
		const read = createPublicStopsReaderFromSources(sources, {
			now: () => now,
			ttlMs: 60_000,
		});

		const first = await read();
		now = NOW + 30_000;
		const second = await read();

		expect(sources.calls.filter((c) => c === "getStopsByBucket")).toHaveLength(
			1,
		);
		// The SAME measurement, and it says so: `generatedAt` is the read's clock,
		// not the caller's, so two identical instants mean one identical read.
		expect(second.generatedAtMs).toBe(first.generatedAtMs);
		expect(second).toBe(first);
	});

	it("re-scans once the TTL is past", async () => {
		let now = NOW;
		const sources = makeSources({ buckets: BLOCKS, now: () => now });
		const read = createPublicStopsReaderFromSources(sources, {
			now: () => now,
			ttlMs: 60_000,
		});

		await read();
		now = NOW + 61_000;
		const second = await read();

		expect(sources.calls.filter((c) => c === "getStopsByBucket")).toHaveLength(
			2,
		);
		expect(second.generatedAtMs).toBe(now);
	});

	it("coalesces concurrent readers onto ONE in-flight scan", async () => {
		// Without this a burst of polls costs one full scan each, and nothing on
		// the LAN needs a credential to produce a burst.
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const sources = makeSources({ buckets: BLOCKS, gate });
		const read = createPublicStopsReaderFromSources(sources);

		const inFlight = [read(), read(), read()];
		await new Promise((resolve) => setTimeout(resolve, 0));
		release();
		const snapshots = await Promise.all(inFlight);

		expect(sources.calls.filter((c) => c === "getStopsByBucket")).toHaveLength(
			1,
		);
		for (const snapshot of snapshots) {
			expect(snapshot).toBe(snapshots[0]);
		}
	});

	it("does not pin a failed read in place", async () => {
		// A rejected promise left in the single-flight slot would serve the same
		// failure to every later caller for as long as the process lives.
		let attempt = 0;
		const sources = makeSources({ buckets: BLOCKS });
		const failing: StopsHistorySources = {
			...sources,
			getStopsByBucket: async (opts) => {
				attempt += 1;
				if (attempt === 1) throw new Error("db is busy");
				return sources.getStopsByBucket(opts);
			},
		};
		const read = createPublicStopsReaderFromSources(failing);

		await expect(read()).rejects.toThrow("db is busy");
		const recovered = await read();
		expect(recovered.summary.blockedRequests).toBe(7);
	});

	it("reports zero blocked with the denominator intact", async () => {
		const sources = makeSources({ total: 4_000 });
		const { summary } = await createPublicStopsReaderFromSources(sources)();
		expect(summary.blockedRequests).toBe(0);
		expect(summary.causes).toEqual([]);
		expect(summary.totalRequests).toBe(4_000);
	});

	it("separates zero-candidate requests from unrecorded eligibility", async () => {
		const sources = makeSources({
			total: 1_000,
			candidates: [
				{ candidatesCount: 0, requests: 7 },
				{ candidatesCount: 2, requests: 800 },
			],
		});
		const { summary } = await createPublicStopsReaderFromSources(sources)();
		expect(summary.candidates.zeroCandidateRequests).toBe(7);
		// Its own denominator, and smaller than `totalRequests`: eligibility is
		// only recorded for requests that reached routing.
		expect(summary.candidates.observedRequests).toBe(807);
		expect(summary.totalRequests).toBe(1_000);
	});
});
