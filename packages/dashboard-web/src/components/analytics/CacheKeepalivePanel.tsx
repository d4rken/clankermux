import { formatUsd } from "@clankermux/ui-common";
import { Snowflake } from "lucide-react";
import { useMemo } from "react";
import {
	CartesianGrid,
	ComposedChart,
	Legend,
	Line,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { CHART_PROPS, COLORS, type TimeRange } from "../../constants";
import {
	useCacheKeepalive,
	useCacheKeepaliveHistory,
} from "../../hooks/queries";
import { formatAxisTime, formatTooltipTime } from "../../lib/time-format";
import { ChartContainer } from "../charts/ChartContainer";
import { ChartTooltip } from "../charts/ChartTooltip";
import { getChartHeight } from "../charts/chart-utils";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

const MODE_LABELS: Record<string, string> = {
	off: "Off",
	static: "Static",
	dynamic: "Dynamic",
};

const EMPTY_MESSAGE =
	"No keep-alive history yet — this chart fills in as snapshots accumulate over time. It starts empty after a restart and a full range needs the corresponding uptime.";

/** One Recharts row keyed by bucket timestamp. */
interface KeepaliveRow {
	ts: number;
	spentUsd: number;
	savedUsd: number;
	/** Hit rate as a 0..100 percentage (history hitRate is 0..1). */
	hitRatePct: number;
}

/**
 * Small headline tile for the live cache-keepalive stats. Mirrors the
 * compact stat-card idiom used by TokenSpeedAnalytics.
 */
function StatTile({
	label,
	value,
	sub,
	valueClassName,
}: {
	label: string;
	value: string;
	sub?: string;
	valueClassName?: string;
}) {
	return (
		<div className="rounded-lg border bg-card p-3">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p className={`text-xl font-bold ${valueClassName ?? ""}`}>{value}</p>
			{sub ? (
				<p className="text-xs text-muted-foreground mt-0.5">{sub}</p>
			) : null}
		</div>
	);
}

/**
 * Analytics-tab cache-keepalive "Live Status & History" panel. Headline tiles
 * come from the live endpoint (cumulative-since-restart); the chart plots
 * per-bucket spent vs saved USD plus the hit-rate line over the `range` supplied
 * by the enclosing CacheKeepaliveSection. Built directly on recharts primitives
 * like MemoryUsageChart since it composes a dual-axis chart.
 */
export function CacheKeepalivePanel({ range }: { range: TimeRange }) {
	const { data: live, isLoading: liveLoading } = useCacheKeepalive();
	const { data: history, isLoading: historyLoading } =
		useCacheKeepaliveHistory(range);

	const rows = useMemo<KeepaliveRow[]>(() => {
		const points = history?.points ?? [];
		return points.map((p) => ({
			ts: p.ts,
			spentUsd: p.spentUsd,
			savedUsd: p.savedUsd,
			hitRatePct: p.hitRate * 100,
		}));
	}, [history]);

	// Need at least two points to draw a meaningful trend.
	const isEmpty = rows.length < 2;

	const modeLabel = live ? (MODE_LABELS[live.mode] ?? live.mode) : "—";
	const netUsd = live?.netUsd ?? 0;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Snowflake className="h-5 w-5" />
					Live Status &amp; History
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				{/* Live headline tiles (cumulative since the last restart). */}
				<div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
					<StatTile label="Mode" value={modeLabel} />
					<StatTile
						label="Warm sessions"
						value={liveLoading ? "—" : String(live?.warmSessions ?? 0)}
						sub={`${live?.promotedSessions ?? 0} on 1h`}
					/>
					<StatTile
						label="Hit rate"
						value={
							liveLoading ? "—" : `${((live?.hitRate ?? 0) * 100).toFixed(1)}%`
						}
					/>
					<StatTile
						label="Spent"
						value={liveLoading ? "—" : formatUsd(live?.spentUsd ?? 0)}
					/>
					<StatTile
						label="Saved"
						value={liveLoading ? "—" : formatUsd(live?.savedUsd ?? 0)}
					/>
					<StatTile
						label="Net"
						value={liveLoading ? "—" : formatUsd(netUsd)}
						valueClassName={netUsd >= 0 ? "text-green-600" : "text-destructive"}
						sub={`${live?.warmResumes ?? 0} resumes · ${live?.failures ?? 0} failures`}
					/>
				</div>

				{/* Per-bucket spent vs saved (USD, left axis) + hit-rate line (right axis). */}
				<ChartContainer
					loading={historyLoading}
					height="medium"
					isEmpty={isEmpty}
					emptyState={
						<p className="max-w-md text-center text-sm text-muted-foreground">
							{EMPTY_MESSAGE}
						</p>
					}
				>
					<ResponsiveContainer width="100%" height={getChartHeight("medium")}>
						<ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0 }}>
							<CartesianGrid
								strokeDasharray={CHART_PROPS.strokeDasharray}
								className={CHART_PROPS.gridClassName}
							/>
							<XAxis
								dataKey="ts"
								className="text-xs"
								height={30}
								tickFormatter={(value) => formatAxisTime(Number(value), range)}
							/>
							<YAxis
								yAxisId="usd"
								className="text-xs"
								width={64}
								tickFormatter={(value) => formatUsd(Number(value))}
							/>
							{/* Right axis for the hit-rate line, pinned to 0–100%. */}
							<YAxis
								yAxisId="rate"
								orientation="right"
								className="text-xs"
								width={48}
								domain={[0, 100]}
								tickFormatter={(value) => `${Math.round(Number(value))}%`}
							/>
							<Tooltip
								content={
									<ChartTooltip
										formatters={{
											spentUsd: (value) => formatUsd(Number(value)),
											savedUsd: (value) => formatUsd(Number(value)),
											hitRatePct: (value) => `${Number(value).toFixed(1)}%`,
										}}
										labelFormatter={(label, payload) => {
											const ts = payload?.[0]?.payload?.ts;
											return typeof ts === "number"
												? formatTooltipTime(ts, range)
												: label;
										}}
									/>
								}
							/>
							<Legend verticalAlign="top" height={36} iconType="rect" />
							<Line
								yAxisId="usd"
								type="monotone"
								dataKey="spentUsd"
								name="Spent"
								stroke={COLORS.warning}
								strokeWidth={2}
								dot={false}
								isAnimationActive={false}
							/>
							<Line
								yAxisId="usd"
								type="monotone"
								dataKey="savedUsd"
								name="Saved"
								stroke={COLORS.success}
								strokeWidth={2}
								dot={false}
								isAnimationActive={false}
							/>
							<Line
								yAxisId="rate"
								type="monotone"
								dataKey="hitRatePct"
								name="Hit rate"
								stroke={COLORS.blue}
								strokeWidth={1}
								dot={false}
								isAnimationActive={false}
							/>
						</ComposedChart>
					</ResponsiveContainer>
				</ChartContainer>

				<p className="text-xs text-muted-foreground">
					Headline counters (hit rate, spent, saved, net, resumes, failures) are
					cumulative since the last restart; the chart shows per-bucket activity
					over the selected range.
				</p>
			</CardContent>
		</Card>
	);
}
