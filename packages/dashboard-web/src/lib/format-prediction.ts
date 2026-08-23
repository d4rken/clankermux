import type { UsagePrediction } from "@clankermux/types";

/**
 * Severity of a usage projection, keyed off what the projection actually means
 * rather than instantaneous pacing:
 *  - "danger":  the window has run out, or is projected to run out before it
 *               resets by a margin wide enough that the projection's own error
 *               cannot flip it. Having already run out is an observation rather
 *               than an extrapolation, so it takes this tier with no margin
 *               test — there is nothing left to be uncertain about.
 *  - "warning": the window is projected to run out early, but the claim rests on
 *               a thin margin or on the weaker of the two projection paths.
 *  - "safe":    the window resets before it would exhaust — the reassuring case.
 *  - "neutral": nothing to project yet (no usage recorded).
 * Both the projection line and the progress bar's fill are colored from this, so
 * a reassuring "Resets … before exhaustion" message never renders in an alarming
 * red just because usage happens to be ahead of a flat time-linear pace, and the
 * bar and the message can never disagree about how bad a window is.
 */
export type ProjectionTone = "danger" | "warning" | "safe" | "neutral";

export interface ProjectedUsage {
	message: string;
	tone: ProjectionTone;
}

/**
 * Copy for the reassuring "safe" projection — the window will reset before it
 * would exhaust. The time-until-exhaustion is an unbounded linear extrapolation
 * that balloons to hundreds of hours when a window is barely used (e.g. "Resets
 * 1000h before exhaustion"), so the gap is stated qualitatively rather than as a
 * meaningless large number. The bounded "danger" case still shows a concrete
 * figure. Shared by both projection paths so they read identically.
 */
export const RESETS_BEFORE_EXHAUSTION_MESSAGE =
	"On track to reset before running out";

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
 * Formats a positive millisecond duration as the two largest meaningful units:
 * "Xd Yh" from a day up, "Xh Ym" below that, "Ym" under an hour. Distinct from
 * {@link formatDuration}, whose callers depend on the unbounded-hours shape;
 * this one is for spans that routinely run into days (quota runway, next
 * checkpoint).
 */
export function formatDurationDhm(ms: number): string {
	const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;
	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0 && days === 0) parts.push(`${minutes}m`);
	return parts.join(" ");
}

/**
 * How far projected exhaustion must fall short of the reset before a "runs out
 * early" projection is treated as certain enough to render red rather than
 * amber, as a fraction of the window's own length.
 *
 * The prediction is a linear extrapolation of a recent slope, so a projection
 * landing barely on the wrong side of the reset sits inside its own error: a
 * five-minute margin on a five-hour window is reversed by a slope estimate a few
 * percent flatter. Expressing the threshold as a fraction lets it scale with how
 * far the extrapolation has to reach — 30 minutes on a five-hour window, about
 * 17 hours on a weekly one.
 */
const CERTAIN_MARGIN_FRACTION = 0.1;

/**
 * Tone for a projection that exhausts before its reset. Red is reserved for a
 * margin wide enough to survive the extrapolation's own error; a tighter margin,
 * or a window whose length is unknown and whose margin therefore has nothing to
 * be measured against, stays amber.
 *
 * Exported so the fallback projection can share the rule. Callers must cap it at
 * "warning" for a low-confidence estimate: red is reserved for the regression.
 */
export function earlyExhaustionTone(
	marginMs: number,
	windowDurationMs: number | null,
): ProjectionTone {
	if (windowDurationMs === null || !(windowDurationMs > 0)) return "warning";
	return marginMs > CERTAIN_MARGIN_FRACTION * windowDurationMs
		? "danger"
		: "warning";
}

/**
 * Renders the server-computed regression prediction in the same copy style as
 * the legacy `computeProjectedMessage`. Pure and deterministic — `now` is passed
 * in. Returns null when there is no alarming message to show (stable / negative
 * slope), so the caller can fall through to the neutral pace message.
 *
 * The returned `tone` reflects the projection's meaning so the caller can color
 * the line and the bar correctly: resetting before exhaustion is "safe" (green),
 * running out before reset is "danger" (red) or "warning" (amber) depending on
 * how much of `windowDurationMs` separates exhaustion from the reset.
 *
 * `windowDurationMs` is the full length of the window the reset belongs to, or
 * null when it can't be derived; without it the margin can't be judged and the
 * early-exhaustion cases cap out at "warning".
 *
 * The caller must first gate on `isUsablePrediction`; this only formats.
 */
export function formatPredictionMessage(
	pred: UsagePrediction,
	resetTimeMs: number | null,
	now: number,
	windowDurationMs: number | null,
): ProjectedUsage | null {
	// Exhaustion is an observation rather than an extrapolation, so it is
	// unconditionally the top severity — there is no margin to be uncertain about.
	if (pred.state === "exhausted")
		return { message: "Quota exhausted", tone: "danger" };
	// Stable (or a non-positive slope) has no exhaustion to project — the bar
	// already shows the current %, so say nothing alarming.
	if (pred.state === "stable" || pred.slopePerHour <= 0) return null;
	if (pred.state === "rising" && pred.etaExhaustMs != null) {
		if (resetTimeMs != null) {
			if (pred.etaExhaustMs < resetTimeMs) {
				const marginMs = resetTimeMs - pred.etaExhaustMs;
				return {
					message: `Runs out ${formatDuration(marginMs)} before reset`,
					tone: earlyExhaustionTone(marginMs, windowDurationMs),
				};
			}
			return {
				message: RESETS_BEFORE_EXHAUSTION_MESSAGE,
				tone: "safe",
			};
		}
		// No reset to run out "before" means no margin at all to measure, so the
		// tier rule cannot reach red however near the ETA is.
		return {
			message: `Runs out in ${formatDuration(pred.etaExhaustMs - now)}`,
			tone: "warning",
		};
	}
	return null;
}
