// Event-loop lag display helpers, shared by the Overview memory chart's lag
// overlay and the System Status "Event loop" tile. Thresholds mirror the
// in-process monitor's WARN/ERROR levels (@clankermux/core event-loop-monitor).

/** Lag at or above this is a degraded signal (monitor WARN threshold). */
export const EVENT_LOOP_WARN_MS = 250;
/** Lag at or above this is an unhealthy signal (monitor ERROR threshold). */
export const EVENT_LOOP_ERROR_MS = 2000;

export type EventLoopTone = "ok" | "degraded" | "unhealthy";

/**
 * Map a recent-max lag reading onto the dashboard's health-tone vocabulary
 * (same union as the system status rollup, so `statusColor` can color it).
 * Missing/invalid readings count as ok — the monitor reports zeros when it
 * isn't running, and absence of a signal shouldn't look like a stall.
 */
export function eventLoopTone(
	maxRecentLagMs: number | null | undefined,
): EventLoopTone {
	if (maxRecentLagMs == null || !Number.isFinite(maxRecentLagMs)) return "ok";
	if (maxRecentLagMs >= EVENT_LOOP_ERROR_MS) return "unhealthy";
	if (maxRecentLagMs >= EVENT_LOOP_WARN_MS) return "degraded";
	return "ok";
}

/**
 * Format an event-loop lag value for display: "—" when missing (e.g. memory
 * snapshots that predate the lag column), "<1 ms" for sub-millisecond readings,
 * otherwise a rounded, locale-grouped "X ms".
 */
export function formatLagMs(value: number | null | undefined): string {
	if (value == null || !Number.isFinite(value) || value < 0) return "—";
	if (value < 1) return "<1 ms";
	return `${Math.round(value).toLocaleString()} ms`;
}
