import type {
	PoolSizingBoundaryRule,
	PoolSizingCycle,
	PoolSizingResponse,
	PoolSizingRow,
	PoolSizingVerdictBasis,
} from "@clankermux/types";
import { format } from "date-fns";
import { AlertCircle } from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { InsetPanel } from "../ui/inset-panel";
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

/**
 * How much of the pool a completed weekly cycle actually consumed.
 *
 * The panel answers one question — could this work have been served by one
 * account fewer — and it can only ever answer it in ONE direction. Above n - 1
 * account-weeks the answer is no, provably. Below it there is no answer here at
 * all: the traffic that was served is not the traffic that would have been
 * offered, and this page models no counterfactual. Nothing it renders says an
 * account is removable, and the copy is written so a reader cannot construct
 * that reading from it either.
 *
 * Everything is a table of counts. No chart: the unit is a completed weekly
 * cycle, of which there are twelve at most, and a line through twelve points
 * invites reading a trend into a measurement whose lower bounds and unit
 * changes are exactly what the columns beside it are there to disclose.
 */
export interface PoolSizingPanelProps {
	data?: PoolSizingResponse;
	loading?: boolean;
	/** Set when the read failed outright; replaces the body with the reason. */
	unavailableReason?: string;
}

const VERDICT_LABEL: Record<PoolSizingRow["verdict"], string> = {
	removal_infeasible: "Removal infeasible",
	removal_not_established: "Removal not established",
	insufficient_history: "Insufficient history",
};

/**
 * Why a cycle did not settle the question, in the reader's words.
 *
 * Only the two branches that BLOCK a verdict get a note. "Above" and "at or
 * below" the threshold are already stated by the number beside them, and
 * repeating them in prose would bury the two cases that mean the number cannot
 * be read as a comparable unit at all.
 */
const BASIS_NOTE: Partial<Record<PoolSizingVerdictBasis, string>> = {
	tiers_not_comparable: "tiers differ or unknown",
	multiple_windows: "an account ended more than one window",
};

const BASIS_TITLE: Record<PoolSizingVerdictBasis, string> = {
	above_threshold: "consumed more than n - 1 account-weeks in comparable units",
	at_or_below_threshold: "consumed n - 1 account-weeks or less",
	tiers_not_comparable:
		"the accounts of this row report different or unknown tiers, so their account-weeks are not one unit",
	multiple_windows:
		"an account ended more than one window in this cycle, so its peaks were summed",
	in_progress: "the cycle has not finished",
};

const LOWER_BOUND_TITLE = "lower bound: part of this cycle was not sampled";

function rowKey(row: PoolSizingRow): string {
	return `${row.classId}\u0000${row.family ?? ""}`;
}

function rowLabel(row: PoolSizingRow): string {
	return row.kind === "family"
		? (row.familyLabel ?? row.family ?? "")
		: row.classLabel;
}

function formatDay(ms: number): string {
	return format(new Date(ms), "MMM d");
}

const UTC_DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	timeZone: "UTC",
});

/**
 * A day on the cycle grid, which is defined in UTC. Grid boundaries must not
 * shift with the viewer's timezone; `formatDay` stays local because it renders
 * window-end instants, which are moments the reader lived through.
 */
