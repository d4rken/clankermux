import type { AnalyticsResponse } from "@clankermux/types";
import { formatNumber } from "@clankermux/ui-common";
import { Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import type { TimeRange } from "../../constants";
import { useSeriesPalette } from "../../hooks/useSeriesPalette";
import {
	formatAxisTime,
	makeTimeTooltipLabelFormatter,
} from "../../lib/time-format";
import {
	buildToolErrorTrend,
	groupToolMessages,
	type ToolMessageGroup,
} from "../../lib/tool-errors";
import { BaseLineChart } from "../charts";
import type { ChartDataPoint } from "../charts/types";
import { Badge } from "../ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableFrame,
	TableHead,
	TableHeader,
	TableRow,
} from "../ui/table";
import { type SortDir, SortHeaderButton } from "./sort-header";

type ToolCallErrors = NonNullable<AnalyticsResponse["toolCallErrors"]>;
type ToolErrorRow = ToolCallErrors["byTool"][number];

// Below this many calls an error rate is more noise than signal — the row is
// still shown but flagged so it isn't read as authoritative (same convention
// as ModelPerformanceTable's speed-sample guard).
const LOW_SAMPLE_THRESHOLD = 5;

type SortKey = keyof ToolErrorRow;

function EmptyState({ loading }: { loading: boolean }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-item">
					<Wrench className="h-5 w-5" />
					Tool Errors
				</CardTitle>
				<CardDescription>
					Client-side tool failures (tool_result is_error) mined from request
					payloads — counted once per execution
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="flex min-h-40 items-center justify-center rounded-md border border-dashed px-6 text-center text-sm text-muted-foreground">
					{loading
						? "Loading tool errors..."
						: "No tool calls recorded in this range yet. Data is collected for new requests only."}
				</div>
			</CardContent>
		</Card>
	);
}

