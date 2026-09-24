import {
	type ExtractedValue,
	extractFiveHour,
	extractSevenDay,
	USAGE_HISTORY_PROVIDERS,
} from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import { Logger } from "@clankermux/logger";
import { type AnyUsageData, USAGE_CACHE_TTL_MS } from "@clankermux/providers";
import type { AccountUsagePrediction, FullUsageData } from "@clankermux/types";
import {
	type AccountPredictionInput,
	buildAccountUsagePredictions,
} from "./build-account-predictions";

const log = new Logger("AccountPredictions");

/**
 * How far back to pull stored usage snapshots when computing the per-account
 * exhaustion prediction. `buildAccountUsagePredictions` caps the points it fits
 * to the last 6h, so this is the wider bound of the two and the query returns
 * some rows the fit then drops. It stays at 24h: the snapshot rows are small,
 * one query serves the whole account set, and a lookback that hugs the fit
 * window leaves nothing to widen it with.
 * Inline named constant (no env knobs, per project rule).
 */
const PREDICTION_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** A poll reading as a prediction input, with its own observation time. */
export interface PredictionLiveReading {
	data: AnyUsageData;
	observedAtMs: number | null;
}

/**
 * A usage-cache poll entry (`usageCache.peekWithAge`) as a prediction input:
 * null past the routing TTL. The poll entry and never the header-fed view,
 * because the regression fits the poll's own snapshot series.
 */
export function predictionLiveReading(
	entry:
		| {
				data: AnyUsageData;
				ageMs: number;
				observedAtMs: number | null;
		  }
		| null
		| undefined,
): PredictionLiveReading | null {
	return entry && entry.ageMs <= USAGE_CACHE_TTL_MS
		? { data: entry.data, observedAtMs: entry.observedAtMs }
		: null;
}

/**
 * Whether an extracted window carries anything to predict from. A recognised
 * payload that names no window still extracts to a value object with null
 * fields, so presence has to be decided on the fields.
 */
function hasWindowReading(extracted: ExtractedValue | null): boolean {
	return (
		extracted != null && (extracted.pct != null || extracted.resetMs != null)
	);
}

/**
 * The WHOLE best-effort prediction operation for a set of accounts: which
 * accounts are predictable, the snapshot query behind them, the regression, and
 * the failure policy.
 *
 * Extracted from the accounts handler so `/api/accounts` and `/api/runway`
 * cannot drift on any of those. Pulling out only the input-assembly loop would
 * have left the lookback constant, the snapshot query, the build call and the
 * error policy duplicated at both call sites.
 *
 * `liveReadingByAccount` must hold the poll entries under the routing TTL
 * (see {@link predictionLiveReading}), NOT the display view.
 * `buildAccountUsagePredictions` appends the live reading as a data point at
 * its observation time, and a reading with no known observation time is not
 * appended. An account whose reading has aged past the routing TTL arrives here
 * as `null` and gets no live point until the next poll lands.
 *
 * A DB or compute failure yields an EMPTY MAP rather than propagating: the
 * prediction is garnish on a response that must still be served, so callers can
 * treat "no entry" as `prediction: null` unconditionally.
 */
export async function buildPredictionsForAccounts(
	dbOps: DatabaseOperations,
	accounts: { id: string; provider: string | null }[],
	liveReadingByAccount: ReadonlyMap<string, PredictionLiveReading | null>,
	now: number,
): Promise<Map<string, AccountUsagePrediction>> {
	const inputs: AccountPredictionInput[] = [];
	for (const account of accounts) {
		const provider = account.provider || "anthropic";
		// The regression itself is provider-agnostic; what it needs is a recorded
		// snapshot series to fit, which is exactly what this set names.
		if (!USAGE_HISTORY_PROVIDERS.has(provider)) continue;
		const reading = liveReadingByAccount.get(account.id);
		const live = reading?.data;
		if (!reading || !live || typeof live !== "object") continue;
		// Read the windows through the shared extractors: each provider names them
		// differently, and reading the Anthropic keys directly dropped every
		// account whose payload has neither, one line after the filter admitted it.
		const fiveHour = extractFiveHour(live as FullUsageData);
		const sevenDay = extractSevenDay(live as FullUsageData);
		// Skip accounts with neither window — they fall through to no prediction.
		// Only the 5-hour reading is carried forward (the weekly window has no
		// regression any more), but an account showing just a weekly reading still
		// enters: its 5-hour history may be in the snapshots even when the live
		// payload has no 5h block.
		if (!hasWindowReading(fiveHour) && !hasWindowReading(sevenDay)) continue;
		inputs.push({
			accountId: account.id,
			fiveHour: fiveHour
				? {
						utilization: fiveHour.pct,
						resetsAtMs: fiveHour.resetMs,
					}
				: null,
			observedAtMs: reading.observedAtMs,
		});
	}

	if (inputs.length === 0) return new Map();

	try {
		const samples = await dbOps.getRecentUsageSnapshotsForAccounts(
			inputs.map((i) => i.accountId),
			now - PREDICTION_LOOKBACK_MS,
		);
		return buildAccountUsagePredictions(inputs, samples, now);
	} catch (err) {
		log.warn(`Failed to compute usage predictions: ${err}`);
		return new Map();
	}
}
