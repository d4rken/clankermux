import type { UsagePrediction } from "@clankermux/types";

/**
 * Severity of a usage projection, keyed off what the projection actually means
 * rather than instantaneous pacing:
 *  - "danger": the window will run out of quota before it resets.
 *  - "safe":   the window resets before it would exhaust — the reassuring case.
 *  - "neutral": nothing to project yet (no usage recorded).
 * The color of the projection line is driven by this, so a reassuring
 * "Resets … before exhaustion" message never renders in an alarming red just
 * because usage happens to be ahead of a flat time-linear pace.
 */
export type ProjectionTone = "danger" | "safe" | "neutral";

export interface ProjectedUsage {
	message: string;
	tone: ProjectionTone;
}

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
 * The returned `tone` reflects the projection's meaning so the caller can color
 * the line correctly: resetting before exhaustion is "safe" (green), running out
 * before reset is "danger" (red).
 *
 * The caller must first gate on `isUsablePrediction`; this only formats.
 */
export function formatPredictionMessage(
	pred: UsagePrediction,
	resetTimeMs: number | null,
	now: number,
): ProjectedUsage | null {
	if (pred.state === "exhausted")
		return { message: "Quota exhausted", tone: "danger" };
	// Stable (or a non-positive slope) has no exhaustion to project — the bar
	// already shows the current %, so say nothing alarming.
	if (pred.state === "stable" || pred.slopePerHour <= 0) return null;
	if (pred.state === "rising" && pred.etaExhaustMs != null) {
		if (resetTimeMs != null) {
			if (pred.etaExhaustMs < resetTimeMs) {
				return {
					message: `Runs out ${formatDuration(resetTimeMs - pred.etaExhaustMs)} before reset`,
					tone: "danger",
				};
			}
			return {
				message: `Resets ${formatDuration(pred.etaExhaustMs - resetTimeMs)} before exhaustion`,
				tone: "safe",
			};
		}
		return {
			message: `Runs out in ${formatDuration(pred.etaExhaustMs - now)}`,
			tone: "danger",
		};
	}
	return null;
}
