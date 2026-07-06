import type {
	AccountUsagePrediction,
	PredictionPoint,
	UsageSnapshotSample,
} from "@clankermux/types";
import { computeUsagePrediction } from "./usage-prediction";

// Lookback windows (inline named constants — NO env vars, per project rule).
const FIVE_HOUR_LOOKBACK_MS = 6 * 60 * 60 * 1000; // cap 5h-window points to last 6h
const SEVEN_DAY_LOOKBACK_MS = 24 * 60 * 60 * 1000; // recent pace for the 7d window

export interface LiveWindowUsage {
	utilization: number | null;
	resetsAtMs: number | null;
}

export interface AccountPredictionInput {
	accountId: string;
	/** Live current 5h reading (from usageData), or null if unknown. */
	fiveHour: LiveWindowUsage | null;
	/** Live current 7d reading, or null. */
	sevenDay: LiveWindowUsage | null;
}

/**
 * Build per-account, per-window predictions from stored snapshots + the live
 * reading. Pure & deterministic (pass `now`). Injects the live point so the
 * prediction never lags the ~2-min sampler and self-corrects across a reset
 * (stale-window points get segmented out by computeUsagePrediction ->
 * insufficient_data -> the client falls back to the legacy burn-rate).
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
	const sevenDayCutoff = now - SEVEN_DAY_LOOKBACK_MS;
	const result = new Map<string, AccountUsagePrediction>();

	for (const input of inputs) {
		const accountSamples = byAccount.get(input.accountId) ?? [];

		const fiveHourPoints: PredictionPoint[] = [];
		const sevenDayPoints: PredictionPoint[] = [];
		for (const s of accountSamples) {
			if (s.fiveHourPct != null && s.sampledAt >= fiveHourCutoff) {
				fiveHourPoints.push({
					t: s.sampledAt,
					utilization: s.fiveHourPct,
					resetsAt: s.fiveHourReset,
				});
			}
			if (s.sevenDayPct != null && s.sampledAt >= sevenDayCutoff) {
				sevenDayPoints.push({
					t: s.sampledAt,
					utilization: s.sevenDayPct,
					resetsAt: s.sevenDayReset,
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
		if (input.sevenDay?.utilization != null) {
			sevenDayPoints.push({
				t: now,
				utilization: input.sevenDay.utilization,
				resetsAt: input.sevenDay.resetsAtMs,
			});
		}

		const prediction: AccountUsagePrediction = {};
		if (fiveHourPoints.length > 0) {
			prediction.fiveHour = computeUsagePrediction(fiveHourPoints);
		}
		if (sevenDayPoints.length > 0) {
			prediction.sevenDay = computeUsagePrediction(sevenDayPoints);
		}

		if (prediction.fiveHour || prediction.sevenDay) {
			result.set(input.accountId, prediction);
		}
	}

	return result;
}
