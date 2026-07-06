import type { UsagePrediction } from "@clankermux/types";

/**
 * Formats a positive millisecond duration as "Xh Ym" (or "Ym" under an hour).
 * Shared with RateLimitProgress so the regression-backed projection copy reads
 * identically to the legacy single-snapshot burn-rate message.
 */
export function formatDuration(ms: number): string {
	const totalMinutes = Math.round(ms / 60000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

/**
 * Renders the server-computed regression prediction in the same copy style as
 * the legacy `computeProjectedMessage`. Pure and deterministic — `now` is passed
 * in. Returns null when there is no alarming message to show (stable / negative
 * slope), so the caller can fall through to the neutral pace message.
 *
 * The caller must first gate on `isUsablePrediction`; this only formats.
 */
export function formatPredictionMessage(
	pred: UsagePrediction,
	resetTimeMs: number | null,
	now: number,
): string | null {
	if (pred.state === "exhausted") return "Quota exhausted";
	// Stable (or a non-positive slope) has no exhaustion to project — the bar
	// already shows the current %, so say nothing alarming.
	if (pred.state === "stable" || pred.slopePerHour <= 0) return null;
	if (pred.state === "rising" && pred.etaExhaustMs != null) {
		if (resetTimeMs != null) {
			if (pred.etaExhaustMs < resetTimeMs) {
				return `Runs out ${formatDuration(resetTimeMs - pred.etaExhaustMs)} before reset`;
			}
			return `Resets ${formatDuration(pred.etaExhaustMs - resetTimeMs)} before exhaustion`;
		}
		return `Runs out in ${formatDuration(pred.etaExhaustMs - now)}`;
	}
	return null;
}
