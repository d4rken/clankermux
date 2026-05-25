import { useSystemStatus } from "../../../hooks/queries";
import {
	formatUptime,
	statusColor,
	statusTextClass,
} from "./system-status-utils";

/**
 * Compact live status block for the navigation sidebar footer. Replaces the
 * former hardcoded "All systems operational" text with a real colored dot
 * (driven by `/api/system/status`) plus current uptime and RSS.
 */
export function SidebarStatus() {
	const { data, isLoading, error } = useSystemStatus();

	const label =
		!data || error
			? "Unknown"
			: data.status === "ok"
				? "Operational"
				: data.status === "degraded"
					? "Degraded"
					: "Unhealthy";

	const dotColor = data && !error ? statusColor(data.status) : undefined;
	const textClass = data && !error ? statusTextClass(data.status) : "";

	return (
		<div className="rounded-lg bg-muted/50 p-3">
			<div className="flex items-center gap-2 text-sm">
				<span
					className="inline-block h-2.5 w-2.5 rounded-full bg-muted-foreground"
					style={dotColor ? { backgroundColor: dotColor } : undefined}
					aria-hidden
				/>
				<span className="font-medium">Status</span>
				<span className={`ml-auto text-xs font-medium ${textClass}`}>
					{isLoading && !data ? "…" : label}
				</span>
			</div>
			{data && !error ? (
				<p className="mt-1 text-xs text-muted-foreground tabular-nums">
					up {formatUptime(data.uptime_s)} · {data.memory.rss_mb} MB
				</p>
			) : (
				<p className="mt-1 text-xs text-muted-foreground">
					{error ? "status unavailable" : "loading…"}
				</p>
			)}
		</div>
	);
}