function formatUtcDay(ms: number): string {
	return UTC_DAY_FORMAT.format(new Date(ms));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How one cycle is named, which differs by how the row's cycles are bounded.
 *
 * `iso_week` rows are bucketed by a calendar week (Monday 00:00 UTC), so the
 * label is that week — Monday through Sunday. The windows inside it end
 * wherever the rolling window happened to land, and naming a row by that day
 * names the window rather than the cycle the row is boundaried by.
 *
 * `reset_phase_gap` rows have no calendar week: the 7-day grid is anchored at
 * the pool's reset phases, so the label is the span the cycle's windows
 * actually ended in, collapsed to one day when they coincide.
 */
function cycleLabel(
	cycle: PoolSizingCycle,
	boundaryRule: PoolSizingBoundaryRule,
): string {
	if (boundaryRule === "iso_week") {
		return `${formatUtcDay(cycle.start)} – ${formatUtcDay(cycle.end - DAY_MS)}`;
	}
	if (cycle.resetFrom === null || cycle.resetTo === null) {
		return `${formatDay(cycle.start)} – ${formatDay(cycle.end)}`;
	}
	const from = formatDay(cycle.resetFrom);
	const to = formatDay(cycle.resetTo);
	return from === to ? from : `${from} – ${to}`;
}

function consumedText(cycle: PoolSizingCycle): string {
	const prefix = cycle.lowerBound ? "≥ " : "";
	return `${prefix}${cycle.consumed.toFixed(2)} of ${cycle.accountsInPool}`;
}

function addSignalText(row: PoolSizingRow): string {
	if (row.reserveBandCycles === 0 && row.terminalStopCycles === 0) {
		return "none";
	}
	return `reserve band in ${row.reserveBandCycles} of ${row.verdictCycles} cycles · stops in ${row.terminalStopCycles} of ${row.verdictCycles} cycles`;
}

export function PoolSizingPanel({
	data,
	loading = false,
	unavailableReason,
}: PoolSizingPanelProps) {
	const pending = loading && !unavailableReason;
	const resolved = !pending && !unavailableReason && data != null;
	const rows = resolved ? data.rows : [];

	return (
		<Card>
			<CardHeader>
				<CardTitle>Pool sizing</CardTitle>
				<CardDescription>
					Account-weeks consumed per completed weekly cycle, from the stored
					usage samples.
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
						{rows.length === 0 ? (
							<p className="text-xs text-muted-foreground">
								No weekly usage samples recorded yet.
							</p>
						) : (
							<>
								<SummaryTable rows={rows} />
								{rows.map((row) => (
									<CycleDetails key={rowKey(row)} row={row} />
								))}
							</>
						)}
						{/*
						 * Outside the rows branch on purpose: these stops are exactly
						 * the evidence that survives when no pool has a sampled cycle,
						 * and hiding them there would hide them when they are all there
						 * is.
						 */}
						{data.separateStops.length > 0 ? (
							<InsetPanel className="space-y-tight text-xs">
								<p className="text-sm font-medium">
									Stops not counted as capacity
								</p>
								{data.separateStops.map((stop) => (
									<p
										key={`${stop.label}\u0000${stop.model ?? ""}`}
										className="text-muted-foreground"
									>
										{stop.label} · {stop.model ?? "unknown model"} ·{" "}
										{stop.count.toLocaleString()} · last{" "}
										{formatDay(stop.lastAt)}
									</p>
								))}
							</InsetPanel>
						) : null}
						<HowThisIsComputed />
					</>
				)}
			</CardContent>
		</Card>
	);
}

