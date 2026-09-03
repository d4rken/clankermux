import { RequestRepository } from "@clankermux/database";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import {
	classifyStopCause,
	type StopCause,
	type StopsHistoryCause,
	type StopsHistoryPoint,
	type StopsHistoryResponse,
} from "@clankermux/types";
import type { APIContext } from "../types";
import { getRangeConfig } from "./range-config";
import {
	buildBucketGrid,
	normalizeRange,
	type Range,
} from "./usage-history-shared";

const log = new Logger("StopsHistoryHandler");

/** How much of a raw `error_message` travels as provenance. */
const SAMPLE_MESSAGE_MAX_CHARS = 160;

/**
 * Data sources for the stops-history shaping. Same seam as the other history
 * handlers: repositories in production, plain mocks in the unit tests.
 */
export interface StopsHistorySources {
	getStopsByBucket(opts: { sinceMs: number; bucketMs: number }): Promise<
		Array<{
			errorMessage: string | null;
			statusCode: number | null;
			bucketMs: number;
			count: number;
			firstSeenMs: number;
			lastSeenMs: number;
		}>
	>;
	getStopModelBreakdown(opts: { sinceMs: number }): Promise<
		Array<{
			errorMessage: string | null;
			statusCode: number | null;
			model: string | null;
			count: number;
		}>
	>;
	countRequestsSince(sinceMs: number): Promise<number>;
	getCandidateCountDistribution(
		sinceMs: number,
	): Promise<Array<{ candidatesCount: number; requests: number }>>;
	/** Clock seam. Defaults to `Date.now`; tests pin it to a fixed instant. */
	now?(): number;
}

export function createStopsHistoryHandler(context: APIContext) {
	const requests = new RequestRepository(context.dbOps.getAdapter());
	return createStopsHistoryHandlerFromSources({
		getStopsByBucket: (opts) => requests.getStopsByBucket(opts),
		getStopModelBreakdown: (opts) => requests.getStopModelBreakdown(opts),
		countRequestsSince: (sinceMs) => requests.countRequestsSince(sinceMs),
		getCandidateCountDistribution: (sinceMs) =>
			requests.getCandidateCountDistribution(sinceMs),
	});
}

/**
 * Direct (in-process) `/api/analytics/stops-history` implementation: how often
 * requests were actually refused in the range, grouped by why.
 *
 * The dashboard's caller, so it asks {@link computeStopsHistory} for the whole
 * response — model breakdown and series included — and owns the range parsing
 * and the error mapping. The public widget reader calls the same computation
 * with a fixed range and both extras off.
 */
export function createStopsHistoryHandlerFromSources(
	sources: StopsHistorySources,
) {
	return async (params: URLSearchParams): Promise<Response> => {
		try {
			const range = normalizeRange(params.get("range"));
			return jsonResponse(await computeStopsHistory(sources, range));
		} catch (error) {
			log.error("Stops history error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch stops history data"),
			);
		}
	};
}

/**
 * What each caller of {@link computeStopsHistory} actually needs.
 *
 * Both default to true, so the dashboard handler asks for nothing and gets the
 * whole response. The public widget reader turns both off because it publishes
 * neither: `getStopModelBreakdown` is a second full scan of the range purely to
 * name a model this surface does not serve, and the bucket grid builds a series
 * that would be a second array level inside the cause records. Computing what
 * you then throw away is how an unauthenticated route comes to cost more than
 * the payload it returns.
 */
export interface StopsHistoryOptions {
	/** Query and report `topRequestedModel` / `topRequestedModelCount`. */
	includeModelBreakdown?: boolean;
	/** Build the per-bucket `series` on every cause row. */
	includeSeries?: boolean;
}

/**
 * Shape one stops-history answer from the sources. Pure apart from
 * `sources.now()`; the handler above wraps it in a response, the public reader
 * memoizes it.
 *
 * There is deliberately NO carry-forward here, and the omission is the point.
 * The sibling usage-history shapers carry a reading forward across empty
 * buckets because a utilization percentage is a LEVEL that stays true until the
 * next reading contradicts it. A stop is an EVENT: it happened at an instant
 * and it is over. Carrying one forward would invent outages, and importing
 * `walkCarry` here "for consistency" would do exactly that — hence no
 * predecessor lookup either, and none of the bounded-lookback machinery that
 * exists to make one cheap.
 *
 * The grid comes from `buildBucketGrid` so the series aligns with every other
 * chart on the page; buckets with no stops carry an explicit zero, which is a
 * real measurement and the one most worth seeing.
 */
