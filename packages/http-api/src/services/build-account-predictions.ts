import { computeUsagePrediction } from "@clankermux/core";
import type {
	AccountUsagePrediction,
	PredictionPoint,
	UsageSnapshotSample,
} from "@clankermux/types";

// Lookback window (inline named constant — NO env vars, per project rule).
const FIVE_HOUR_LOOKBACK_MS = 6 * 60 * 60 * 1000; // cap 5h-window points to last 6h

export interface LiveWindowUsage {
	utilization: number | null;
	resetsAtMs: number | null;
}

export interface AccountPredictionInput {
	accountId: string;
	/** Live current 5h reading (from usageData), or null if unknown. */
	fiveHour: LiveWindowUsage | null;
}

/**
 * Build per-account predictions from stored snapshots + the live reading. Pure
 * & deterministic (pass `now`). Injects the live point so the prediction never
 * lags the ~2-min sampler and self-corrects across a reset (stale-window points
 * get segmented out by computeUsagePrediction -> insufficient_data -> the
 * client falls back to the legacy burn-rate).
 *
 * The FIVE-HOUR window only. The weekly window used to get the same
 * least-squares fit over a 24h lookback, and an offline backtest over ~12 weeks
 * of stored snapshots showed the plain lifetime average beating it on held-out
 * data — on run-out F1, on median ETA error, and on the precision of the red
 * rule the display keys off. So there is nothing left for a weekly regression
 * to do: emitting one would only give the client a worse estimator to prefer
 * over the better one it already falls back to. `AccountUsagePrediction.sevenDay`
 * is therefore never set, and every consumer treats its absence as "use the
 * lifetime average" — which is now that window's PRIMARY estimator, carried by
 * the `lifetimeConfidence` policy in `estimateWindowExhaustion` rather than by
 * a prediction object.
 *
 * The routing-side weekly burn slope is a different computation with different
 * inputs and is unaffected.
 */
export function buildAccountUsagePredictions(
	inputs: AccountPredictionInput[],
	samples: UsageSnapshotSample[],
	now: number,
): Map<string, AccountUsagePrediction> {
	// Group samples by accountId in a single pass.
	const byAccount = new Map<string, UsageSnapshotSample[]>();
	for (const s of samples) {
		const list = byAccount.get(s.accountId);
		if (list) list.push(s);
		else byAccount.set(s.accountId, [s]);
	}

	const fiveHourCutoff = now - FIVE_HOUR_LOOKBACK_MS;
	const result = new Map<string, AccountUsagePrediction>();

	for (const input of inputs) {
		const accountSamples = byAccount.get(input.accountId) ?? [];

		const fiveHourPoints: PredictionPoint[] = [];
		for (const s of accountSamples) {
			if (s.fiveHourPct != null && s.sampledAt >= fiveHourCutoff) {
				fiveHourPoints.push({
					t: s.sampledAt,
					utilization: s.fiveHourPct,
					resetsAt: s.fiveHourReset,
				});
			}
		}

		// Append the live point so the prediction never lags the sampler.
		if (input.fiveHour?.utilization != null) {
			fiveHourPoints.push({
				t: now,
				utilization: input.fiveHour.utilization,
				resetsAt: input.fiveHour.resetsAtMs,
			});
		}

		if (fiveHourPoints.length === 0) continue;
		result.set(input.accountId, {
			fiveHour: computeUsagePrediction(fiveHourPoints),
		});
	}

	return result;
}
