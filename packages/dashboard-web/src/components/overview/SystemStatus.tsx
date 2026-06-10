import {
	Activity,
	AlertTriangle,
	CheckCircle,
	Clock,
	XCircle,
} from "lucide-react";
import type { ReactElement } from "react";
import { useSystemStatus } from "../../hooks/queries";
import { eventLoopTone, formatLagMs } from "../../lib/event-loop";
import { Badge } from "../ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { StorageIntegritySection } from "./StorageIntegrity";
import { RecentErrorsCard } from "./system-status/RecentErrorsCard";
import {
	formatUptime,
	statusColor,
	statusSummary,
} from "./system-status/system-status-utils";

export function SystemStatus() {
	const { data, isLoading, error } = useSystemStatus();

	// The system-status portion has three states (loading / unavailable / live).
	// It's computed into `statusBody` so the storage-integrity sub-section below
	// always renders, even while the status endpoint is loading or unreachable.
	let statusBody: ReactElement;

	if (isLoading && !data) {
		statusBody = <div className="text-sm text-muted-foreground">Loading…</div>;
	} else if (error || !data) {
		statusBody = (
			<div className="flex items-center justify-between p-4 rounded-lg bg-muted/50">
				<div className="flex items-center gap-3">
					<AlertTriangle className="h-5 w-5 text-muted-foreground" />
					<div>
						<p className="font-medium">Status unavailable</p>
						<p className="text-sm text-muted-foreground">
							Could not reach the proxy status endpoint.
						</p>
					</div>
				</div>
				<Badge variant="secondary">Unknown</Badge>
			</div>
		);
	} else {
		const { status, pool, eventLoop, uptime_s } = data;
		const { label, description } = statusSummary(data);
		// Health tone for the event-loop row: keyed on the ~60s rolling max so a
		// stall stays visible for a minute, mirroring the monitor's WARN/ERROR
		// thresholds (250 ms / 2000 ms).
		const lagTone = eventLoopTone(eventLoop?.maxRecentLagMs);

		const tonePanel =
			status === "ok"
				? "bg-success/10"
				: status === "degraded"
					? "bg-warning/10"
					: "bg-destructive/10";

		const icon =
			status === "ok" ? (
				<CheckCircle className="h-5 w-5 text-success" />
			) : status === "degraded" ? (
				<AlertTriangle className="h-5 w-5 text-warning" />
			) : (
				<XCircle className="h-5 w-5 text-destructive" />
			);

		const badge =
			status === "ok" ? (
				<Badge variant="default" className="bg-success">
					Healthy
				</Badge>
			) : status === "degraded" ? (
				<Badge variant="default" className="bg-warning">
					Degraded
				</Badge>
			) : (
				<Badge variant="destructive">Unhealthy</Badge>
			);

		statusBody = (
			<>
				<div
					className={`flex items-center justify-between p-4 rounded-lg ${tonePanel}`}
				>
					<div className="flex items-center gap-3">
						{icon}
						<div>
							<p className="font-medium">{label}</p>
							<p className="text-sm text-muted-foreground">{description}</p>
						</div>
					</div>
					{badge}
				</div>

				<div className="grid grid-cols-2 gap-4">
					{/* Uptime */}
					<div className="rounded-lg border p-3">
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Clock className="h-4 w-4" />
							Uptime
						</div>
						<p className="mt-1 text-lg font-semibold tabular-nums">
							{formatUptime(uptime_s)}
						</p>
					</div>

					{/* Event-loop health: current lag + recent (~60s window) max. A
					    blocked main thread freezes all HTTP serving, so this is the
					    primary stall signal. Memory moved to the chart below. */}
					<div className="rounded-lg border p-3">
						<div className="flex items-center justify-between text-sm text-muted-foreground">
							<span className="flex items-center gap-2">
								<Activity className="h-4 w-4" />
								Event loop
							</span>
							<span
								className="inline-block h-2.5 w-2.5 rounded-full"
								style={{ backgroundColor: statusColor(lagTone) }}
								title={
									lagTone === "ok"
										? "Event loop responsive"
										: lagTone === "degraded"
											? "Event loop lag ≥ 250 ms in the last minute"
											: "Event loop stalled ≥ 2 s in the last minute"
								}
								aria-hidden
							/>
						</div>
						<p className="mt-1 text-lg font-semibold tabular-nums">
							{formatLagMs(eventLoop?.lastLagMs)}
						</p>
						<p className="text-xs text-muted-foreground tabular-nums">
							max (1m): {formatLagMs(eventLoop?.maxRecentLagMs)}
						</p>
					</div>
				</div>

				{/* Pool summary */}
				<dl className="grid grid-cols-3 gap-3 text-sm">
					<div>
						<dt className="text-muted-foreground">Routable</dt>
						<dd className="font-medium tabular-nums">
							{pool.routable} / {pool.configured}
						</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">Rate-limited</dt>
						<dd className="font-medium tabular-nums">
							{pool.rate_limited > 0 ? (
								<span className="text-warning">{pool.rate_limited}</span>
							) : (
								pool.rate_limited
							)}
						</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">Paused</dt>
						<dd className="font-medium tabular-nums">{pool.paused}</dd>
					</div>
				</dl>

				<RecentErrorsCard />
			</>
		);
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>System Status</CardTitle>
				<CardDescription>
					Current operational status and recent events
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-4">
					{statusBody}

					{/* Storage integrity, merged in from its former standalone card */}
					<div className="border-t pt-4 space-y-3">
						<div>
							<p className="text-sm font-medium">Storage Integrity</p>
							<p className="text-xs text-muted-foreground">
								Periodic SQLite integrity check (quick + full).
							</p>
						</div>
						<StorageIntegritySection />
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
