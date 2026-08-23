import type { DatabaseOperations } from "@clankermux/database";
import { Logger } from "@clankermux/logger";
import type { AnyUsageData } from "@clankermux/providers";
import type {
	AccountUsagePrediction,
	AnthropicUsageData,
} from "@clankermux/types";
import {
	type AccountPredictionInput,
	buildAccountUsagePredictions,
} from "./build-account-predictions";

const log = new Logger("AccountPredictions");

/**
 * How far back to pull stored usage snapshots when computing the per-account
 * exhaustion prediction. 24h gives the 7-day-window regression a recent pace
 * while `buildAccountUsagePredictions` internally caps the 5h window to 6h.
 * Inline named constant (no env knobs, per project rule).
 */
const PREDICTION_LOOKBACK_MS = 24 * 60 * 60 * 1000;

function isoToMs(s: string | null | undefined): number | null {
	if (s == null) return null;
	const ms = Date.parse(s);
	return Number.isFinite(ms) ? ms : null;
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
		// Only Anthropic-style providers expose the 5h/7d windows the prediction
		// model consumes.
		if (provider !== "anthropic" && provider !== "codex") continue;
		const live = routingFreshUsageByAccount.get(account.id);
		if (!live || typeof live !== "object") continue;
		const fiveHour = (live as AnthropicUsageData).five_hour;
		const sevenDay = (live as AnthropicUsageData).seven_day;
		// Skip accounts with neither window (e.g. non-Anthropic-shaped cache
		// data) — they fall through to no prediction.
		if (!fiveHour && !sevenDay) continue;
		inputs.push({
			accountId: account.id,
			fiveHour: fiveHour
				? {
						utilization: fiveHour.utilization ?? null,
						resetsAtMs: isoToMs(fiveHour.resets_at),
					}
				: null,
			sevenDay: sevenDay
				? {
						utilization: sevenDay.utilization ?? null,
						resetsAtMs: isoToMs(sevenDay.resets_at),
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
