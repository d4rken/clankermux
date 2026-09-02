import type { ModelFamily } from "@clankermux/core";
import type {
	AccountResponse,
	UsageHistoryResponse,
	UsageScopedHistoryResponse,
} from "@clankermux/types";
import { format } from "date-fns";
import { AlertCircle } from "lucide-react";
import { useMemo } from "react";
import type { TimeRange } from "../../constants";
import { useSeriesPalette } from "../../hooks/useSeriesPalette";
import type { PoolWindow } from "../../lib/pool-usage";
import { pickTimePattern } from "../../lib/usage-chart-format";
import {
	computeWindowForecast,
	type ForecastWindow,
} from "../../lib/usage-forecast";
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

export interface UsageWindowChartState {
	usageHistory: UsageHistoryResponse | undefined;
	/** This window's usage-history read is in flight with nothing cached yet. */
	loading: boolean;
	/**
	 * Set when that read FAILED with nothing cached. Precedence is
	 * `unavailableReason` -> `loading` -> resolved.
	 */
	unavailableReason?: string;
	/** Selected time range; also re-keys this window's usage-history query. */
	range: TimeRange;
	onRangeChange: (range: TimeRange) => void;
}

/**
 * One per-model-family weekly panel (e.g. "Fable weekly window"). Same
 * availability contract as {@link UsageWindowChartState}, plus the family this
 * panel is about. `usageHistory` is the WHOLE scoped-history response — one
 * response carries every family — and this panel picks its own entry out of it.
 */
export interface FamilyWindowChartState {
	family: ModelFamily;
	/** Anthropic's own label for the family, e.g. "Fable". */
	displayName: string;
	usageHistory: UsageScopedHistoryResponse | undefined;
	loading: boolean;
	unavailableReason?: string;
	range: TimeRange;
	onRangeChange: (range: TimeRange) => void;
}

interface UsageSawtoothChartProps {
	/** Live accounts (from /api/accounts) — drive the forward burn-rate forecast. */
	accounts: AccountResponse[];
	/** Current time (ms), ticked by the parent so the forecast anchor stays fresh. */
	now: number;
	fiveHour: UsageWindowChartState;
	sevenDay: UsageWindowChartState;
	/**
	 * One extra panel per model family the provider scopes a weekly window for.
	 * Data-driven, not a hard-coded "Fable" panel: whichever families the pool
	 * reports (or has recorded history for) get a graph.
	 */
	families?: FamilyWindowChartState[];
}

/**
 * One window's history, normalised out of whichever endpoint produced it, so
 * the row builder below does not have to know that the account-wide response
 * keys its values by window while the scoped one keys them by family.
 */
interface WindowHistory {
	range: string | undefined;
	bucketMs: number;
	series: Array<{
		accountId: string;
		name: string;
		points: Array<{ ts: number; pct: number | null }>;
	}>;
	pool: Array<{ ts: number; avg: number | null }>;
}

function windowHistoryFromUsage(
	usageHistory: UsageHistoryResponse | undefined,
	window: PoolWindow,
): WindowHistory | undefined {
	if (!usageHistory) return undefined;
	const five = window === "five_hour";
	return {
		range: usageHistory.range,
		bucketMs: usageHistory.bucketMs,
		series: usageHistory.series.map((s) => ({
			accountId: s.accountId,
			name: s.name,
			points: s.points.map((p) => ({
				ts: p.ts,
				pct: five ? p.fiveHourPct : p.sevenDayPct,
			})),
		})),
		pool: usageHistory.pool.map((p) => ({
			ts: p.ts,
			avg: five ? p.fiveHourAvg : p.sevenDayAvg,
		})),
	};
}

