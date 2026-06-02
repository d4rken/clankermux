import type { AccountResponse, UsageHistoryResponse } from "@clankermux/types";
import { format } from "date-fns";
import { useMemo } from "react";
import { CHART_COLORS, COLORS } from "../../constants";
import type { PoolWindow } from "../../lib/pool-usage";
import { pickTimePattern } from "../../lib/usage-chart-format";
import { computeWindowForecast } from "../../lib/usage-forecast";
import { BaseLineChart } from "../charts";
import type { LineConfig } from "../charts/BaseLineChart";
import type { ChartDataPoint } from "../charts/types";
import { TimeRangeSelector } from "../overview/TimeRangeSelector";
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
	/** Selected time range (controlled); also re-keys the parent's usage-history query. */
	range: string;
	onRangeChange: (range: string) => void;
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

	// Label format disambiguates the day once the span exceeds 24h (see helper).
	const timePattern = pickTimePattern(bucketMs, rangeMs);

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

	// Color per account: history series first (so an account's solid and dashed
	// lines share a color), then any forecast-only account (live usage but no
	// history rows yet) continues the palette.
	const colorByAccount = new Map<string, string>(
		series.map((s, i) => [s.accountId, CHART_COLORS[i % CHART_COLORS.length]]),
	);
	const nameById = new Map<string, string>(accounts.map((a) => [a.id, a.name]));

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
	let nextColor = series.length;
	for (const f of forecast) {
		const solidKey = f.accountId ?? POOL_KEY;
		const forecastKey = `${solidKey}__fc`;
		// Anchor at "now": plot bridgePct on both keys so the solid history line
		// joins the dashed forecast. Don't clobber a real historical sample that
		// happens to land in this exact bucket.
		const bridge = rowFor(now);
		if (bridge[solidKey] == null) bridge[solidKey] = f.bridgePct;
		bridge[forecastKey] = f.bridgePct;
		for (const point of f.points) {
			rowFor(point.ts)[forecastKey] = point.pct;
		}
		if (f.accountId && !colorByAccount.has(f.accountId)) {
			colorByAccount.set(
				f.accountId,
				CHART_COLORS[nextColor % CHART_COLORS.length],
			);
			nextColor++;
		}
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
		...series.map((s) => ({
			dataKey: s.accountId,
			name: s.name,
			stroke: colorByAccount.get(s.accountId) ?? COLORS.primary,
		})),
	];
	// Dashed forecast twins (hidden from the legend so it doesn't double up):
	// one per projectable account plus the pool — including live accounts that
	// have no history rows yet.
	for (const f of forecast) {
		if (f.accountId === null) {
			lines.push({
				dataKey: `${POOL_KEY}__fc`,
				name: "Pool (projected)",
				strokeWidth: 3,
				stroke: COLORS.primary,
				strokeDasharray: FORECAST_DASH,
				connectNulls: true,
				legendType: "none",
			});
			continue;
		}
		lines.push({
			dataKey: `${f.accountId}__fc`,
			name: `${nameById.get(f.accountId) ?? f.accountId} (projected)`,
			stroke: colorByAccount.get(f.accountId) ?? COLORS.primary,
			strokeDasharray: FORECAST_DASH,
			connectNulls: true,
			legendType: "none",
		});
	}

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
	range,
	onRangeChange,
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
				<div className="flex items-center justify-between gap-4">
					<div>
						<CardTitle>Usage Over Time</CardTitle>
						<CardDescription>
							Per-account utilization with the pool average. Solid lines are
							recorded history (reset to zero when a window rolls over); dashed
							lines project the current burn rate forward to each window's
							reset.
						</CardDescription>
					</div>
					<TimeRangeSelector value={range} onChange={onRangeChange} />
				</div>
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
