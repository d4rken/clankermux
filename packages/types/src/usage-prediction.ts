export interface PredictionPoint {
	t: number; // epoch ms
	utilization: number; // 0-100
	resetsAt: number | null; // epoch ms
}

export type UsagePredictionState =
	| "rising"
	| "stable"
	| "exhausted"
	| "insufficient_data";

export interface UsagePrediction {
	state: UsagePredictionState;
	slopePerHour: number;
	etaExhaustMs: number | null;
	predictedAtReset: number | null;
	resetsAtMs: number | null;
	willExhaustBeforeReset: boolean;
	lowConfidence: boolean;
}

export interface AccountUsagePrediction {
	fiveHour?: UsagePrediction;
	sevenDay?: UsagePrediction;
}

// Real Anthropic polls report the SAME reset instant but the stored epoch-ms
// jitters by ~±1s. Shared with the pure algorithm's segmentation and the
// usable-gate reset match.
export const RESET_JITTER_TOLERANCE_MS = 60_000;

/**
 * Whether a server-computed prediction is trustworthy enough to REPLACE the
 * legacy single-snapshot burn-rate projection. Not usable => the client falls
 * through to the old average-rate message/line (never blank).
 */
export function isUsablePrediction(
	pred: UsagePrediction | undefined | null,
	liveResetMs: number | null,
): pred is UsagePrediction {
	if (!pred) return false;
	if (pred.state === "insufficient_data") return false;
	if (pred.lowConfidence) return false;
	const predReset = pred.resetsAtMs;
	// Both sides agree there is no reset info (e.g. a weekly window that hasn't
	// started) — the prediction isn't anchored to a stale window, so allow it.
	if (predReset == null && liveResetMs == null) return true;
	// Exactly one side is null => the prediction's window and the live window
	// disagree (typically a just-happened reset where live resets_at went null
	// but the prediction was computed from the pre-reset cache). Reject so the
	// client falls back to the current-snapshot burn-rate rather than showing a
	// stale ETA / "exhausted".
	if (predReset == null || liveResetMs == null) return false;
	return Math.abs(predReset - liveResetMs) <= RESET_JITTER_TOLERANCE_MS;
}
