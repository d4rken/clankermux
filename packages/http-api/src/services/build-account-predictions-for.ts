import {
	extractFiveHour,
	extractSevenDay,
	USAGE_HISTORY_PROVIDERS,
} from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import { Logger } from "@clankermux/logger";
import type { AnyUsageData } from "@clankermux/providers";
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
 * `routingFreshUsageByAccount` must be the ROUTING-fresh view of the usage
 * cache, NOT the display view. `buildAccountUsagePredictions` appends the live
 * reading as a data point stamped `t: now`, so a reading that is minutes old
 * would enter the regression claiming to be current and flatten or skew the
 * forecast. An account whose reading has aged past the routing TTL arrives here
 * as `null` and simply gets no prediction until the next poll lands.
 *
 * A DB or compute failure yields an EMPTY MAP rather than propagating: the
 * prediction is garnish on a response that must still be served, so callers can
 * treat "no entry" as `prediction: null` unconditionally.
 */
export async function buildPredictionsForAccounts(
	dbOps: DatabaseOperations,
	accounts: { id: string; provider: string | null }[],
	routingFreshUsageByAccount: ReadonlyMap<string, AnyUsageData | null>,
	now: number,
): Promise<Map<string, AccountUsagePrediction>> {
	const inputs: AccountPredictionInput[] = [];
	for (const account of accounts) {
		const provider = account.provider || "anthropic";
		// The regression itself is provider-agnostic; what it needs is a recorded
		// snapshot series to fit, which is exactly what this set names.
		if (!USAGE_HISTORY_PROVIDERS.has(provider)) continue;
		const live = routingFreshUsageByAccount.get(account.id);
		if (!live || typeof live !== "object") continue;
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
		if (!fiveHour && !sevenDay) continue;
		inputs.push({
			accountId: account.id,
			fiveHour: fiveHour
				? {
						utilization: fiveHour.pct,
						resetsAtMs: fiveHour.resetMs,
					}
				: null,
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
