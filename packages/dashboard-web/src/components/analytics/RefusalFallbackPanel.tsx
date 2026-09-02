import type { RefusalFallbackAnalytics } from "@clankermux/types";
import { formatNumber } from "@clankermux/ui-common";
import { format } from "date-fns";
import { ShieldAlert } from "lucide-react";
import { useMemo } from "react";
import type { TimeRange } from "../../constants";
import { useSeriesPalette } from "../../hooks/useSeriesPalette";
import { BaseBarChart } from "../charts";
import { longRangeAxisProps } from "../charts/chart-utils";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { PanelEmptyState } from "../ui/panel-empty-state";
import { SectionHeading } from "../ui/section-heading";
import {
	Table,
	TableBody,
	TableCell,
	TableFrame,
	TableHead,
	TableHeader,
	TableRow,
} from "../ui/table";
import { StatTile } from "./StatTile";

interface RefusalFallbackPanelProps {
	data: RefusalFallbackAnalytics | undefined;
	loading: boolean;
	timeRange: TimeRange;
}

/**
 * Display label for a provider or model the row could not name.
 *
 * Distinct from the RECORDED refusal category `"unknown"`, which means the
 * provider refused but named no category — that value comes off the wire and is
 * rendered verbatim.
 */
const UNKNOWN_LABEL = "unknown";

/** Percentage with one decimal; `null` denominator renders an em dash. */
function formatShare(refusals: number, eligible: number): string {
	if (eligible <= 0) return "—";
	return `${((refusals / eligible) * 100).toFixed(1)}%`;
}

/**
 * Safety refusals and the fallback retries that follow them.
 *
 * Two counts that mean different things and are deliberately NOT summed: a
 * refusal is a turn a provider's safety filter declined, and a fallback retry
 * is the follow-up request Claude Code sent to a different model to recover
 * from one. They are usually paired, but neither implies the other — a refusal
 * whose credit was never redeemed leaves only the first, and a retry whose
 * refusal this proxy never saw (a restart, or another proxy served it) leaves
 * only the second.
 */
export function RefusalFallbackPanel({
	data,
	loading,
	timeRange,
}: RefusalFallbackPanelProps) {
	const palette = useSeriesPalette();

	const chartData = useMemo(() => {
		const formatter =
			timeRange === "30d" || timeRange === "all"
				? (date: Date) => format(date, "MMM d")
				: (date: Date) => format(date, "HH:mm");
		return (data?.timeSeries ?? []).map((point) => ({
			time: formatter(new Date(point.ts)),
			refusals: point.refusals,
			fallbackRetries: point.fallbackRetries,
		}));
	}, [data?.timeSeries, timeRange]);

	// Absent (rather than empty) data means the server did not compute the
	// section at all; MissingSectionsNotice already says so at the top of the
	// tab, and a second empty card under it would read as "no refusals".
	if (!data && !loading) return null;

	const totals = data?.totals ?? {
		refusals: 0,
		fallbackRetries: 0,
		eligibleRequests: 0,
	};
	const isEmpty =
		!loading && totals.refusals === 0 && totals.fallbackRetries === 0;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-item">
					<ShieldAlert className="h-5 w-5" />
					Safety refusals and fallbacks
				</CardTitle>
				<CardDescription>
					Requests a provider's safety filters declined, and the retries Claude
					Code sent to a fallback model with a fallback credit.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-section">
				<div className="grid grid-cols-1 gap-item sm:grid-cols-3">
					<StatTile label="Refusals" value={formatNumber(totals.refusals)} />
					<StatTile
						label="Fallback retries"
						value={formatNumber(totals.fallbackRetries)}
					/>
					<StatTile
						label="Share of requests"
						value={formatShare(totals.refusals, totals.eligibleRequests)}
						// The denominator is stated because it is NOT every request in
						// range: rows recorded before refusal capture shipped carry no
						// stop reason and are excluded rather than diluting the share.
						sub={`${formatNumber(totals.refusals)} of ${formatNumber(
							totals.eligibleRequests,
						)} completed requests with a recorded stop reason`}
					/>
				</div>

				{isEmpty ? (
					<PanelEmptyState>No safety refusals in this range</PanelEmptyState>
				) : (
					<>
						<BaseBarChart
							data={chartData}
							xAxisKey="time"
							bars={[
								{
									dataKey: "refusals",
									name: "Refusals",
									fill: palette.sequence[0],
								},
								{
									dataKey: "fallbackRetries",
									name: "Fallback retries",
									fill: palette.sequence[1],
								},
							]}
							loading={loading}
							height="medium"
							showLegend
							{...longRangeAxisProps(timeRange)}
						/>

						<div className="grid grid-cols-1 gap-section lg:grid-cols-2">
							<div className="space-y-row">
								<SectionHeading title="By category" />
								<TableFrame>
									<Table aria-label="Refusals by category">
										<TableHeader>
											<TableRow>
												<TableHead>Provider</TableHead>
												<TableHead>Category</TableHead>
												<TableHead className="text-right">Count</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{(data?.byCategory ?? []).map((row) => (
												<TableRow key={`${row.provider}:${row.category}`}>
													<TableCell>{row.provider ?? UNKNOWN_LABEL}</TableCell>
													<TableCell>{row.category}</TableCell>
													<TableCell className="text-right figure">
														{formatNumber(row.count)}
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								</TableFrame>
							</div>

							<div className="space-y-row">
								<SectionHeading title="Fallback model" />
								<TableFrame>
									<Table aria-label="Fallback retries by model pair">
										<TableHeader>
											<TableRow>
												<TableHead>From</TableHead>
												<TableHead>To</TableHead>
												<TableHead className="text-right">Count</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{(data?.byModelPair ?? []).map((row) => (
												<TableRow key={`${row.fromModel}:${row.toModel}`}>
													<TableCell>
														{row.fromModel ?? UNKNOWN_LABEL}
													</TableCell>
													<TableCell>{row.toModel ?? UNKNOWN_LABEL}</TableCell>
													<TableCell className="text-right figure">
														{formatNumber(row.count)}
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								</TableFrame>
							</div>
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
}
