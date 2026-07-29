import type { SystemStatusResponse } from "@clankermux/types";
import {
	AlertTriangle,
	ChevronRight,
	Clock,
	Database,
	Zap,
} from "lucide-react";
import { Link } from "react-router";
import { useMemoryHistory, useSystemStatus } from "../../hooks/queries";
import { eventLoopTone, formatLagMs } from "../../lib/event-loop";
import { Badge } from "../ui/badge";
import { Card } from "../ui/card";
import { Sparkline } from "./Sparkline";
import {
	formatUptime,
	statusColor,
	statusSummary,
	statusTextClass,
} from "./system-status/system-status-utils";

const BYTES_PER_MB = 1024 * 1024;

/**
 * Range for the RSS trend line. Hourly buckets (see the server's
 * `getRangeConfig`), so at most 24 points — chunky, but 24h is the right window
 * to notice a leak at a glance. The full multi-series chart lives on /system.
 */
const SPARKLINE_RANGE = "24h";

interface SystemHealthStripViewProps {
	/** Live status payload, or null when it's loading/unreachable. */
	status: SystemStatusResponse | null;
	/** True only while the first fetch is in flight (no data yet). */
	isLoading?: boolean;
	/** RSS history in MB, oldest first. Empty renders no trend line. */
	rssHistoryMb: readonly number[];
	/**
	 * Visible (non-dismissed) recent-error groups. Must be filtered the same way
	 * as the list below the strip, or the pill claims errors that aren't shown.
	 */
	errorGroupCount: number;
}

/**
 * Presentational half — takes everything as props so it can be rendered
 * statically in tests. See {@link SystemHealthStrip} for the wired version.
 */
export function SystemHealthStripView({
	status,
	isLoading = false,
	rssHistoryMb,
	errorGroupCount,
}: SystemHealthStripViewProps) {
	const headline = status ? stripHeadline(status) : null;
	// A tinted panel inherits `text-foreground`; never pair a tone background
	// with another token's foreground (see the Badge variant comments).
	const tone =
		headline?.tone === "degraded"
			? "bg-warning/10"
			: headline?.tone === "unhealthy"
				? "bg-destructive/10"
				: "";

	const label = status
		? (headline?.label ?? "")
		: isLoading
			? "Checking status…"
			: "Status unavailable";
	const description = status
		? headline?.description
		: isLoading
			? null
			: "Could not reach the proxy status endpoint.";

	const lagTone = eventLoopTone(status?.eventLoop?.maxRecentLagMs);
	const integrity = status?.runtime?.integrityStatus;

	return (
		// No aria-label: it would REPLACE the accessible name rather than extend
		// it, so screen readers would hear only the headline and lose the uptime,
		// lag, RSS, integrity and error-count text. The sr-only span below appends
		// the link's purpose to the content-derived name instead.
		<Link
			to="/system"
			className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
		>
			<Card className={`px-4 py-3 ${tone}`}>
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
					<span className="flex items-center gap-2 whitespace-nowrap font-medium">
						<span
							className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground"
							style={
								headline
									? { backgroundColor: statusColor(headline.tone) }
									: undefined
							}
							aria-hidden="true"
						/>
						<span className={headline ? statusTextClass(headline.tone) : ""}>
							{label}
						</span>
					</span>

					{status ? (
						<>
							<span className="flex items-center gap-1.5 whitespace-nowrap tabular-nums text-muted-foreground">
								<Clock className="h-3.5 w-3.5" aria-hidden="true" />
								up {formatUptime(status.uptime_s)}
							</span>

							<span className="flex items-center gap-1.5 whitespace-nowrap tabular-nums text-muted-foreground">
								<Zap
									className={`h-3.5 w-3.5 ${
										lagTone === "ok"
											? ""
											: lagTone === "degraded"
												? "text-warning"
												: "text-destructive"
									}`}
									aria-hidden="true"
								/>
								loop {formatLagMs(status.eventLoop?.lastLagMs)}
							</span>

							{/* Live point-in-time RSS, deliberately NOT the last sparkline
							    point: history buckets carry the per-bucket MAX, so that
							    point reads high and would disagree with the sidebar. */}
							<span className="flex items-center gap-2 whitespace-nowrap tabular-nums text-muted-foreground">
								RSS {status.memory.rss_mb.toLocaleString()} MB
								<Sparkline
									values={rssHistoryMb}
									className="hidden h-5 w-20 shrink-0 text-primary sm:block"
								/>
							</span>

							{integrity ? (
								<span className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
									<Database
										className={`h-3.5 w-3.5 ${
											integrity === "corrupt"
												? "text-destructive"
												: integrity === "ok"
													? ""
													: "text-warning"
										}`}
										aria-hidden="true"
									/>
									DB {integrityLabel(integrity)}
								</span>
							) : null}
						</>
					) : null}

					{errorGroupCount > 0 ? (
						<Badge variant="destructive" className="gap-1 whitespace-nowrap">
							<AlertTriangle className="h-3 w-3" aria-hidden="true" />
							{errorGroupCount} error{errorGroupCount === 1 ? "" : "s"}
						</Badge>
					) : null}

					<span className="sr-only">Open the System Health page</span>

					<ChevronRight
						className="ml-auto h-4 w-4 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
				</div>

				{/* Own row: these strings run long ("All accounts usage-exhausted;
				    next recovers at 3:47:12 PM") and would reflow the strip into a
				    multi-line block if they sat inline. */}
				{description && (headline?.tone ?? "unhealthy") !== "ok" ? (
					<p className="mt-1.5 text-xs text-muted-foreground">{description}</p>
				) : null}
			</Card>
		</Link>
	);
}

