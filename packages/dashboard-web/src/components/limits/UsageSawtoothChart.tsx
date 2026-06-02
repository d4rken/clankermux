import type { AccountResponse, UsageHistoryResponse } from "@clankermux/types";
import { format } from "date-fns";
import { useMemo } from "react";
import { CHART_COLORS, COLORS } from "../../constants";
import type { PoolWindow } from "../../lib/pool-usage";
import { computeWindowForecast } from "../../lib/usage-forecast";
import { BaseLineChart } from "../charts";
import type { ChartDataPoint } from "../charts/types";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";

interface UsageSawtoothChartProps {
	usageHistory: UsageHistoryResponse | undefined;
	/** Live accounts (from /api/accounts) — drive the forward burn-rate forecast. */
	accounts: AccountResponse[];
	/** Current time (ms), ticked by the parent so the forecast anchor stays fresh. */
	now: number;
	loading: boolean;
}

/**
 * One Recharts row keyed by bucket timestamp. `time` is the formatted x-axis
 * label, `pool` is the windowed pool average, each `accountId` key is that
 * account's windowed utilization, and `${key}__fc` keys carry the dashed
 * forward projection (null = gap). `ChartDataPoint` doesn't model null so we
 * cast at the chart boundary.
 */
interface SawtoothRow {
	ts: number;
	time: string;
	pool: number | null;
	[key: string]: number | string | null;
}

interface LineConfig {
	dataKey: string;
	name: string;
	stroke: string;
	strokeWidth?: number;
	strokeDasharray?: string;
	connectNulls?: boolean;
	legendType?: "line" | "none";
}

interface WindowChart {
	data: SawtoothRow[];
	lines: LineConfig[];
	isEmpty: boolean;
}

const EMPTY_MESSAGE =
	"Collecting data — this graph fills in as snapshots accumulate. History starts at deploy; a full 7-day view needs about a week of uptime.";

const FORECAST_DASH = "5 4";
const POOL_KEY = "pool";

/** Lookback span per range string; also caps how far the forecast projects. */
const RANGE_MS: Record<string, number> = {
	"1h": 60 * 60 * 1000,
	"6h": 6 * 60 * 60 * 1000,
	"24h": 24 * 60 * 60 * 1000,
	"7d": 7 * 24 * 60 * 60 * 1000,
	"30d": 30 * 24 * 60 * 60 * 1000,
};

function rangeToMs(range: string | undefined): number {
	return (range && RANGE_MS[range]) || RANGE_MS["24h"];
}

