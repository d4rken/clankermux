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

/**
 * The last observed mid-window downward usage revision for one account window —
 * a provider "gift" reset or an applied reset credit, detected as a drop in the
 * reported percentage while `resets_at` stayed put.
 *
 * Consumed by the lifetime-average paths of `estimateWindowExhaustion`: after
 * such an event the structural window start no longer describes when the
 * reported percentage began accumulating, so a slope computed against it is
 * underestimated by up to an order of magnitude. The anchor supplies the
 * honest origin: slope = (pct − anchorPct) / (elapsed since anchorMs).
 *
 * `anchorPct` exists because gifts need not reset to zero — a partial refund
 * anchors at whatever the post-revision reading was. `windowResetMs` binds the
 * anchor to ONE window instance; consumers must drop an anchor whose reset does
 * not match the projected reading's reset (within jitter tolerance), so a
 * stale anchor can never distort the next window.
 */
export interface UsageBurnAnchor {
	/** Observation time of the first post-revision reading, ms since epoch. */
	anchorMs: number;
	/** The reported percentage at that reading (0-100). */
	anchorPct: number;
	/** Reset instant of the window the revision happened in, ms since epoch. */
	windowResetMs: number;
}

/** Per-window burn anchors for one account, as served on `AccountResponse`. */
export interface AccountBurnAnchors {
	fiveHour?: UsageBurnAnchor | null;
	sevenDay?: UsageBurnAnchor | null;
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
