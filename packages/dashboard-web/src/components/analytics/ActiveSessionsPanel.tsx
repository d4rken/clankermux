import type { AnalyticsResponse } from "@clankermux/types";
import { formatNumber } from "@clankermux/ui-common";
import { Users } from "lucide-react";
import { useMemo } from "react";
import type { TimeRange } from "../../constants";
import {
	buildActiveSessionsTrend,
	SESSION_SCOPE_COLORS,
	SESSION_TOTAL_COLOR,
	SESSION_TOTAL_KEY,
	sortActiveSessionsByAccount,
} from "../../lib/active-sessions";
import {
	formatAxisTime,
	makeTimeTooltipLabelFormatter,
} from "../../lib/time-format";
import { BaseBarChart, BaseLineChart } from "../charts";
import type { ChartDataPoint } from "../charts/types";
import { Badge } from "../ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";

function EmptyState({ loading }: { loading: boolean }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Users className="h-5 w-5" />
					Active Sessions
				</CardTitle>
				<CardDescription>
					Distinct sessions active per time bucket, split by client.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="flex min-h-40 items-center justify-center rounded-md border border-dashed px-6 text-center text-sm text-muted-foreground">
					{loading
						? "Loading active sessions..."
						: "No session activity recorded in this range yet. Sessions are attributed for new requests only."}
				</div>
			</CardContent>
		</Card>
	);
}

interface ActiveSessionsPanelProps {
	activeSessions: AnalyticsResponse["activeSessions"];
	loading: boolean;
	timeRange: TimeRange;
}

/**
 * Active Sessions — distinct sessions active per time bucket, split by client
 * (Claude / Codex / other project scope). Deliberately a LINE chart: a line
 * reads as a per-bucket snapshot, whereas a stacked area would imply
 * accumulation. The range-total badge shows COUNT DISTINCT across the whole
 * range — NOT the sum of the chart, which double-counts sessions active in
 * multiple buckets (see ActiveSessionsTimePoint semantics in types/stats.ts).
 */
export function ActiveSessionsPanel({
	activeSessions,
	loading,
	timeRange,
}: ActiveSessionsPanelProps) {
	const { data, series } = useMemo(() => {
		if (!activeSessions) return { data: [] as ChartDataPoint[], series: [] };
		const { rows, series } = buildActiveSessionsTrend(
			activeSessions.timeSeries,
		);
		// Compact axis label baked per point; the raw `ts` rides along so the
		// tooltip can render the rich day-aware label (see time-format.ts).
		const data = rows.map((row) => ({
			...row,
			time: formatAxisTime(row.ts, timeRange),
		}));
		return { data, series };
	}, [activeSessions, timeRange]);

	const accountRows = useMemo(() => {
		if (!activeSessions?.perAccount?.length) return [];
		return sortActiveSessionsByAccount(activeSessions.perAccount);
	}, [activeSessions]);

	// Tolerates an older server that doesn't send the section at all.
	if (!activeSessions || activeSessions.timeSeries.length === 0) {
		return <EmptyState loading={loading} />;
	}

	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<div className="flex flex-wrap items-start justify-between gap-3">
						<div>
							<CardTitle className="flex items-center gap-2">
								<Users className="h-5 w-5" />
								Active Sessions
							</CardTitle>
							<CardDescription>
								Distinct sessions active per time bucket, split by client. A
								session spanning multiple buckets is counted in each — this is
								not a running total or a count of new sessions. The dashed{" "}
								<span className="font-medium">Total</span> line is the
								per-bucket sum across clients. Honors the filters above.
							</CardDescription>
						</div>
						<Badge
							variant="secondary"
							title="Distinct sessions (COUNT DISTINCT) across the whole selected range — not the sum of the chart, which double-counts sessions active in multiple buckets."
						>
							{formatNumber(activeSessions.totalDistinctSessions)} distinct in
							range
						</Badge>
					</div>
				</CardHeader>
				<CardContent>
					<BaseLineChart
						data={data as unknown as ChartDataPoint[]}
						lines={[
							...series.map(({ key, label }) => ({
								dataKey: key,
								name: label,
								stroke: SESSION_SCOPE_COLORS[key],
								connectNulls: true,
							})),
							// Aggregate Total line — only meaningful when >1 client scope is
							// present (with a single scope it would just overlay that line).
							...(series.length > 1
								? [
										{
											dataKey: SESSION_TOTAL_KEY,
											name: "Total",
											stroke: SESSION_TOTAL_COLOR,
											strokeDasharray: "5 4",
											strokeWidth: 2,
											connectNulls: true,
										},
									]
								: []),
						]}
						xAxisKey="time"
						height="medium"
						showLegend={series.length > 1}
						yAxisTickFormatter={(value) => formatNumber(Number(value))}
						tooltipFormatter={(value, name) => [
							formatNumber(Number(value)),
							String(name),
						]}
						tooltipLabelFormatter={makeTimeTooltipLabelFormatter(timeRange)}
					/>
				</CardContent>
			</Card>
			{accountRows.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle>Active Sessions by account (this range)</CardTitle>
						<CardDescription>
							Distinct sessions per account across the whole selected range
							(COUNT DISTINCT) — same denominator as the badge above, split by
							account instead of by client.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<BaseBarChart
							data={accountRows as unknown as ChartDataPoint[]}
							bars={{
								dataKey: "sessions",
								radius: [0, 4, 4, 0],
								name: "Sessions",
							}}
							xAxisKey="accountName"
							height="medium"
							layout="vertical"
							yAxisWidth={140}
							xAxisTickFormatter={(value) => formatNumber(Number(value))}
							tooltipFormatter={(value) => [
								formatNumber(Number(value)),
								"Sessions",
							]}
						/>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
