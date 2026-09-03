import { STOP_CAUSES, type StopsHistoryResponse } from "@clankermux/types";
import { AlertCircle } from "lucide-react";
import { formatDurationDhm } from "../../lib/format-prediction";
import {
	STOP_CAUSE_COLORS,
	STOP_CAUSE_LABELS,
} from "../../lib/stop-cause-labels";
import { BaseBarChart } from "../charts/BaseBarChart";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { InsetPanel } from "../ui/inset-panel";
import { PanelEmptyState } from "../ui/panel-empty-state";
import { Skeleton } from "../ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableFrame,
	TableHead,
	TableHeader,
	TableRow,
} from "../ui/table";

interface StopsHistoryCardProps {
	data: StopsHistoryResponse | undefined;
	/**
	 * The tab's ticking clock, for the "last seen" ages. The RANGE is not a prop:
	 * it lives in the query key, so the payload handed here already belongs to
	 * the selected range and a second copy could only disagree with it.
	 */
	now: number;
	/** Set while the first read is in flight and nothing is cached. */
	loading?: boolean;
	/** Set when that read FAILED with nothing cached. Wins over `loading`. */
	unavailableReason?: string;
	staleNote?: string;
}

/** The per-bucket stacked series, one key per cause that actually occurred. */
function chartRows(
	data: StopsHistoryResponse,
): Array<Record<string, number | string>> {
	const byTs = new Map<number, Record<string, number | string>>();
	for (const cause of data.causes) {
		for (const point of cause.series) {
			let row = byTs.get(point.ts);
			if (!row) {
				row = { ts: new Date(point.ts).toLocaleString() };
				byTs.set(point.ts, row);
			}
			row[cause.cause] = point.count;
		}
	}
	return [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
}

/**
 * How much redundancy the pool had, bucketed into the three answers that differ
 * in kind.
 *
 * Zero candidates means the request could not be served at all; one means it
 * was one failure from that; two or more means it had a fallback. The raw
 * distribution goes up to the account count and reading it as a list buries
 * that distinction under noise.
 */
function candidatesLine(data: StopsHistoryResponse): string {
	const { observedRequests, distribution } = data.candidates;
	if (observedRequests === 0) return "No eligibility data";
	let none = 0;
	let one = 0;
	let two = 0;
	for (const row of distribution) {
		if (row.candidatesCount === 0) none += row.requests;
		else if (row.candidatesCount === 1) one += row.requests;
		else two += row.requests;
	}
	const pct = (n: number) => `${((n / observedRequests) * 100).toFixed(1)}%`;
	// Count AND share for every bucket, in one frame. A count for `none` beside
	// percentages for the other two read as "4% had no candidate", and left the
	// figure that matters most — how many requests actually had nowhere to go —
	// recoverable only by arithmetic.
	return [
		`none: ${none} (${pct(none)})`,
		`one: ${one} (${pct(one)})`,
		`two or more: ${two} (${pct(two)})`,
		`eligibility observed for ${observedRequests} of ${data.totalRequests} requests`,
	].join(" · ");
}

/**
 * How often a request was ACTUALLY blocked, by cause.
 *
 * Every other quota surface on this page is a projection: a percentage, a
 * runway, a pace. This one is the record of what happened, and it is the only
 * thing that can say whether the projections were describing a real risk. A
 * pool that reads 90% used for a week and never refused a request is not the
 * same situation as one that reads 60% and stopped twice.
 *
 * The candidate distribution beside it is the leading indicator the forecasts
 * cannot see: a pool that never drops below two eligible accounts has margin no
 * projection can take away, and one that spends its time at one candidate is a
 * single failure from a stop regardless of how much quota it shows.
 */
export function StopsHistoryCard({
	data,
	now,
	loading = false,
	unavailableReason,
	staleNote,
}: StopsHistoryCardProps) {
	const pending = loading && !unavailableReason;
	const resolved = !pending && !unavailableReason && data != null;

	// Only causes actually present get a bar, so the legend names failure modes
	// this pool has seen rather than the whole vocabulary. Ordered by
	// STOP_CAUSES so the stack order is stable between polls.
	const presentCauses = resolved
		? STOP_CAUSES.filter((cause) => data.causes.some((c) => c.cause === cause))
		: [];

	return (
		<Card>
			<CardHeader>
				<CardTitle>Stops</CardTitle>
				<CardDescription>
					How often a request was actually blocked in this range, by cause, and
					how many accounts were eligible per request.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-group">
				{unavailableReason ? (
					<p className="flex items-center gap-item text-xs text-warning-strong">
						<AlertCircle className="h-3.5 w-3.5 shrink-0" />
						{unavailableReason}
					</p>
				) : !resolved ? (
					<InsetPanel className="space-y-tight">
						<Skeleton className="h-5 w-48" />
						<Skeleton className="h-4 w-64" />
					</InsetPanel>
				) : (
					<>
						<InsetPanel className="space-y-tight text-xs">
							<p className="text-sm font-medium">
								{data.blockedRequests} of {data.totalRequests} requests blocked
								{data.totalRequests === 0
									? " (—)"
									: ` (${((data.blockedRequests / data.totalRequests) * 100).toFixed(2)}%)`}
							</p>
							<p className="text-muted-foreground">{candidatesLine(data)}</p>
							{staleNote && (
								<p className="text-muted-foreground">{staleNote}</p>
							)}
						</InsetPanel>

						{data.blockedRequests === 0 ? (
							<PanelEmptyState>
								No blocked requests in this range
							</PanelEmptyState>
						) : (
							<>
								<BaseBarChart
									data={chartRows(data)}
									xAxisKey="ts"
									height="small"
									showLegend
									bars={presentCauses.map((cause) => ({
										dataKey: cause,
										name: STOP_CAUSE_LABELS[cause],
										fill: STOP_CAUSE_COLORS[cause],
										// One total per bucket, not several series to compare:
										// side by side, a bucket of many small causes looks
										// calmer than one large cause of the same total.
										stackId: "stops",
									}))}
								/>

								<TableFrame>
									<Table density="compact">
										<TableHeader>
											<TableRow>
												<TableHead>Cause</TableHead>
												<TableHead>Count</TableHead>
												<TableHead>Top model</TableHead>
												<TableHead>Last seen</TableHead>
												<TableHead>Sample</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{[...data.causes]
												.sort((a, b) => b.count - a.count)
												.map((cause) => (
													<TableRow key={cause.cause}>
														<TableCell>
															{STOP_CAUSE_LABELS[cause.cause]}
														</TableCell>
														<TableCell className="tabular-nums">
															{cause.count}
														</TableCell>
														<TableCell>
															{cause.topRequestedModel
																? `${cause.topRequestedModel} ×${cause.topRequestedModelCount}`
																: "—"}
														</TableCell>
														<TableCell className="tabular-nums">
															{formatDurationDhm(
																Math.max(0, now - cause.lastSeenMs),
															)}{" "}
															ago
														</TableCell>
														<TableCell
															className="max-w-56 truncate text-muted-foreground"
															title={cause.sampleErrorMessage ?? undefined}
														>
															{cause.sampleErrorMessage ?? "—"}
														</TableCell>
													</TableRow>
												))}
										</TableBody>
									</Table>
								</TableFrame>
							</>
						)}
					</>
				)}
			</CardContent>
		</Card>
	);
}