export async function computeStopsHistory(
	sources: StopsHistorySources,
	range: Range,
	options: StopsHistoryOptions = {},
): Promise<StopsHistoryResponse> {
	const includeModelBreakdown = options.includeModelBreakdown ?? true;
	const includeSeries = options.includeSeries ?? true;
	const { bucketMs, windowMs } = getRangeConfig(range);
	const nowMs = sources.now?.() ?? Date.now();
	const sinceMs = windowMs === null ? 0 : nowMs - windowMs;

	const [buckets, models, totalRequests, candidateRows] = await Promise.all([
		sources.getStopsByBucket({ sinceMs, bucketMs }),
		includeModelBreakdown
			? sources.getStopModelBreakdown({ sinceMs })
			: Promise.resolve([]),
		sources.countRequestsSince(sinceMs),
		sources.getCandidateCountDistribution(sinceMs),
	]);

	// Cause accumulation. Classification runs once per (message, status)
	// GROUP rather than once per request, which is what keeps this cheap on
	// a database with hundreds of thousands of rows in range.
	const causes = new Map<
		StopCause,
		{
			count: number;
			firstSeenMs: number;
			lastSeenMs: number;
			sample: string | null;
			sampleCount: number;
			byBucket: Map<number, number>;
			byModel: Map<string, number>;
		}
	>();
	const bucketFor = (cause: StopCause) => {
		let entry = causes.get(cause);
		if (!entry) {
			entry = {
				count: 0,
				firstSeenMs: Number.POSITIVE_INFINITY,
				lastSeenMs: Number.NEGATIVE_INFINITY,
				sample: null,
				sampleCount: 0,
				byBucket: new Map(),
				byModel: new Map(),
			};
			causes.set(cause, entry);
		}
		return entry;
	};

	let blockedRequests = 0;
	let firstEvidenceMs: number | null = null;
	for (const row of buckets) {
		const cause = classifyStopCause(row.errorMessage, row.statusCode);
		const entry = bucketFor(cause);
		entry.count += row.count;
		blockedRequests += row.count;
		entry.firstSeenMs = Math.min(entry.firstSeenMs, row.firstSeenMs);
		entry.lastSeenMs = Math.max(entry.lastSeenMs, row.lastSeenMs);
		entry.byBucket.set(
			row.bucketMs,
			(entry.byBucket.get(row.bucketMs) ?? 0) + row.count,
		);
		// The sample is the message that accounts for the most blocks under
		// this cause, not merely the first one seen — an `other` bucket is
		// only actionable if it names its dominant contributor.
		if (row.errorMessage && row.count > entry.sampleCount) {
			entry.sample = row.errorMessage.slice(0, SAMPLE_MESSAGE_MAX_CHARS);
			entry.sampleCount = row.count;
		}
		firstEvidenceMs =
			firstEvidenceMs === null
				? row.firstSeenMs
				: Math.min(firstEvidenceMs, row.firstSeenMs);
	}

	for (const row of models) {
		if (!row.model) continue;
		const entry = causes.get(
			classifyStopCause(row.errorMessage, row.statusCode),
		);
		// A cause present in the model breakdown but not in the bucket rows
		// cannot happen (same predicate, same range), but creating one here
		// would produce a cause row with an empty series and infinite
		// first-seen. Skip rather than invent.
		if (!entry) continue;
		entry.byModel.set(
			row.model,
			(entry.byModel.get(row.model) ?? 0) + row.count,
		);
	}

	const grid = includeSeries
		? buildBucketGrid({ sinceMs, bucketMs, nowMs, firstEvidenceMs })
		: [];

	const result: StopsHistoryCause[] = [];
	for (const [cause, entry] of causes) {
		const series: StopsHistoryPoint[] = grid.map((ts) => ({
			ts,
			count: entry.byBucket.get(ts) ?? 0,
		}));
		let topRequestedModel: string | null = null;
		let topRequestedModelCount = 0;
		for (const [model, count] of entry.byModel) {
			if (count > topRequestedModelCount) {
				topRequestedModel = model;
				topRequestedModelCount = count;
			}
		}
		result.push({
			cause,
			count: entry.count,
			firstSeenMs: entry.firstSeenMs,
			lastSeenMs: entry.lastSeenMs,
			topRequestedModel,
			topRequestedModelCount,
			sampleErrorMessage: entry.sample,
			series,
		});
	}
	// Biggest first: the reader's question is "what stopped me most",
	// and a stable tiebreak on the cause name keeps the order from
	// shuffling between polls when counts are equal.
	result.sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause));

	const observedRequests = candidateRows.reduce(
		(sum, row) => sum + row.requests,
		0,
	);
	const zeroCandidateRequests =
		candidateRows.find((row) => row.candidatesCount === 0)?.requests ?? 0;

	return {
		range,
		bucketMs,
		windowStartsAt: sinceMs,
		windowEndsAt: nowMs,
		totalRequests,
		blockedRequests,
		causes: result,
		candidates: {
			observedRequests,
			zeroCandidateRequests,
			distribution: candidateRows,
		},
	};
}