function ToolErrorTable({ rows }: { rows: ToolErrorRow[] }) {
	const [sortKey, setSortKey] = useState<SortKey>("totalErrors");
	const [sortDir, setSortDir] = useState<SortDir>("desc");

	// Error-rate bars are normalized to the column max (with a small visibility
	// floor for nonzero values), matching ModelPerformanceTable's per-column
	// normalization.
	const maxErrorRate = useMemo(
		() => rows.reduce((max, row) => Math.max(max, row.errorRatePct), 0),
		[rows],
	);

	const sortedRows = useMemo(() => {
		const copy = [...rows];
		copy.sort((a, b) => {
			if (sortKey === "toolName") {
				const cmp = a.toolName.localeCompare(b.toolName);
				return sortDir === "asc" ? cmp : -cmp;
			}
			return sortDir === "asc"
				? a[sortKey] - b[sortKey]
				: b[sortKey] - a[sortKey];
		});
		return copy;
	}, [rows, sortKey, sortDir]);

	const handleSort = (key: SortKey) => {
		if (key === sortKey) {
			setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		} else {
			setSortKey(key);
			// Text sorts ascending by default; metrics descending (worst first).
			setSortDir(key === "toolName" ? "asc" : "desc");
		}
	};

	const headerButton = (key: SortKey, label: string) => (
		<SortHeaderButton
			label={label}
			active={key === sortKey}
			dir={sortDir}
			onClick={() => handleSort(key)}
		/>
	);

	return (
		<TableFrame>
			<Table aria-label="Tool error rates">
				<TableHeader>
					<TableRow>
						<TableHead>{headerButton("toolName", "Tool")}</TableHead>
						<TableHead className="text-right">
							{headerButton("totalCalls", "Calls")}
						</TableHead>
						<TableHead className="text-right">
							{headerButton("totalErrors", "Errors")}
						</TableHead>
						<TableHead className="text-right">
							{headerButton("errorRatePct", "Error rate")}
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{sortedRows.map((row) => {
						const lowSample = row.totalCalls < LOW_SAMPLE_THRESHOLD;
						// A genuine 0% gets no bar — the 2% floor only keeps
						// small-but-nonzero rates visible.
						const barPct =
							row.errorRatePct > 0 && maxErrorRate > 0
								? Math.max(2, (row.errorRatePct / maxErrorRate) * 100)
								: 0;
						return (
							<TableRow key={row.toolName} className="hover:bg-muted/40">
								<TableCell className="align-top">
									<div className="font-medium">{row.toolName}</div>
									{lowSample && (
										<div
											className="text-xs text-warning-strong"
											title="Few tool calls — error rate is noisy"
										>
											low sample
										</div>
									)}
								</TableCell>
								<TableCell className="figure text-right align-top">
									{formatNumber(row.totalCalls)}
								</TableCell>
								<TableCell className="figure text-right align-top">
									{formatNumber(row.totalErrors)}
								</TableCell>
								<TableCell className="align-top">
									<div className="figure text-right">
										{row.errorRatePct.toFixed(1)}%
									</div>
									<div className="mt-1 h-1 w-full bg-muted rounded-full overflow-hidden">
										{/* Width is computed per row against the cross-row max, so
										    it cannot be a class. */}
										<div
											className="h-full rounded-full transition-all"
											style={{
												width: `${barPct}%`,
												backgroundColor: "var(--destructive)",
											}}
										/>
									</div>
								</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</TableFrame>
	);
}

function ErrorRateTrendChart({
	timeSeries,
	timeRange,
}: {
	timeSeries: ToolCallErrors["timeSeries"];
	timeRange: TimeRange;
}) {
	const palette = useSeriesPalette();
	const { data, series } = useMemo(() => {
		const { rows, series } = buildToolErrorTrend(timeSeries);
		// Compact axis label baked per point; the raw `ts` rides along so the
		// tooltip can render the rich day-aware label (see time-format.ts).
		const data = rows.map((row) => ({
			...row,
			time: formatAxisTime(row.ts, timeRange),
		}));
		return { data, series };
	}, [timeSeries, timeRange]);

	if (data.length === 0) return null;

	return (
		<div>
			<h4 data-slot="title" className="text-sm font-medium">
				Error rate over time
			</h4>
			<p data-slot="subtitle" className="mb-item text-xs text-muted-foreground">
				Per-bucket error rate for the top{" "}
				{series.length === 1 ? "tool" : `${series.length} tools`} by errors
			</p>
			<BaseLineChart
				data={data as unknown as ChartDataPoint[]}
				lines={series.map(({ key, label }, index) => ({
					dataKey: key,
					name: label,
					stroke: palette.sequence[index % palette.sequence.length],
					connectNulls: true,
				}))}
				xAxisKey="time"
				height="medium"
				showLegend={series.length > 1}
				yAxisTickFormatter={(value) => `${Number(value).toFixed(0)}%`}
				tooltipFormatter={(value, name) => [
					`${Number(value).toFixed(1)}%`,
					String(name),
				]}
				tooltipLabelFormatter={makeTimeTooltipLabelFormatter(timeRange)}
			/>
		</div>
	);
}

function TopMessagesSection({ groups }: { groups: ToolMessageGroup[] }) {
	if (groups.length === 0) return null;

	return (
		<div>
			<h4 data-slot="title" className="text-sm font-medium">
				Top error messages
			</h4>
			<p data-slot="subtitle" className="mb-item text-xs text-muted-foreground">
				Most frequent error texts per tool — the actionable list for tuning
				prompts and tool usage
			</p>
			<div className="space-y-item">
				{groups.map((group) => (
					<details
						key={group.toolName}
						className="rounded-md border"
						open={groups.length === 1}
					>
						<summary className="flex cursor-pointer items-center justify-between gap-item px-3 py-2 text-sm hover:bg-muted/40">
							<span className="font-medium">{group.toolName}</span>
							<Badge variant="outline">
								{formatNumber(group.totalOccurrences)}{" "}
								{group.totalOccurrences === 1 ? "occurrence" : "occurrences"}
							</Badge>
						</summary>
						<ul className="border-t">
							{group.messages.map((message) => (
								<li
									key={message.errorText}
									className="flex items-start justify-between gap-row border-b px-3 py-2 last:border-0"
								>
									<code
										className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
										title={message.errorText}
									>
										{message.errorText}
									</code>
									<Badge variant="secondary" className="shrink-0">
										×{formatNumber(message.occurrences)}
									</Badge>
								</li>
							))}
						</ul>
					</details>
				))}
			</div>
		</div>
	);
}

interface ToolErrorsPanelProps {
	toolCallErrors?: ToolCallErrors;
	loading: boolean;
	timeRange: TimeRange;
}

/**
 * Tool Errors — which client-side tools (Bash, Edit, Read, …) fail most.
 * Per-tool call/error totals with an error-rate bar, the error-rate trend for
 * the top error-prone tools, and the most frequent error messages per tool.
 * Tool calls are extracted at ingest, so historical coverage can be partial —
 * the empty state says so.
 */
export function ToolErrorsPanel({
	toolCallErrors,
	loading,
	timeRange,
}: ToolErrorsPanelProps) {
	const messageGroups = useMemo(
		() => groupToolMessages(toolCallErrors?.topMessages ?? []),
		[toolCallErrors?.topMessages],
	);

	// Tolerates an older server that doesn't send the section at all.
	if (!toolCallErrors || toolCallErrors.byTool.length === 0) {
		return <EmptyState loading={loading} />;
	}

	const totalErrors = toolCallErrors.byTool.reduce(
		(sum, row) => sum + row.totalErrors,
		0,
	);

	return (
		<Card>
			<CardHeader>
				<div className="flex flex-wrap items-start justify-between gap-row">
					<div>
						<CardTitle className="flex items-center gap-item">
							<Wrench className="h-5 w-5" />
							Tool Errors
						</CardTitle>
						<CardDescription>
							Client-side tool failures (tool_result is_error) mined from
							request payloads — counted once per execution
						</CardDescription>
					</div>
					<Badge variant="secondary">
						{formatNumber(totalErrors)} {totalErrors === 1 ? "error" : "errors"}{" "}
						in range
					</Badge>
				</div>
			</CardHeader>
			<CardContent className="space-y-section">
				<ToolErrorTable rows={toolCallErrors.byTool} />
				<ErrorRateTrendChart
					timeSeries={toolCallErrors.timeSeries}
					timeRange={timeRange}
				/>
				<TopMessagesSection groups={messageGroups} />
			</CardContent>
		</Card>
	);
}
