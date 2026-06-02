import type { UsageHistoryResponse } from "@clankermux/types";
import { format } from "date-fns";
import { useMemo } from "react";
import { CHART_COLORS, COLORS } from "../../constants";
import { BaseLineChart } from "../charts";
import type { ChartDataPoint } from "../charts/types";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";

type SawtoothWindow = "five_hour" | "seven_day";

interface UsageSawtoothChartProps {
	usageHistory: UsageHistoryResponse | undefined;
	window: SawtoothWindow;
	loading: boolean;
}

/**
 * One Recharts row keyed by bucket timestamp. `time` is the formatted x-axis
 * label, `pool` is the windowed pool average, and each remaining key is an
 * accountId → that account's windowed utilization (null = honest gap). Recharts
 * renders nulls as line gaps; `ChartDataPoint` doesn't model null so we cast at
 * the chart boundary.
 */
interface SawtoothRow {
	ts: number;
	time: string;
	pool: number | null;
	[accountId: string]: number | string | null;
}

const EMPTY_MESSAGE =
	"Collecting data — this graph fills in as snapshots accumulate. History starts at deploy; a full 7-day view needs about a week of uptime.";

export function UsageSawtoothChart({
	usageHistory,
	window,
	loading,
}: UsageSawtoothChartProps) {
	const pool = usageHistory?.pool ?? [];
	const series = usageHistory?.series ?? [];
	const bucketMs = usageHistory?.bucketMs ?? 0;

	// Build a Map<ts, row>: pool aggregate + one key per account, then sort by ts.
	const data = useMemo<SawtoothRow[]>(() => {
		const rows = new Map<number, SawtoothRow>();

		// Daily buckets (30d range) floor to midnight, so "HH:mm" would render
		// the same "00:00" for every label — switch to a date label there.
		const timePattern = bucketMs >= 86_400_000 ? "MMM d" : "HH:mm";

		const rowFor = (ts: number): SawtoothRow => {
			let row = rows.get(ts);
			if (!row) {
				row = { ts, time: format(new Date(ts), timePattern), pool: null };
				rows.set(ts, row);
			}
			return row;
		};

		for (const p of pool) {
			const row = rowFor(p.ts);
			row.pool = window === "five_hour" ? p.fiveHourAvg : p.sevenDayAvg;
		}

		for (const s of series) {
			for (const point of s.points) {
				const row = rowFor(point.ts);
				row[s.accountId] =
					window === "five_hour" ? point.fiveHourPct : point.sevenDayPct;
			}
		}

		return Array.from(rows.values()).sort((a, b) => a.ts - b.ts);
	}, [pool, series, window, bucketMs]);

	// Bold pool line first, then one line per account from the shared palette.
	const lines = useMemo(
		() => [
			{
				dataKey: "pool",
				name: "Pool (avg)",
				strokeWidth: 3,
				stroke: COLORS.primary,
			},
			...series.map((s, i) => ({
				dataKey: s.accountId,
				name: s.name,
				stroke: CHART_COLORS[i % CHART_COLORS.length],
			})),
		],
		[series],
	);

	const isEmpty =
		data.length === 0 ||
		data.every((row) => {
			return Object.entries(row).every(([key, value]) => {
				if (key === "ts" || key === "time") return true;
				return value == null;
			});
		});

	const windowLabel = window === "five_hour" ? "5-hour" : "7-day";

	return (
		<Card>
			<CardHeader>
				<CardTitle>Usage Over Time</CardTitle>
				<CardDescription>
					{windowLabel} window utilization per account, with the pool average.
					Lines reset to zero when each account's window rolls over.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{isEmpty ? (
					<div
						className="flex items-center justify-center"
						style={{ height: 300 }}
					>
						<p className="max-w-md text-center text-sm text-muted-foreground">
							{EMPTY_MESSAGE}
						</p>
					</div>
				) : (
					<BaseLineChart
						data={data as unknown as ChartDataPoint[]}
						lines={lines}
						loading={loading}
						height="medium"
						lineType="linear"
						showLegend
						yAxisDomain={[0, 100]}
						yAxisTickFormatter={(v) => `${v}%`}
						tooltipFormatter={(value, name) => [
							`${Number(value).toFixed(0)}%`,
							name,
						]}
						referenceLines={[
							{
								y: 100,
								stroke: COLORS.error,
								strokeDasharray: "4 4",
								label: "Limit",
							},
						]}
					/>
				)}
			</CardContent>
		</Card>
	);
}