/** Build merged historical + forecast rows and line configs for one window. */
function buildWindowChart(
	usageHistory: UsageHistoryResponse | undefined,
	accounts: AccountResponse[],
	window: PoolWindow,
	now: number,
): WindowChart {
	const pool = usageHistory?.pool ?? [];
	const series = usageHistory?.series ?? [];
	const bucketMs = usageHistory?.bucketMs ?? 0;
	const rangeMs = rangeToMs(usageHistory?.range);

	// Daily buckets (30d range) floor to midnight, so "HH:mm" would render the
	// same "00:00" for every label — switch to a date label there.
	const timePattern = bucketMs >= 86_400_000 ? "MMM d" : "HH:mm";

	const rows = new Map<number, SawtoothRow>();
	const rowFor = (ts: number): SawtoothRow => {
		let row = rows.get(ts);
		if (!row) {
			row = { ts, time: format(new Date(ts), timePattern), pool: null };
			rows.set(ts, row);
		}
		return row;
	};

	// Historical pool average + per-account utilization.
	for (const p of pool) {
		rowFor(p.ts).pool = window === "five_hour" ? p.fiveHourAvg : p.sevenDayAvg;
	}
	for (const s of series) {
		for (const point of s.points) {
			rowFor(point.ts)[s.accountId] =
				window === "five_hour" ? point.fiveHourPct : point.sevenDayPct;
		}
	}

	// Forward projection. Cadence follows the history bucket size (with a sane
	// fallback before any history exists); horizon is capped to the selected
	// range so a 7-day projection can't dwarf a short history window.
	const cadenceMs = bucketMs > 0 ? bucketMs : Math.max(60_000, rangeMs / 48);
	const horizonMs = now + rangeMs;
	const forecast = computeWindowForecast(
		accounts,
		window,
		now,
		cadenceMs,
		horizonMs,
	);
	const accountForecastIds = new Set<string>();
	let hasPoolForecast = false;
	for (const f of forecast) {
		const solidKey = f.accountId ?? POOL_KEY;
		const forecastKey = `${solidKey}__fc`;
		// Anchor at "now": plotting bridgePct on both keys joins the solid
		// history line to the dashed forecast line.
		const bridge = rowFor(now);
		bridge[solidKey] = f.bridgePct;
		bridge[forecastKey] = f.bridgePct;
		for (const point of f.points) {
			rowFor(point.ts)[forecastKey] = point.pct;
		}
		if (f.accountId === null) hasPoolForecast = true;
		else accountForecastIds.add(f.accountId);
	}

	const data = Array.from(rows.values()).sort((a, b) => a.ts - b.ts);

	// Solid: bold pool line first, then one per account from the shared palette.
	const lines: LineConfig[] = [
		{
			dataKey: POOL_KEY,
			name: "Pool (avg)",
			strokeWidth: 3,
			stroke: COLORS.primary,
		},
		...series.map((s, i) => ({
			dataKey: s.accountId,
			name: s.name,
			stroke: CHART_COLORS[i % CHART_COLORS.length],
		})),
	];
	// Dashed forecast twins, matching each solid line's color, hidden from the
	// legend so it doesn't double up.
	if (hasPoolForecast) {
		lines.push({
			dataKey: `${POOL_KEY}__fc`,
			name: "Pool (projected)",
			strokeWidth: 3,
			stroke: COLORS.primary,
			strokeDasharray: FORECAST_DASH,
			connectNulls: true,
			legendType: "none",
		});
	}
	series.forEach((s, i) => {
		if (!accountForecastIds.has(s.accountId)) return;
		lines.push({
			dataKey: `${s.accountId}__fc`,
			name: `${s.name} (projected)`,
			stroke: CHART_COLORS[i % CHART_COLORS.length],
			strokeDasharray: FORECAST_DASH,
			connectNulls: true,
			legendType: "none",
		});
	});

	const isEmpty =
		data.length === 0 ||
		data.every((row) =>
			Object.entries(row).every(([key, value]) => {
				if (key === "ts" || key === "time") return true;
				return value == null;
			}),
		);

	return { data, lines, isEmpty };
}

function WindowChartPanel({
	label,
	chart,
	loading,
}: {
	label: string;
	chart: WindowChart;
	loading: boolean;
}) {
	return (
		<div>
			<p className="mb-2 text-xs font-medium text-muted-foreground">{label}</p>
			{chart.isEmpty ? (
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
					data={chart.data as unknown as ChartDataPoint[]}
					lines={chart.lines}
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
		</div>
	);
}

export function UsageSawtoothChart({
	usageHistory,
	accounts,
	now,
	loading,
}: UsageSawtoothChartProps) {
	const fiveHour = useMemo(
		() => buildWindowChart(usageHistory, accounts, "five_hour", now),
		[usageHistory, accounts, now],
	);
	const sevenDay = useMemo(
		() => buildWindowChart(usageHistory, accounts, "seven_day", now),
		[usageHistory, accounts, now],
	);

	return (
		<Card>
			<CardHeader>
				<CardTitle>Usage Over Time</CardTitle>
				<CardDescription>
					Per-account utilization with the pool average. Solid lines are
					recorded history (reset to zero when a window rolls over); dashed
					lines project the current burn rate forward to each window's reset.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				<WindowChartPanel
					label="5-hour window"
					chart={fiveHour}
					loading={loading}
				/>
				<WindowChartPanel
					label="7-day window"
					chart={sevenDay}
					loading={loading}
				/>
			</CardContent>
		</Card>
	);
}