/**
 * Headline label/description/tone for the strip.
 *
 * NOT just `statusSummary` + `status.status`: the server's rollup is computed
 * from the async writer and the account pool only — DB integrity is
 * deliberately excluded so a corrupt database can't 503 `/health` and pull the
 * proxy out of rotation (see `computeHealthStatus`). That's right for the
 * endpoint, but this strip puts the rollup and the integrity chip side by side,
 * so taking the rollup at face value would print a green "All Systems
 * Operational" next to "DB corrupt". Corruption escalates the headline here.
 *
 * `skipped` deliberately does not escalate: a check that couldn't finish is not
 * proven corruption, and its own chip already renders amber.
 */
export function stripHeadline(status: SystemStatusResponse): {
	label: string;
	description: string;
	tone: SystemStatusResponse["status"];
} {
	const summary = statusSummary(status);

	if (status.runtime?.integrityStatus === "corrupt") {
		return {
			label: "Database corruption detected",
			// `statusSummary` already appends the integrity suffix in its own
			// unhealthy branch, so reuse it rather than appending twice.
			description:
				status.status === "ok"
					? "The proxy is still serving requests; the last integrity check failed."
					: summary.description,
			tone: "unhealthy",
		};
	}

	return { ...summary, tone: status.status };
}

function integrityLabel(
	status: SystemStatusResponse["runtime"]["integrityStatus"],
): string {
	switch (status) {
		case "ok":
			return "verified";
		case "corrupt":
			return "corrupt";
		case "running":
			return "checking";
		case "skipped":
			return "check skipped";
		default:
			return "unchecked";
	}
}

interface SystemHealthStripProps {
	/** Non-dismissed recent-error groups, shared with the list below. */
	errorGroupCount: number;
}

/**
 * One-row health glance for the Overview, linking to the full /system page.
 *
 * Shares `useSystemStatus` with the sidebar status block, and applies the same
 * error rule it does, so the two never disagree.
 */
export function SystemHealthStrip({ errorGroupCount }: SystemHealthStripProps) {
	const { data, isLoading, error } = useSystemStatus();
	const { data: memory } = useMemoryHistory(SPARKLINE_RANGE);

	const rssHistoryMb = (memory?.points ?? []).map(
		(p) => p.rssBytes / BYTES_PER_MB,
	);

	return (
		<SystemHealthStripView
			// An errored poll drops back to "unavailable" rather than continuing to
			// present the last successful payload: React Query keeps `data` after a
			// refetch fails, so rendering it would show a stale snapshot as live —
			// and would contradict the sidebar, which already treats any error as
			// unknown.
			status={error ? null : (data ?? null)}
			isLoading={isLoading}
			rssHistoryMb={rssHistoryMb}
			errorGroupCount={errorGroupCount}
		/>
	);
}
