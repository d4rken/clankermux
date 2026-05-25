import { AlertTriangle, CheckCircle, Clock, Cpu, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSystemStatus } from "../../hooks/queries";
import { Badge } from "../ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import {
	type MemorySample,
	MemorySparkline,
} from "./system-status/MemorySparkline";
import { RecentErrorsCard } from "./system-status/RecentErrorsCard";
import {
	formatUptime,
	statusColor,
	statusSummary,
} from "./system-status/system-status-utils";

// Keep ~5 minutes of history at the 10s healthy poll cadence.
const MAX_SAMPLES = 30;

export function SystemStatus() {
	const { data, isLoading, error } = useSystemStatus();

	// Ring buffer of RSS samples, accumulated client-side across polls (the
	// server keeps no time series). Keyed on `timestamp` so each distinct poll
	// appends exactly one sample even across re-renders.
	const [samples, setSamples] = useState<MemorySample[]>([]);
	const lastTsRef = useRef<string | null>(null);

	useEffect(() => {
		if (!data || data.timestamp === lastTsRef.current) return;
		lastTsRef.current = data.timestamp;
		setSamples((prev) => {
			const next = [
				...prev,
				{ t: Date.parse(data.timestamp), rss: data.memory.rss_mb },
			];
			return next.length > MAX_SAMPLES ? next.slice(-MAX_SAMPLES) : next;
		});
	}, [data]);

	if (isLoading && !data) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>System Status</CardTitle>
					<CardDescription>
						Current operational status and recent events
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="text-sm text-muted-foreground">Loading…</div>
				</CardContent>
			</Card>
		);
	}

	if (error || !data) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>System Status</CardTitle>
					<CardDescription>
						Current operational status and recent events
					</CardDescription>
				</CardHeader>
				<CardContent>
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
				</CardContent>
			</Card>
		);
	}

	const { status, pool, memory, uptime_s } = data;
	const { label, description } = statusSummary(data);
	const color = statusColor(status);

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

						{/* Memory (RSS) with sparkline */}
						<div className="rounded-lg border p-3">
							<div className="flex items-center justify-between text-sm text-muted-foreground">
								<span className="flex items-center gap-2">
									<Cpu className="h-4 w-4" />
									Memory (RSS)
								</span>
								<span className="font-semibold tabular-nums text-foreground">
									{memory.rss_mb} MB
								</span>
							</div>
							<div className="mt-1">
								<MemorySparkline data={samples} color={color} height={40} />
							</div>
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
				</div>
			</CardContent>
		</Card>
	);
}
