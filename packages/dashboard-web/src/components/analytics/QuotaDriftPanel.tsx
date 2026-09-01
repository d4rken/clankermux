import type {
	QuotaDriftCohort,
	QuotaDriftWindowResult,
} from "@clankermux/types";
import { Activity, ChevronDown } from "lucide-react";
import { useMemo } from "react";
import {
	Area,
	CartesianGrid,
	ComposedChart,
	Legend,
	Line,
	ReferenceLine,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { CHART_HEIGHTS, CHART_PROPS } from "../../constants";
import { useSeriesPalette } from "../../hooks/useSeriesPalette";
import {
	flatWindowNotice,
	lastObservedValueNotice,
	notReportedNotice,
	quotaWindowLabel,
	summarizeModelGaps,
} from "../../lib/quota-drift-display";
import { formatAxisTime } from "../../lib/time-format";
import { ChartContainer } from "../charts/ChartContainer";
import { getTooltipStyles } from "../charts/chart-utils";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";

/**
 * Implied full-window capacity over time, per model, with its interval.
 *
 * Two rendering rules carry the honesty of this chart:
 *
 *  - a rolling window where the model was NOT identified contributes a null,
 *    and the line is drawn with `connectNulls={false}` so it BREAKS there. A
 *    joined line across an unmeasured stretch is a claim the data does not
 *    support;
 *  - the shaded band is the 90% interval mapped through the same `100 / w`
 *    inversion as the line, so a wide interval is visibly wide rather than
 *    being reduced to a confident-looking stroke.
 *
 * Detected changes are drawn as reference lines. They mark where the fit says
 * the level moved; what caused the move is not something this chart can say
 * (see the caveats in QuotaChangeVerdicts).
 */
export function QuotaDriftPanel({
	cohort,
	loading = false,
}: {
	cohort?: QuotaDriftCohort;
	loading?: boolean;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-item">
					<Activity className="h-5 w-5" />
					Implied Capacity Over Time
				</CardTitle>
				<CardDescription className="text-xs">
					Millions of equivalent tokens the full window would buy at each
					rolling fit's rate. Shaded bands are 90% intervals; the line breaks
					wherever the model could not be separated from the traffic beside it.
					Dashed markers are detected changes in implied cost, not confirmed
					provider actions.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-section">
				{!loading && (!cohort || cohort.windows.length === 0) ? (
					<p className="text-sm text-muted-foreground">
						No fitted windows for this group yet.
					</p>
				) : (
					(cohort?.windows ?? []).map((window) => (
						<WindowSeries
							key={window.window}
							window={window}
							provider={cohort?.provider ?? ""}
							loading={loading}
						/>
					))
				)}
				{loading && !cohort ? <WindowSeries loading /> : null}
			</CardContent>
		</Card>
	);
}

function WindowSeries({
	window,
	provider = "",
	loading = false,
}: {
	window?: QuotaDriftWindowResult;
	provider?: string;
	loading?: boolean;
}) {
	const palette = useSeriesPalette();

	const { rows, models, changes } = useMemo(() => {
		if (!window) return { rows: [], models: [], changes: [] };
		// A model earns a line only if it was identified SOMEWHERE in the series.
		// One that never was would contribute an all-null column: an entry in the
		// legend for a line that is never drawn.
		const drawn = window.models.filter((m) =>
			m.points.some((p) => p.identified && p.impliedCapacityMtok != null),
		);
		const byTs = new Map<number, Record<string, unknown>>();
		for (const model of drawn) {
			for (const point of model.points) {
				const row = byTs.get(point.windowEndMs) ?? { ts: point.windowEndMs };
				const capacity = point.identified ? point.impliedCapacityMtok : null;
				row[model.key] = capacity;
				// The band is the interval inverted the same way the line is: a HIGH
				// coefficient is a LOW capacity, so the bounds swap.
				row[`${model.key}__band`] =
					point.identified && point.ciLow != null && point.ciHigh != null
						? [100 / point.ciHigh, 100 / point.ciLow]
						: null;
				byTs.set(point.windowEndMs, row);
			}
		}
		return {
			rows: [...byTs.values()].sort(
				(a, b) => (a.ts as number) - (b.ts as number),
			),
			models: drawn.map((m) => m.key),
			changes: drawn.flatMap((m) =>
				m.changes.map((c) => ({ key: m.key, boundaryMs: c.boundaryMs })),
			),
		};
	}, [window]);

	const colorFor = (key: string) => palette.forModel(key);

	// Why the chart is empty where it is empty. Covers every model in the
	// window, including the ones with no line at all — a model that was never
	// separable has no series to inspect, so this list is the only place a
	// reader learns it exists and why it is missing.
	const gaps = useMemo(
		() => (window ? summarizeModelGaps(window.models) : []),
		[window],
	);
	// A window the provider has never moved. Stated below the chart rather than
	// drawn into it: the historical series stays exactly as it was, and the
	// reason it stops being informative is written out in words.
	const flatNotice = window ? flatWindowNotice(provider, window) : null;
	// A window our readings stopped carrying a value for. Stated FIRST: it is
	// why the series ends where it does, and on a cohort that is split between
	// accounts that still report it and accounts that do not, both notices
	// appear and each is scoped to the accounts it was established on.
	const absentNotice = window ? notReportedNotice(provider, window) : null;
	// What that window showed the last time a reading carried it. Quoted only
	// beside the absence, and only when one recorded reading answers it: a
	// reader's first question about a vanished quota window is how full it was.
	const lastValueNotice = window ? lastObservedValueNotice(window) : null;

	return (
		<div className="space-y-item">
			<h3 className="text-sm font-medium">
				{window ? quotaWindowLabel(window.window) : "Loading"}
			</h3>
			<ChartContainer
				loading={loading}
				height="medium"
				isEmpty={rows.length === 0 || models.length === 0}
				emptyState={
					<p className="text-sm text-muted-foreground max-w-prose text-center">
						No model in this window has been separately measurable for long
						enough to plot. This is an absence of evidence, not a flat line.
					</p>
				}
			>
				<ResponsiveContainer width="100%" height={CHART_HEIGHTS.medium}>
					<ComposedChart data={rows}>
						<CartesianGrid
							strokeDasharray={CHART_PROPS.strokeDasharray}
							className={CHART_PROPS.gridClassName}
						/>
						<XAxis
							dataKey="ts"
							type="number"
							domain={["dataMin", "dataMax"]}
							scale="time"
							tick={{ fontSize: 11 }}
							tickFormatter={(v: number) => formatAxisTime(v, "all")}
						/>
						<YAxis
							tick={{ fontSize: 11 }}
							tickFormatter={(v: number) => `${v.toFixed(0)}M`}
						/>
						<Tooltip
							contentStyle={getTooltipStyles()}
							labelFormatter={(v) => new Date(Number(v)).toLocaleString()}
							formatter={(value: unknown, name: unknown) => {
								const label = String(name ?? "");
								if (Array.isArray(value)) {
									const [lo, hi] = value as [number, number];
									return [
										`${lo.toFixed(1)}M – ${hi.toFixed(1)}M`,
										`${label.replace("__band", "")} (90% interval)`,
									];
								}
								return [
									typeof value === "number" ? `${value.toFixed(1)}M` : "—",
									label,
								];
							}}
						/>
						<Legend />
						{models.map((key, _index) => (
							<Area
								key={`${key}__band`}
								dataKey={`${key}__band`}
								name={`${key}__band`}
								stroke="none"
								fill={colorFor(key)}
								fillOpacity={0.15}
								isAnimationActive={false}
								connectNulls={false}
								legendType="none"
							/>
						))}
						{models.map((key, _index) => (
							<Line
								key={key}
								type="linear"
								dataKey={key}
								name={key}
								stroke={colorFor(key)}
								strokeWidth={2}
								dot={false}
								isAnimationActive={false}
								// A gap is the point: never bridge a stretch where the model
								// was not separately identified.
								connectNulls={false}
							/>
						))}
						{changes.map((change) => (
							<ReferenceLine
								key={`${change.key}-${change.boundaryMs}`}
								x={change.boundaryMs}
								stroke="var(--destructive)"
								strokeDasharray="4 4"
								label={{
									value: change.key,
									position: "top",
									fontSize: 10,
								}}
							/>
						))}
					</ComposedChart>
				</ResponsiveContainer>
			</ChartContainer>
			{absentNotice ? (
				<p className="text-xs text-muted-foreground max-w-prose">
					{absentNotice}
				</p>
			) : null}
			{lastValueNotice ? (
				<p className="text-xs text-muted-foreground max-w-prose">
					{lastValueNotice}
				</p>
			) : null}
			{flatNotice ? (
				<p className="text-xs text-muted-foreground max-w-prose">
					{flatNotice}
				</p>
			) : null}
			{gaps.length > 0 ? (
				<details className="group max-w-prose">
					<summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
						What this analysis could not measure, and why
						<ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
					</summary>
					<ul className="mt-1 text-xs text-muted-foreground space-y-0.5">
						{gaps.map((model) => (
							<li key={model.key}>
								<span className="font-medium">{model.key}</span>
								{/* A single stretch reads better inline; several become a
								    nested list so each stretch keeps its own period rather
								    than being run together into one sentence. */}
								{model.lines.length === 1 ? (
									` — ${model.lines[0].text}`
								) : (
									<ul className="pl-4 space-y-0.5">
										{model.lines.map((line) => (
											<li key={line.id}>{line.text}</li>
										))}
									</ul>
								)}
							</li>
						))}
					</ul>
				</details>
			) : null}
		</div>
	);
}
