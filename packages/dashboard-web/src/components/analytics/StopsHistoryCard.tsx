import {
	outcomeForCause,
	REQUEST_OUTCOMES,
	type RequestOutcome,
	STOP_CAUSES,
	type StopsHistoryResponse,
} from "@clankermux/types";
import { AlertCircle, Info } from "lucide-react";
import { useState } from "react";
import { formatDurationDhm } from "../../lib/format-prediction";
import {
	STOP_CAUSE_COLORS,
	STOP_CAUSE_LABELS,
} from "../../lib/stop-cause-labels";
import { BaseBarChart } from "../charts/BaseBarChart";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { InsetPanel } from "../ui/inset-panel";
import { PanelEmptyState } from "../ui/panel-empty-state";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
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
	 * The tab's ticking clock, for the "last seen" ages. Neither the RANGE nor
	 * the FILTERS are props: both live in the query key, so the payload handed
	 * here already belongs to the current selection and a second copy could only
	 * disagree with it.
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

const OUTCOME_LABELS: Record<RequestOutcome, string> = {
	blocked: "Blocked",
	failed: "Failed",
	disconnected: "Disconnected",
	unclassified: "Unclassified",
};

/** Counts always describe the whole selection; toggles filter only chart and table. */
export function StopsHistoryCard({
	data,
	now,
	loading = false,
	unavailableReason,
	staleNote,
}: StopsHistoryCardProps) {
	const [enabled, setEnabled] = useState<Record<RequestOutcome, boolean>>({
		blocked: true,
		failed: true,
		disconnected: false,
		unclassified: true,
	});
	const visibleCauses =
		data?.causes.filter((c) => enabled[outcomeForCause(c.cause)]) ?? [];
	const unsuccessfulRequests = data
		? Object.values(data.outcomeTotals).reduce((n, count) => n + count, 0)
		: 0;
	const pending = loading && !unavailableReason;
	const resolved = !pending && !unavailableReason && data != null;

	// Only causes actually present get a bar, so the legend names failure modes
	// this pool has seen rather than the whole vocabulary. Ordered by
	// STOP_CAUSES so the stack order is stable between polls.
	const presentCauses = resolved
		? STOP_CAUSES.filter((cause) =>
				visibleCauses.some((c) => c.cause === cause),
			)
		: [];

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-item">
					<CardTitle>Request outcomes</CardTitle>
					<Popover>
						<PopoverTrigger asChild>
							<button
								type="button"
								aria-label="About request outcomes"
								className="rounded text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<Info className="h-4 w-4" aria-hidden="true" />
							</button>
						</PopoverTrigger>
						<PopoverContent className="space-y-item text-xs">
							<p>
								Counts describe recorded requests and their stored terminal
								reason. A disconnect can mean cancellation, a harness abort, or
								a connection closing; it does not identify who intended to stop.
							</p>
							<p>
								Requests blocked before an account was chosen have no account.
								An account filter hides them; the no-account filter includes
								them.
							</p>
							<p>
								Outcome toggles filter the chart and table. The summary always
								includes every outcome. Captured upstream errors can replace a
								transport reason. Older completion miscounts cannot be
								reconstructed from these records.
							</p>
						</PopoverContent>
					</Popover>
				</div>
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
								{unsuccessfulRequests} of {data.totalRequests} recorded requests
								did not complete
								{data.totalRequests === 0
									? " (—)"
									: ` (${((unsuccessfulRequests / data.totalRequests) * 100).toFixed(2)}%)`}
							</p>
							<fieldset
								className="flex min-w-0 flex-wrap gap-item"
								aria-label="Outcome groups shown in chart and table"
							>
								{REQUEST_OUTCOMES.filter(
									(outcome) =>
										outcome !== "unclassified" ||
										data.outcomeTotals.unclassified > 0,
								).map((outcome) => (
									<Button
										key={outcome}
										type="button"
										size="sm"
										variant={enabled[outcome] ? "secondary" : "outline"}
										aria-pressed={enabled[outcome]}
										className={
											outcome === "disconnected"
												? "text-muted-foreground"
												: undefined
										}
										onClick={() =>
											setEnabled((previous) => ({
												...previous,
												[outcome]: !previous[outcome],
											}))
										}
									>
										{OUTCOME_LABELS[outcome]} · {data.outcomeTotals[outcome]}
									</Button>
								))}
							</fieldset>
							{staleNote && (
								<p className="text-muted-foreground">{staleNote}</p>
							)}
						</InsetPanel>

						{unsuccessfulRequests === 0 ? (
							<PanelEmptyState>
								No unsuccessful requests in this range
							</PanelEmptyState>
						) : visibleCauses.length === 0 ? (
							<PanelEmptyState>
								No requests in the selected outcome groups
							</PanelEmptyState>
						) : (
							<>
								<BaseBarChart
									data={chartRows({ ...data, causes: visibleCauses })}
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
												<TableHead>Outcome</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{[...visibleCauses]
												.sort((a, b) => b.count - a.count)
												.map((cause) => (
													<TableRow key={cause.cause}>
														<TableCell>
															{cause.sampleErrorMessage ? (
																<details>
																	<summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
																		{STOP_CAUSE_LABELS[cause.cause]}
																	</summary>
																	<p className="mt-2 max-w-sm whitespace-normal break-words text-xs text-muted-foreground">
																		{cause.sampleErrorMessage}
																	</p>
																</details>
															) : (
																STOP_CAUSE_LABELS[cause.cause]
															)}
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
														<TableCell className="max-w-56 truncate text-muted-foreground">
															{OUTCOME_LABELS[outcomeForCause(cause.cause)]}
														</TableCell>
													</TableRow>
												))}
										</TableBody>
									</Table>
								</TableFrame>
							</>
						)}
						<div className="space-y-tight text-xs text-muted-foreground">
							<p>{candidatesLine(data)}</p>
							{data.excludedAttemptAuditRows > 0 && (
								<p>
									{data.excludedAttemptAuditRows} legacy retry attempts excluded
								</p>
							)}
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
}
