import type { SystemStatusResponse } from "@clankermux/types";
import { CHART_TOKENS } from "../../../constants";

export type SystemTone = "ok" | "degraded" | "unhealthy";

/** Format a process uptime (seconds) as a compact human string. */
export function formatUptime(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "—";
	const s = Math.floor(seconds);
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s % 60}s`;
	return `${s}s`;
}

/**
 * Colour for a status, as a CSS custom property.
 *
 * Every consumer hands the result to an inline `style`, so the browser
 * resolves it and the dot follows the colour mode with nothing threaded
 * through React.
 */
export function statusColor(status: SystemStatusResponse["status"]): string {
	switch (status) {
		case "ok":
			return CHART_TOKENS.success;
		case "degraded":
			return CHART_TOKENS.warning;
		default:
			return CHART_TOKENS.error;
	}
}

/** Tailwind text-color token for a status. */
export function statusTextClass(
	status: SystemStatusResponse["status"],
): string {
	switch (status) {
		case "ok":
			return "text-success";
		case "degraded":
			return "text-warning";
		default:
			return "text-destructive";
	}
}

/**
 * Human-readable reason for a non-ok status, derived from the runtime + pool
 * signals. Returns a short "all good" line when healthy. The checks mirror the
 * precedence in the backend's `computeHealthStatus`.
 */
export function statusSummary(data: SystemStatusResponse): {
	label: string;
	description: string;
} {
	const { status, pool, runtime } = data;

	if (status === "ok") {
		return {
			label: "All Systems Operational",
			description: "No issues detected",
		};
	}

	if (status === "degraded") {
		const when = pool.next_available_at
			? new Date(pool.next_available_at).toLocaleTimeString()
			: null;
		// WHY the pool is empty matters to the operator: a spent usage window just
		// needs waiting out, a throttle may not. `usage_exhausted` is optional
		// (older servers omit it), and the two counters are mutually exclusive per
		// account, so a non-zero pair means a mixed pool — neither headline is true
		// then, so say something neutral.
		const exhausted = pool.usage_exhausted ?? 0;
		const subject =
			exhausted > 0
				? pool.rate_limited === 0
					? "All accounts usage-exhausted"
					: "No accounts available"
				: "All accounts rate-limited";
		return {
			label: "Degraded — capacity limited",
			description: when
				? `${subject}; next recovers at ${when}`
				: `${subject}; recovering`,
		};
	}

	// unhealthy — pick the most specific cause
	let description = "Service is unhealthy";
	if (pool.configured === 0) {
		description = "No accounts configured";
	} else if (!runtime.asyncWriterHealthy) {
		description = "Async DB writer is failing";
	} else if (pool.routable === 0) {
		description = "No routable accounts available";
	}
	if (runtime.integrityStatus === "corrupt") {
		description += " · DB integrity check failed";
	} else if (runtime.integrityStatus === "skipped") {
		// Amber, not red: the check couldn't complete (timeout / size-skip),
		// which is not proven corruption — note it without the "failed" wording.
		description += " · DB integrity check skipped";
	}
	return { label: "Service Unhealthy", description };
}
