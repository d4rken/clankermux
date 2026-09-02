/**
 * Shared throttle calculation utilities for usage window calculations.
 * Used by both proxy (server) and dashboard (client).
 */

export type SupportedWindow =
	| "five_hour"
	| "seven_day"
	| "weekly"
	| "daily"
	| "monthly"
	| "tokens_limit";

/**
 * Fixed window durations in milliseconds.
 * Note: monthly windows have variable duration (28-31 days) and are handled separately.
 *
 * Keyed by string, and deliberately WIDER than `SupportedWindow`: the dashboard
 * resolves window starts for display-only window kinds
 * (`seven_day_opus`/`seven_day_sonnet`/`seven_day_scoped`) that the proactive
 * throttle no longer emits.
 */
export const FIXED_WINDOW_DURATION_MS: Record<string, number> = {
	five_hour: 5 * 60 * 60 * 1000,
	seven_day: 7 * 24 * 60 * 60 * 1000,
	seven_day_opus: 7 * 24 * 60 * 60 * 1000,
	seven_day_sonnet: 7 * 24 * 60 * 60 * 1000,
	seven_day_scoped: 7 * 24 * 60 * 60 * 1000,
	weekly: 7 * 24 * 60 * 60 * 1000,
	daily: 24 * 60 * 60 * 1000,
	// time_limit intentionally omitted — ZAI's TIME_LIMIT window duration is unknown
	tokens_limit: 5 * 60 * 60 * 1000,
};

/**
 * Calculate the start time of a usage window given its reset time and window type.
 *
 * For monthly windows: uses preceding month's duration to handle 28/29/30/31 day variations.
 * For fixed windows: uses FIXED_WINDOW_DURATION_MS lookup.
 *
 * @param resetMs - Reset timestamp in milliseconds
 * @param window - Window type (e.g., "five_hour", "seven_day", "monthly")
 * @param durationMs - Data-derived window length, for providers that report one
 *   per reading (MiniMax) instead of running fixed windows. Takes precedence
 *   over both the monthly calendar arithmetic and the name lookup; ignored when
 *   it is not a finite positive number, which keeps every existing caller
 *   byte-identical.
 * @returns Window start timestamp in milliseconds, or null if invalid
 */
export function computeWindowStartMs(
	resetMs: number,
	window: SupportedWindow | string,
	durationMs?: number,
): number | null {
	if (!Number.isFinite(resetMs)) return null;

	if (
		typeof durationMs === "number" &&
		Number.isFinite(durationMs) &&
		durationMs > 0
	) {
		return resetMs - durationMs;
	}

	if (window === "monthly") {
		const resetDate = new Date(resetMs);
		// Calculate preceding month's duration (handles 28/29/30/31 days)
		const monthStart = Date.UTC(
			resetDate.getUTCFullYear(),
			resetDate.getUTCMonth(),
			1,
			0,
			0,
			0,
			0,
		);
		const prevMonthStart = Date.UTC(
			resetDate.getUTCFullYear(),
			resetDate.getUTCMonth() - 1,
			1,
			0,
			0,
			0,
			0,
		);
		const actualMonthDurationMs = monthStart - prevMonthStart;
		return resetMs - actualMonthDurationMs;
	}

	const fixedDurationMs = FIXED_WINDOW_DURATION_MS[window];
	return fixedDurationMs ? resetMs - fixedDurationMs : null;
}

/**
 * Where a window's utilization would sit (0-100) if it were burned perfectly
 * evenly — pure clock arithmetic, no forecasting. This positions the pace tick
 * on dashboard usage bars and is the pace baseline the proactive usage
 * throttle compares real utilization against, so both must share this one
 * definition. Null when the reset is not a finite timestamp or the window name
 * has no known duration.
 */
export function computeExpectedPct(
	resetMs: number,
	window: SupportedWindow | string,
	now: number,
	windowDurationMs?: number,
): number | null {
	if (!Number.isFinite(resetMs)) return null;
	const startMs = computeWindowStartMs(resetMs, window, windowDurationMs);
	if (startMs === null) return null;
	const durationMs = resetMs - startMs;
	if (durationMs <= 0) return null;
	const elapsedMs = now - startMs;
	return Math.min(100, Math.max(0, (elapsedMs / durationMs) * 100));
}

/**
 * The instant an even burn would catch up with the window's actual
 * utilization: the moment proactive usage throttling would release a request,
 * capped at the window reset. Null when the window is not throttleable right
 * now — reset passed or window not yet started (clock skew), utilization at or
 * behind pace, or the window/reset unusable. Both the server's throttle
 * decision and the dashboard's "delayed until" line derive from this one
 * function so the UI can never disagree with the behaviour it explains.
 *
 * `windowDurationMs` is the data-derived window length for providers that
 * report one per reading; see {@link computeWindowStartMs}.
 */
export function computeThrottleResumeAt(
	resetMs: number,
	window: SupportedWindow | string,
	utilizationPct: number,
	now: number,
	windowDurationMs?: number,
): number | null {
	if (!Number.isFinite(resetMs) || resetMs <= now) return null;
	const startMs = computeWindowStartMs(resetMs, window, windowDurationMs);
	if (startMs === null || startMs >= resetMs) return null;
	if (now - startMs <= 0) return null;

	const expectedPct = computeExpectedPct(
		resetMs,
		window,
		now,
		windowDurationMs,
	);
	if (expectedPct === null || utilizationPct <= expectedPct) return null;

	const durationMs = resetMs - startMs;
	const resumeAt = Math.min(
		startMs + (utilizationPct / 100) * durationMs,
		resetMs,
	);
	return resumeAt > now ? resumeAt : null;
}