function windowHistoryFromScopedFamily(
	response: UsageScopedHistoryResponse | undefined,
	family: ModelFamily,
): WindowHistory | undefined {
	if (!response) return undefined;
	const entry = response.families.find((f) => f.family === family);
	// The read resolved but has nothing recorded for this family yet (a window
	// the pool started reporting since the last snapshot). Still return the
	// response's range and bucket size: the forecast that IS drawable has to use
	// the selected range's horizon and cadence, not the 24h fallback.
	if (!entry) {
		return {
			range: response.range,
			bucketMs: response.bucketMs,
			series: [],
			pool: [],
		};
	}
	return {
		range: response.range,
		bucketMs: response.bucketMs,
		series: entry.series.map((s) => ({
			accountId: s.accountId,
			name: s.name,
			points: s.points.map((p) => ({ ts: p.ts, pct: p.pct })),
		})),
		pool: entry.pool.map((p) => ({ ts: p.ts, avg: p.avg })),
	};
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

/**
 * Lookback span per range string; also caps how far the forecast projects.
 * "all" maps to the 30d span: the true history span is unbounded, but this
 * value only drives the label-pattern day check (any multi-day value works)
 * and the forecast horizon, which should not stretch with the history (window
 * resets are at most 7 days out anyway).
 */
const RANGE_MS: Record<string, number> = {
	"1h": 60 * 60 * 1000,
	"6h": 6 * 60 * 60 * 1000,
	"24h": 24 * 60 * 60 * 1000,
	"7d": 7 * 24 * 60 * 60 * 1000,
	"30d": 30 * 24 * 60 * 60 * 1000,
	all: 30 * 24 * 60 * 60 * 1000,
};

function rangeToMs(range: string | undefined): number {
	return (range && RANGE_MS[range]) || RANGE_MS["24h"];
}

/** Build merged historical + forecast rows and line configs for one window. */
function buildWindowChart(
	history: WindowHistory | undefined,
	accounts: AccountResponse[],
	window: ForecastWindow,
	now: number,
	// Passed in rather than read from a module constant: the qualitative hues
	// differ between the light and dark chart grounds, and this builder has to
	// stay a pure function so the useMemo below keeps working.
	sequence: readonly string[],
	poolStroke: string,
): WindowChart {
	const pool = history?.pool ?? [];
	const series = history?.series ?? [];
	const bucketMs = history?.bucketMs ?? 0;
	const rangeMs = rangeToMs(history?.range);

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
		rowFor(p.ts).pool = p.avg;
	}
	for (const s of series) {
		for (const point of s.points) {
			rowFor(point.ts)[s.accountId] = point.pct;
		}
	}

	// Color per account: history series first (so an account's solid and dashed
	// lines share a color), then any forecast-only account (live usage but no
	// history rows yet) continues the palette.
	const colorByAccount = new Map<string, string>(
		series.map((s, i) => [s.accountId, sequence[i % sequence.length]]),
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
			colorByAccount.set(f.accountId, sequence[nextColor % sequence.length]);
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
			stroke: poolStroke,
		},
		...series.map((s) => ({
			dataKey: s.accountId,
			name: s.name,
			stroke: colorByAccount.get(s.accountId) ?? poolStroke,
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
				stroke: poolStroke,
				strokeDasharray: FORECAST_DASH,
				connectNulls: true,
				legendType: "none",
			});
			continue;
		}
		lines.push({
			dataKey: `${f.accountId}__fc`,
			name: `${nameById.get(f.accountId) ?? f.accountId} (projected)`,
			stroke: colorByAccount.get(f.accountId) ?? poolStroke,
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

/**
 * One window's panel. `EMPTY_MESSAGE` is a RESOLVED claim — that no history
 * exists — so it may only be reached once this window's read has come back. A
 * pending or failed read yields no rows either, and would otherwise tell a
 * deployment with months of snapshots the exact opposite of the truth.
 * Precedence: unavailable -> loading -> empty -> chart.
 */
function WindowChartPanel({
	label,
	history,
	accounts,
	window,
	now,
	sequence,
	poolStroke,
	loading,
	unavailableReason,
	range,
	onRangeChange,
	selectorLabel,
}: {
	label: string;
	history: WindowHistory | undefined;
	accounts: AccountResponse[];
	window: ForecastWindow;
	now: number;
	sequence: readonly string[];
	poolStroke: string;
	loading: boolean;
	unavailableReason?: string;
	range: TimeRange;
	onRangeChange: (range: TimeRange) => void;
	selectorLabel: string;
}) {
	// Built per panel rather than in the parent: the family panels are rendered
	// from a list, and a hook cannot be called in a loop outside a component.
	const chart = useMemo(
		() =>
			buildWindowChart(history, accounts, window, now, sequence, poolStroke),
		[history, accounts, window, now, sequence, poolStroke],
	);
	const pending = loading && unavailableReason == null;
	return (
		<div>
			<div className="mb-item flex items-center justify-between gap-group">
				<p className="text-xs font-medium text-muted-foreground">{label}</p>
				<TimeRangeSelector
					value={range}
					onChange={onRangeChange}
					ariaLabel={selectorLabel}
				/>
			</div>
			{unavailableReason != null ? (
				// Same 300px box as the chart and the empty state, so the panel keeps
				// its height whichever branch wins.
				<div
					className="flex items-center justify-center"
					style={{ height: 300 }}
				>
					<p className="flex items-center gap-item text-sm text-warning-strong">
						<AlertCircle className="h-3.5 w-3.5 shrink-0" />
						{unavailableReason}
					</p>
				</div>
			) : !pending && chart.isEmpty ? (
				<div
					className="flex items-center justify-center"
					style={{ height: 300 }}
				>
					<p className="max-w-md text-center text-sm text-muted-foreground">
						{EMPTY_MESSAGE}
					</p>
				</div>
			) : (
				// While pending this renders the chart container's spinner at the same
				// "medium" 300px height, never the (nonexistent) rows.
				<BaseLineChart
					data={chart.data as unknown as ChartDataPoint[]}
					lines={chart.lines}
					loading={pending}
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
							stroke: "var(--destructive)",
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
	accounts,
	now,
	fiveHour: fiveHourState,
	sevenDay: sevenDayState,
	families = [],
}: UsageSawtoothChartProps) {
	const palette = useSeriesPalette();
	// The pool average is the emphasis line, so it takes the palette's own
	// primary rather than a qualitative hue.
	const poolStroke = "var(--primary)";

	return (
		<Card>
			<CardHeader>
				<CardTitle>Usage Over Time</CardTitle>
				<CardDescription>
					Per-account utilization with the pool average. Solid lines are
					recorded history; a paused or maxed-out account holds its last value
					until its window rolls over, so it never silently drops out of the
					pool average. Dashed lines project the current burn rate forward
					through each window's reset (dropping to 0%) and a little beyond.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-section">
				<WindowChartPanel
					label="5-hour window"
					history={windowHistoryFromUsage(
						fiveHourState.usageHistory,
						"five_hour",
					)}
					accounts={accounts}
					window="five_hour"
					now={now}
					sequence={palette.sequence}
					poolStroke={poolStroke}
					loading={fiveHourState.loading}
					unavailableReason={fiveHourState.unavailableReason}
					range={fiveHourState.range}
					onRangeChange={fiveHourState.onRangeChange}
					selectorLabel="5-hour graph time range"
				/>
				<WindowChartPanel
					label="7-day window"
					history={windowHistoryFromUsage(
						sevenDayState.usageHistory,
						"seven_day",
					)}
					accounts={accounts}
					window="seven_day"
					now={now}
					sequence={palette.sequence}
					poolStroke={poolStroke}
					loading={sevenDayState.loading}
					unavailableReason={sevenDayState.unavailableReason}
					range={sevenDayState.range}
					onRangeChange={sevenDayState.onRangeChange}
					selectorLabel="7-day graph time range"
				/>
				{families.map((family) => (
					<WindowChartPanel
						key={family.family}
						label={`${family.displayName} weekly window`}
						history={windowHistoryFromScopedFamily(
							family.usageHistory,
							family.family,
						)}
						accounts={accounts}
						window={{ kind: "family", family: family.family }}
						now={now}
						sequence={palette.sequence}
						poolStroke={poolStroke}
						loading={family.loading}
						unavailableReason={family.unavailableReason}
						range={family.range}
						onRangeChange={family.onRangeChange}
						selectorLabel={`${family.displayName} weekly graph time range`}
					/>
				))}
			</CardContent>
		</Card>
	);
}
