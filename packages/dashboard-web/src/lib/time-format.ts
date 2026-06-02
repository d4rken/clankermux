import { format } from "date-fns";
import type { TimeRange } from "../constants";
import type { TooltipLabelFormatter } from "./chart-utils";

/**
 * Range-aware time formatting for analytics charts.
 *
 * Charts bake a *compact* label into each data point for the X-axis tick, and
 * derive a *rich*, unambiguous label for the hover tooltip from the raw
 * timestamp. The split exists because axes have many ticks (so labels must stay
 * short) while a tooltip shows one point at a time (so it can spell out the day).
 *
 * | range        | axis tick | tooltip            |
 * |--------------|-----------|--------------------|
 * | 1h/6h/24h    | 14:00     | 14:00              |
 * | 7d           | Jun 2     | Mon, Jun 2 · 14:00 |
 * | 30d          | Jun 2     | Mon, Jun 2         |
 *
 * 7d is hourly-bucketed, so its tooltip keeps the time-of-day; 30d is
 * daily-bucketed, so the time is dropped. Ranges of 24h or less stay
 * time-only — they're a single rolling day window.
 */

/** Compact label for an X-axis tick. */
export function formatAxisTime(ts: number, range: TimeRange): string {
	const date = new Date(ts);
	switch (range) {
		case "7d":
		case "30d":
			return format(date, "MMM d");
		default:
			return format(date, "HH:mm");
	}
}

/** Verbose, day-aware label for a hover tooltip. */
export function formatTooltipTime(ts: number, range: TimeRange): string {
	const date = new Date(ts);
	switch (range) {
		case "30d":
			return format(date, "EEE, MMM d");
		case "7d":
			return format(date, "EEE, MMM d · HH:mm");
		default:
			return format(date, "HH:mm");
	}
}

/**
 * Build a Recharts `labelFormatter` that renders the rich tooltip time from the
 * raw `ts` carried on each data point. Falls back to the axis label string if a
 * timestamp isn't present on the hovered payload (e.g. non-time charts).
 */
export function makeTimeTooltipLabelFormatter(
	range: TimeRange,
): TooltipLabelFormatter {
	return ((label, payload) => {
		const ts = Array.isArray(payload)
			? (payload[0]?.payload as { ts?: unknown } | undefined)?.ts
			: undefined;
		return typeof ts === "number"
			? formatTooltipTime(ts, range)
			: String(label ?? "");
	}) as TooltipLabelFormatter;
}
