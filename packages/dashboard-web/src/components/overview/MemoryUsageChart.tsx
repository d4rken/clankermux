import type { MemoryHistoryResponse } from "@clankermux/types";
import { formatNumber } from "@clankermux/ui-common";
import { useMemo } from "react";
import {
	Area,
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
import { formatAxisTime, formatTooltipTime } from "../../lib/time-format";
import { ChartContainer } from "../charts/ChartContainer";
import { ChartTooltip } from "../charts/ChartTooltip";
import { getChartHeight } from "../charts/chart-utils";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { TimeRangeSelector } from "./TimeRangeSelector";

interface MemoryUsageChartProps {
	memoryHistory: MemoryHistoryResponse | undefined;
	loading: boolean;
	/** Selected time range (controlled); also re-keys the parent's memory-history query. */
	range: string;
	onRangeChange: (range: string) => void;
}

const GRADIENT_ID = "memoryUsageRssGradient";

/** One Recharts row keyed by bucket timestamp; sizes pre-converted to MB. */
interface MemoryRow {
	ts: number;
	rssMb: number;
	heapMb: number;
	/** Committed heap; null for buckets sampled before the column existed. */
	heapTotalMb: number | null;
}

const BYTES_PER_MB = 1024 * 1024;

const EMPTY_MESSAGE =
	"Collecting data — this graph fills in as memory samples accumulate (one per minute). History starts at deploy; a full 7-day view needs about a week of uptime.";

/**
 * Overview "Memory Usage" chart: the proxy process's own RSS (filled area),
 * committed JS heap, and used JS heap (lines) over a configurable range. RSS
 * climbing while heap stays flat is the classic native-leak signal — the band
 * between RSS and heap-committed is non-heap (native) memory, while the
 * committed-vs-used gap is GC headroom. Built directly on recharts primitives
 * (like RequestVolumeSuccessChart) since the Area + Line composition can't be
 * expressed through the single-series Base* chart wrappers.
 */
export function MemoryUsageChart({
	memoryHistory,
	loading,
	range,
	onRangeChange,
}: MemoryUsageChartProps) {
	const rows = useMemo<MemoryRow[]>(() => {
		const points = memoryHistory?.points ?? [];
		return points.map((p) => ({
			ts: p.ts,
			rssMb: Math.round(p.rssBytes / BYTES_PER_MB),
			heapMb: Math.round(p.heapUsedBytes / BYTES_PER_MB),
			heapTotalMb:
				p.heapTotalBytes == null
					? null
					: Math.round(p.heapTotalBytes / BYTES_PER_MB),
		}));
	}, [memoryHistory]);

	// Need at least two points to draw a meaningful trend.
	const isEmpty = rows.length < 2;
	const tr = range as TimeRange;

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between gap-4">
					<div>
						<CardTitle>Memory Usage</CardTitle>
						<CardDescription>
							Proxy process memory over time (MB). RSS is the filled area;
							committed and used JS heap are the lines — a widening RSS-vs-heap
							gap is native (non-heap) memory.
						</CardDescription>
					</div>
					<TimeRangeSelector value={range} onChange={onRangeChange} />
				</div>
			</CardHeader>
			<CardContent>
				<ChartContainer
					loading={loading}
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
							<defs>
								<linearGradient id={GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
									<stop
										offset="5%"
										stopColor={COLORS.primary}
										stopOpacity={0.7}
									/>
									<stop
										offset="95%"
										stopColor={COLORS.primary}
										stopOpacity={0.05}
									/>
								</linearGradient>
							</defs>
							<CartesianGrid
								strokeDasharray={CHART_PROPS.strokeDasharray}
								className={CHART_PROPS.gridClassName}
							/>
							<XAxis
								dataKey="ts"
								className="text-xs"
								height={30}
								tickFormatter={(value) => formatAxisTime(Number(value), tr)}
							/>
							<YAxis
								className="text-xs"
								width={56}
								tickFormatter={(value) => `${formatNumber(Number(value))} MB`}
							/>
							<Tooltip
								content={
									<ChartTooltip
										formatters={{
											rssMb: (value) => `${formatNumber(Number(value))} MB`,
											heapTotalMb: (value) =>
												typeof value === "number"
													? `${formatNumber(value)} MB`
													: "n/a",
											heapMb: (value) => `${formatNumber(Number(value))} MB`,
										}}
										labelFormatter={(label, payload) => {
											// Resolve the header from the hovered bucket's `ts` so it
											// always carries the date+time, even when the compact axis
											// tick omits the date on short ranges.
											const ts = payload?.[0]?.payload?.ts;
											return typeof ts === "number"
												? formatTooltipTime(ts, tr)
												: label;
										}}
									/>
								}
							/>
							<Legend verticalAlign="top" height={36} iconType="rect" />
							<Area
								type="monotone"
								dataKey="rssMb"
								name="RSS"
								stroke={COLORS.primary}
								strokeWidth={2}
								fillOpacity={1}
								fill={`url(#${GRADIENT_ID})`}
								isAnimationActive={false}
							/>
							<Line
								type="monotone"
								dataKey="heapTotalMb"
								name="Heap (committed)"
								stroke={COLORS.purple}
								strokeWidth={2}
								dot={false}
								connectNulls
								isAnimationActive={false}
							/>
							<Line
								type="monotone"
								dataKey="heapMb"
								name="Heap (used)"
								stroke={COLORS.blue}
								strokeWidth={2}
								dot={false}
								isAnimationActive={false}
							/>
						</ComposedChart>
					</ResponsiveContainer>
				</ChartContainer>
			</CardContent>
		</Card>
	);
}