function SummaryTable({ rows }: { rows: PoolSizingRow[] }) {
	return (
		<TableFrame variant="bare">
			<Table className="text-xs" density="compact">
				<TableHeader className="bg-transparent">
					<TableRow className="border-t-0">
						<TableHead>Pool</TableHead>
						<TableHead>Verdict</TableHead>
						<TableHead>Latest completed cycle</TableHead>
						<TableHead>Tier</TableHead>
						<TableHead>Add signal</TableHead>
						<TableHead>In progress</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => {
						const latest = row.cycles.find(
							(cycle) => cycle.status === "completed",
						);
						// EVERY unfinished cycle, not only the one whose span contains
						// the clock: a window open right now whose reset falls in the
						// next cycle produces an in-progress cycle that starts in the
						// future, and it is carrying live consumption.
						const inProgress = row.cycles.filter(
							(cycle) => cycle.status === "in_progress",
						);
						const note = latest ? BASIS_NOTE[latest.verdictBasis] : undefined;
						return (
							<TableRow key={rowKey(row)} className="align-top">
								<TableCell
									className={
										row.kind === "family" ? "pl-row text-muted-foreground" : ""
									}
								>
									{rowLabel(row)}
								</TableCell>
								<TableCell>
									{VERDICT_LABEL[row.verdict]}
									{note ? (
										<span className="block text-muted-foreground">{note}</span>
									) : null}
								</TableCell>
								<TableCell className="figure">
									{latest ? (
										<>
											{consumedText(latest)} account-weeks
											<span className="block text-muted-foreground">
												{cycleLabel(latest, row.boundaryRule)}
											</span>
										</>
									) : (
										"—"
									)}
								</TableCell>
								<TableCell>{latest?.tierLabel ?? "—"}</TableCell>
								<TableCell>{addSignalText(row)}</TableCell>
								<TableCell className="figure">
									{inProgress.length === 0
										? "—"
										: inProgress.map((cycle) => (
												<span key={cycle.start} className="block">
													{`${cycleLabel(cycle, row.boundaryRule)}: ${cycle.consumed.toFixed(2)} of ${cycle.accountsInPool} so far`}
												</span>
											))}
								</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</TableFrame>
	);
}

function CycleDetails({ row }: { row: PoolSizingRow }) {
	return (
		<details className="rounded-lg border p-row">
			<summary className="text-sm font-medium cursor-pointer">
				{rowLabel(row)} cycles
			</summary>
			<TableFrame variant="bare" className="mt-item">
				<Table className="text-xs" density="compact">
					<TableHeader className="bg-transparent">
						<TableRow className="border-t-0">
							<TableHead>Cycle</TableHead>
							<TableHead>Status</TableHead>
							<TableHead>Accounts</TableHead>
							<TableHead>Consumed</TableHead>
							<TableHead>Removal</TableHead>
							<TableHead>Reserve band</TableHead>
							<TableHead>Stops</TableHead>
							<TableHead>Rejected attempts</TableHead>
							<TableHead>5h burst</TableHead>
							<TableHead>Tier</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{row.cycles.map((cycle) => (
							<TableRow key={cycle.start} className="align-top">
								<TableCell>{cycleLabel(cycle, row.boundaryRule)}</TableCell>
								<TableCell>
									{cycle.status === "completed" ? "Completed" : "In progress"}
								</TableCell>
								<TableCell className="figure">
									{cycle.accountsObserved === cycle.accountsInPool
										? cycle.accountsInPool
										: `${cycle.accountsObserved} of ${cycle.accountsInPool}`}
								</TableCell>
								<TableCell
									className="figure"
									title={cycle.lowerBound ? LOWER_BOUND_TITLE : undefined}
								>
									{consumedText(cycle)}
								</TableCell>
								<TableCell title={BASIS_TITLE[cycle.verdictBasis]}>
									{cycle.status === "completed"
										? cycle.removalInfeasible
											? "infeasible"
											: "not established"
										: "—"}
								</TableCell>
								<TableCell>
									{cycle.status === "completed"
										? cycle.reserveBandEntered
											? "yes"
											: "no"
										: "—"}
								</TableCell>
								<TableCell className="figure">{cycle.terminalStops}</TableCell>
								<TableCell className="figure">
									{cycle.rejectedAttempts}
								</TableCell>
								<TableCell className="figure">
									{cycle.burstPeakAccounts ?? "—"}
								</TableCell>
								<TableCell>{cycle.tierLabel ?? "—"}</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</TableFrame>
		</details>
	);
}

/**
 * Collapsed and last, on the same terms as the claim-series audit: a reader who
 * wants to know what a verdict rests on comes here AFTER seeing the verdict.
 * Every paragraph states a rule that changes how a number above should be read,
 * which is why none of them is a tooltip.
 */
function HowThisIsComputed() {
	return (
		<details className="rounded-lg border p-row">
			<summary className="text-sm font-medium cursor-pointer">
				How this is computed
			</summary>
			<div className="space-y-item mt-item text-xs text-muted-foreground max-w-prose">
				<p>
					The measure is the sum, over a pool's accounts, of each account's peak
					weekly utilization inside its own reset window. Tier is a label on
					that sum and never a weight: account-weeks whose tiers differ, or are
					not known, are not compared at all.
				</p>
				<p>
					A moved reset is a revision of the current window unless consumption
					dropped or the reset moved by a day or more. A window abandoned before
					its reset counts in the cycle where it actually ended. A reset that
					stayed a full week ahead of every sample, at zero, is idle time rather
					than a window.
				</p>
				<p>
					Claude accounts reset on fixed weekdays, so a Claude cycle groups each
					account's window ending in the same 7-day span, cut at the widest gap
					between the pool's reset times. Codex windows roll and re-anchor, so
					GPT cycles are ISO weeks and one account can end more than one window
					in a week.
				</p>
				<p>
					The verdict is one-sided. Above n - 1 comparable account-weeks,
					removal is infeasible. Unknown or differing tiers, or an account with
					more than one window, leave it not established. Nothing here ever says
					an account is removable.
				</p>
				<p>
					Sampling gaps are never filled in. An account that was not sampled
					still counts in n and the cycle is marked as a lower bound, so a
					figure prefixed with ≥ is a floor rather than a measurement.
				</p>
				<p>
					Stops are attributed to the class that normally serves the requested
					model. Terminal refusals are counted apart from rejected attempts,
					which usually failed over to another account and were served. Give-up
					terminals and no-account exclusions are listed separately and counted
					in no pool.
				</p>
				<p>
					Deleting an account deletes its usage history with it, so no
					before-and-after comparison across a removal survives in this data.
				</p>
			</div>
		</details>
	);
}
