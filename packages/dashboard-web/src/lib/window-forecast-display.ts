import type { RunwayWindowSummary } from "@clankermux/types";
import { formatDurationDhm } from "./format-prediction";

export function windowForecastMessage(
	window: RunwayWindowSummary,
	now: number,
): string {
	const forecast = window.forecast;
	if (!forecast) return "Forecast unavailable — no usable reading";
	if (window.resetsAtMs != null && window.resetsAtMs <= now) {
		return "Window reset — waiting for a fresh reading";
	}
	if (forecast.state === "learning") {
		if (forecast.reason === "unstarted")
			return "Not started — waiting for first use";
		if (forecast.reason === "no-usage") return "Waiting for nonzero usage";
		if (forecast.readyAtMs == null)
			return "Learning — waiting for more usage evidence";
		return forecast.readyAtMs > now
			? `Learning after reset or credit — about ${formatDurationDhm(forecast.readyAtMs - now)} remaining, then a fresh reading`
			: "Learning — waiting for a fresh reading";
	}
	const qualifier = forecast.lowConfidence ? " (rough estimate)" : "";
	if (window.utilizationPct != null && window.utilizationPct >= 100)
		return "Quota exhausted";
	if (
		forecast.exhaustsAtMs == null ||
		(window.resetsAtMs != null && forecast.exhaustsAtMs >= window.resetsAtMs)
	) {
		return `At this pace, on track to reset before running out${qualifier}`;
	}
	return forecast.exhaustsAtMs <= now
		? `Projected run-out reached — waiting for a fresh reading${qualifier}`
		: `At this pace, runs out in ${formatDurationDhm(forecast.exhaustsAtMs - now)}${qualifier}`;
}
