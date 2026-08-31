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
import {
	formatUptime,
	statusColor,
	statusSummary,
} from "./system-status/system-status-utils";

export function SystemStatus() {
	const { data, isLoading, error } = useSystemStatus();

	// Three states (loading / unavailable / live), computed into `statusBody` so
	// the card's framing stays put while the endpoint is loading or unreachable.
	let statusBody: ReactElement;

	if (isLoading && !data) {
		statusBody = <div className="text-sm text-muted-foreground">Loading…</div>;
	} else if (error || !data) {
		statusBody = (
			<div className="flex flex-col items-start gap-row p-4 rounded-lg bg-muted/50 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex items-center gap-row">
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
				<CheckCircle className="h-5 w-5 text-success-strong" />
			) : status === "degraded" ? (
				<AlertTriangle className="h-5 w-5 text-warning-strong" />
			) : (
				<XCircle className="h-5 w-5 text-destructive-strong" />
			);

		const badge =
			status === "ok" ? (
				// The badge's own success variant, not `variant="default"` with a
				// `bg-success` override: that override left the default variant's
				// white text on top of it, which was unreadable on the pale green the
				// hand-written rule produced and no better on the registered green.
				// The variant itself pairs the green with `--success-foreground`, so
				// this reads at ~5.5:1 light / ~9.9:1 dark rather than white's ~2.2:1.
				<Badge variant="success">Healthy</Badge>
			) : status === "degraded" ? (
				// The badge's own warning variant, not `variant="default"` with a
				// `bg-warning` override: that override left the default variant's
				// white text on top of it, which was unreadable on the pale yellow the
				// hand-written rule produced and no better on the registered amber.
				// The variant itself pairs the amber with `--warning-foreground`, so
				// this reads at ~6:1 light / ~11:1 dark rather than white's ~1.9:1.
				<Badge variant="warning">Degraded</Badge>
			) : (
				<Badge variant="destructive">Unhealthy</Badge>
			);

		statusBody = (
			<>
				{/* Stacks below `sm`: the label, its description and the badge do not
				    fit on one line in a phone-width card, and a non-wrapping row
				    squeezed the description to a couple of words per line while the
				    badge kept its full width. */}
				<div
					className={`flex flex-col items-start gap-row p-4 rounded-lg sm:flex-row sm:items-center sm:justify-between ${tonePanel}`}
				>
					<div className="flex items-center gap-row">
						{icon}
						<div>
							<p className="font-medium">{label}</p>
							<p className="text-sm text-muted-foreground">{description}</p>
						</div>
					</div>
					{badge}
				</div>

				{/* One column below `sm`. Two 12px-padded panels side by side in a
				    phone-width card left each figure about 110px, which is narrower
				    than the "max (1m): 1,234 ms" line they have to carry. */}
				<div className="grid grid-cols-1 gap-group sm:grid-cols-2">
					{/* Uptime */}
					<div className="rounded-lg border p-row">
						<div className="flex items-center gap-item text-sm text-muted-foreground">
							<Clock className="h-4 w-4" />
							Uptime
						</div>
						<p className="mt-tight text-lg font-semibold tabular-nums">
							{formatUptime(uptime_s)}
						</p>
					</div>

					{/* Event-loop health: current lag + recent (~60s window) max. A
					    blocked main thread freezes all HTTP serving, so this is the
					    primary stall signal. Memory lives in the Memory Usage chart
					    further down this page. */}
					<div className="rounded-lg border p-row">
						<div className="flex items-center justify-between text-sm text-muted-foreground">
							<span className="flex items-center gap-item">
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
						<p className="mt-tight text-lg font-semibold tabular-nums">
							{formatLagMs(eventLoop?.lastLagMs)}
						</p>
						<p className="text-xs text-muted-foreground tabular-nums">
							max (1m): {formatLagMs(eventLoop?.maxRecentLagMs)}
						</p>
					</div>
				</div>

				{/* Pool summary. `usage_exhausted` is its own counter and NOT part of
				    `rate_limited`: an account sitting out a spent weekly or 5-hour
				    window has no cooldown lock, so without this cell a fully exhausted
				    pool read "0 routable, 0 rate-limited, 0 paused" with no
				    explanation. */}
				<dl className="grid grid-cols-2 gap-row text-sm sm:grid-cols-4">
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
								<span className="text-warning-strong">{pool.rate_limited}</span>
							) : (
								pool.rate_limited
							)}
						</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">Usage exhausted</dt>
						<dd className="font-medium tabular-nums">
							{(pool.usage_exhausted ?? 0) > 0 ? (
								<span className="text-warning-strong">
									{pool.usage_exhausted}
								</span>
							) : (
								(pool.usage_exhausted ?? 0)
							)}
						</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">Paused</dt>
						<dd className="font-medium tabular-nums">{pool.paused}</dd>
					</div>
				</dl>
			</>
		);
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>System Status</CardTitle>
				<CardDescription>
					Live health rollup, uptime, event-loop lag and account pool
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-group">{statusBody}</div>
			</CardContent>
		</Card>
	);
}
