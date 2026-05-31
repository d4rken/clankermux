import type { SystemStatusResponse } from "@clankermux/types";
import { COLORS } from "../../../constants";

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

/** Hex color for a status, drawn from the shared palette. */
export function statusColor(status: SystemStatusResponse["status"]): string {
	switch (status) {
		case "ok":
			return COLORS.success;
		case "degraded":
			return COLORS.warning;
		default:
			return COLORS.error;
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
		return {
			label: "Degraded — capacity limited",
			description: when
				? `All accounts rate-limited; next recovers at ${when}`
				: "All accounts rate-limited; recovering",
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
	}
	return { label: "Service Unhealthy", description };
}
