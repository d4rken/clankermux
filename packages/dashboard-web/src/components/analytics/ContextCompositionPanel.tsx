import type { AnalyticsResponse } from "@clankermux/types";
import {
	formatNumber,
	formatPercentage,
	formatTokens,
} from "@clankermux/ui-common";
import { format } from "date-fns";
import { Gauge } from "lucide-react";
import { useMemo } from "react";
import {
	Bar,
	BarChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import type { TimeRange } from "../../constants";
import { CHART_COLORS, COLORS } from "../../constants";
import {
	formatCompactNumber,
	type TooltipFormatter,
} from "../../lib/chart-utils";
import {
	formatAxisTime,
	makeTimeTooltipLabelFormatter,
} from "../../lib/time-format";
import { BaseLineChart } from "../charts";
import { getTooltipStyles } from "../charts/chart-utils";
import type { ChartDataPoint } from "../charts/types";
import { Badge } from "../ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";

type ContextComposition = NonNullable<AnalyticsResponse["contextComposition"]>;

// Display label only — the API keeps the NULL bucket as `project: null`.
const NO_PROJECT_LABEL = "(no project)";

// Rough chars-per-token divisor for the explicitly-labeled estimates. Real
// per-bucket token counts are unknowable without a tokenizer.
const CHARS_PER_TOKEN_ESTIMATE = 4;

const SEGMENT_COLORS: Record<string, string> = {
	system: COLORS.blue,
	tools: COLORS.purple,
	messages: COLORS.success,
};

const SEGMENT_LABELS: Record<string, string> = {
	system: "System prompt",
	tools: "Tool definitions",
	messages: "Messages",
};

function projectLabel(project: string | null): string {
	return project ?? NO_PROJECT_LABEL;
}

// Stable identity for series keys. Prefixed domains so no real project name
// (arbitrary via the x-project header) can collide with the NULL bucket.
function projectKey(project: string | null): string {
	return project === null ? "null:bucket" : `project:${project}`;
}

function EmptyState({
	loading,
	noCoverage,
}: {
	loading: boolean;
	noCoverage: boolean;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Gauge className="h-5 w-5" />
					Context Composition
				</CardTitle>
				<CardDescription>
					What fills the context window: system prompt, tool definitions, and
					messages
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="flex min-h-40 items-center justify-center rounded-md border border-dashed px-6 text-center text-sm text-muted-foreground">
					{loading
						? "Loading context composition..."
						: noCoverage
							? "Context composition is recorded for new requests; run scripts/backfill-context-composition.ts to analyze history."
							: "No context composition data in this range"}
				</div>
			</CardContent>
		</Card>
	);
}

function CompositionSplit({
	totals,
}: {
	totals: ContextComposition["totals"];
}) {
	const totalChars =
		totals.systemChars + totals.toolsChars + totals.messagesChars;
	if (totalChars === 0) return null;

	const segments = (["system", "tools", "messages"] as const).map((key) => {
		const chars =
			key === "system"
				? totals.systemChars
				: key === "tools"
					? totals.toolsChars
					: totals.messagesChars;
		const share = chars / totalChars;
		return {
			key,
			label: SEGMENT_LABELS[key],
			chars,
			share,
			// Proportion applied to the REAL covered-row average context tokens —
			// an estimate, since char counts don't map 1:1 to tokens.
			estimatedTokens: share * totals.avgContextTokens,
		};
	});

	const toolResultShareOfMessages =
		totals.messagesChars > 0
			? (totals.toolResultChars / totals.messagesChars) * 100
			: 0;
	const toolResultShareOfTotal = (totals.toolResultChars / totalChars) * 100;

	const chartRow: Record<string, string | number> = { name: "context" };
	for (const segment of segments) {
		chartRow[segment.key] = segment.chars;
	}

	// Cast per chart-utils convention: recharts v3.8 widened the formatter's
	// value/name parameter types beyond what this inline callback needs.
	const tooltipFormatter = ((value: number, name: string) => {
		const segment = segments.find((s) => s.label === name);
		if (!segment) return [formatNumber(Number(value)), name];
		return [
			`${formatNumber(segment.chars)} chars · ${formatPercentage(segment.share * 100, 0)} · ~${formatTokens(Math.round(segment.estimatedTokens))} tokens/request (estimated)`,
			name,
		];
	}) as TooltipFormatter;

	return (
		<div className="space-y-3">
			<ResponsiveContainer width="100%" height={56}>
				<BarChart
					data={[chartRow]}
					layout="vertical"
					margin={{ top: 4, right: 4, bottom: 4, left: 4 }}
				>
					<XAxis type="number" hide domain={[0, totalChars]} />
					<YAxis type="category" dataKey="name" hide />
					<Tooltip
						contentStyle={getTooltipStyles("default")}
						formatter={tooltipFormatter}
					/>
					{segments.map((segment) => (
						<Bar
							key={segment.key}
							dataKey={segment.key}
							stackId="composition"
							fill={SEGMENT_COLORS[segment.key]}
							name={segment.label}
						/>
					))}
				</BarChart>
			</ResponsiveContainer>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
				{segments.map((segment) => (
					<div key={segment.key} className="flex items-center gap-2">
						<span
							className="h-2.5 w-2.5 rounded-sm"
							style={{ backgroundColor: SEGMENT_COLORS[segment.key] }}
						/>
						<span>{segment.label}</span>
						<Badge variant="outline">
							{formatPercentage(segment.share * 100, 0)}
						</Badge>
					</div>
				))}
			</div>
			{totals.toolResultChars > 0 && (
				<p className="text-xs text-muted-foreground">
					Tool results make up {formatPercentage(toolResultShareOfMessages, 0)}{" "}
					of messages ({formatPercentage(toolResultShareOfTotal, 0)} of total
					context).
				</p>
			)}
		</div>
	);
}

function GrowthChart({
	growthCurve,
	timeRange,
}: {
	growthCurve: ContextComposition["growthCurve"];
	timeRange: TimeRange;
}) {
	const { data, series } = useMemo(() => {
		// Stable series order: projects by total requests desc, so colors don't
		// shuffle between refreshes. Series are keyed by projectKey (NULL bucket
		// gets a sentinel key distinct from any real name) and labeled separately.
		const requestsByKey = new Map<string, number>();
		const labelByKey = new Map<string, string>();
		for (const point of growthCurve) {
			const key = projectKey(point.project);
			requestsByKey.set(key, (requestsByKey.get(key) ?? 0) + point.requests);
			labelByKey.set(key, projectLabel(point.project));
		}
		const series = Array.from(requestsByKey.entries())
			.sort((a, b) => b[1] - a[1])
			.map(([key]) => ({
				key,
				label: labelByKey.get(key) ?? key,
			}));

		const byTs = new Map<number, Record<string, string | number>>();
		for (const point of growthCurve) {
			let row = byTs.get(point.ts);
			if (!row) {
				row = { time: formatAxisTime(point.ts, timeRange), ts: point.ts };
				byTs.set(point.ts, row);
			}
			row[projectKey(point.project)] = Math.round(point.avgContextTokens);
		}
		const data = Array.from(byTs.entries())
			.sort(([a], [b]) => a - b)
			.map(([, row]) => row);
		return { data, series };
	}, [growthCurve, timeRange]);

	if (data.length === 0) return null;

	return (
		<div>
			<h4 className="mb-2 text-sm font-medium">Context growth over time</h4>
			<p className="mb-2 text-xs text-muted-foreground">
				Average context tokens per request, per project (top{" "}
				{series.length === 1 ? "project" : `${series.length} projects`} by
				requests)
			</p>
			<BaseLineChart
				data={data as unknown as ChartDataPoint[]}
				lines={series.map(({ key, label }, index) => ({
					dataKey: key,
					name: label,
					stroke: CHART_COLORS[index % CHART_COLORS.length],
					connectNulls: true,
				}))}
				xAxisKey="time"
				height="medium"
				showLegend={series.length > 1}
				yAxisTickFormatter={(value) => formatCompactNumber(Number(value))}
				tooltipFormatter={(value, name) => [
					`${formatTokens(Number(value))} tokens`,
					String(name),
				]}
				tooltipLabelFormatter={makeTimeTooltipLabelFormatter(timeRange)}
			/>
		</div>
	);
}

function TopContributorsTable({
	contributors,
}: {
	contributors: ContextComposition["topToolContributors"];
}) {
	if (contributors.length === 0) return null;

	return (
		<div>
			<h4 className="mb-2 text-sm font-medium">Top context contributors</h4>
			<p className="mb-2 text-xs text-muted-foreground">
				Largest single tool results re-sent in a request — the actionable list
				for trimming context
			</p>
			<div className="overflow-hidden rounded-md border">
				<table aria-label="Top context contributors" className="w-full text-sm">
					<thead className="bg-muted/50">
						<tr>
							<th scope="col" className="px-3 py-2 text-left">
								Tool
							</th>
							<th scope="col" className="px-3 py-2 text-right">
								Size
							</th>
							<th scope="col" className="px-3 py-2 text-left">
								Project
							</th>
							<th scope="col" className="px-3 py-2 text-left">
								Model
							</th>
							<th scope="col" className="px-3 py-2 text-left">
								When
							</th>
						</tr>
					</thead>
					<tbody>
						{contributors.map((row) => (
							<tr key={row.requestId} className="border-t">
								<td className="px-3 py-2 font-medium">{row.toolName ?? "—"}</td>
								<td className="px-3 py-2 text-right">
									{formatNumber(row.chars)} chars
									<span className="ml-1 text-xs text-muted-foreground">
										~
										{formatTokens(
											Math.round(row.chars / CHARS_PER_TOKEN_ESTIMATE),
										)}{" "}
										tok (est.)
									</span>
								</td>
								<td
									className={`px-3 py-2 text-muted-foreground ${
										row.project == null ? "italic" : ""
									}`}
								>
									{projectLabel(row.project)}
								</td>
								<td className="px-3 py-2 text-muted-foreground">
									{row.model ?? "—"}
								</td>
								<td className="px-3 py-2 text-muted-foreground">
									{format(new Date(row.ts), "MMM d, HH:mm")}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

interface ContextCompositionPanelProps {
	contextComposition?: ContextComposition;
	loading: boolean;
	timeRange: TimeRange;
}

/**
 * Context Composition — what fills the context window. Char-proportion split
 * (system / tool definitions / messages, with tool results called out inside
 * messages), per-project context growth over time (real tokens), and the
 * largest single tool-result contributors. Composition is recorded at ingest,
 * so coverage over historical rows can be partial — the banner says so.
 */
export function ContextCompositionPanel({
	contextComposition,
	loading,
	timeRange,
}: ContextCompositionPanelProps) {
	// Tolerates an older server that doesn't send the section at all.
	if (!contextComposition) {
		return <EmptyState loading={loading} noCoverage={false} />;
	}

	const { coverage, totals, growthCurve, topToolContributors } =
		contextComposition;

	if (coverage.withComposition === 0) {
		return <EmptyState loading={loading} noCoverage={!loading} />;
	}

	return (
		<Card>
			<CardHeader>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div>
						<CardTitle className="flex items-center gap-2">
							<Gauge className="h-5 w-5" />
							Context Composition
						</CardTitle>
						<CardDescription>
							What fills the context window: system prompt, tool definitions,
							and messages
						</CardDescription>
					</div>
					<Badge variant="secondary">
						~{formatTokens(Math.round(totals.avgContextTokens))} avg context
						tokens
					</Badge>
				</div>
			</CardHeader>
			<CardContent className="space-y-6">
				{coverage.withComposition < coverage.totalRequests && (
					<p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
						Composition recorded for {formatNumber(coverage.withComposition)} of{" "}
						{formatNumber(coverage.totalRequests)} requests in range (captured
						at request time)
					</p>
				)}
				<CompositionSplit totals={totals} />
				<GrowthChart growthCurve={growthCurve} timeRange={timeRange} />
				<TopContributorsTable contributors={topToolContributors} />
			</CardContent>
		</Card>
	);
}
