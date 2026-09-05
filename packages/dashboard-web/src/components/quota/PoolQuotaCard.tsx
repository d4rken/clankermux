import {
	burnRatioTone,
	computeBurnRatio,
	formatBurnRatio,
	type PoolUsageResult,
	poolClassOutlook,
	type ServableClassPool,
	scopeResultToClass,
	willRunOutCount,
} from "@clankermux/core";
import { AlertCircle, AlertTriangle, Clock, Info } from "lucide-react";
import { cn } from "../../lib/utils";
import { Card, CardContent } from "../ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Skeleton } from "../ui/skeleton";
import { TONE_FIGURE_CLASS } from "./outlook-tone";
import { PoolClassBars } from "./PoolClassBars";
import {
	familyWeeklyBadge,
	PoolDetailSection,
	windowTimeLabel,
} from "./PoolDetailSection";

interface PoolQuotaCardProps {
	/** The weekly pool for ONE servable class. The budget. */
	weekly: ServableClassPool;
	/** The same class's 5-hour pool, or null when it reports none. */
	fiveHour: ServableClassPool | null;
	/** Whole-window results, for the shared breakdown and the family badge. */
	weeklyResult: PoolUsageResult;
	/**
	 * The tab's ticking clock. The pace row divides utilization by where an even
	 * burn would sit AT THIS INSTANT, so it has to advance between polls rather
	 * than freeze at whenever the component happened to first render.
	 */
	now: number;
	loading?: boolean;
	unavailableReason?: string;
	staleNote?: string;
}

/**
 * One servable class's quota, headlined by how much room its freshest account
 * still has.
 *
 * Two departures from what this replaced, both load-bearing.
 *
 * THE HEADLINE IS HEADROOM ON ONE NAMED ACCOUNT, not the pool average. Routing
 * picks a single account, so "is there an account with room, and which" is the
 * question that maps to what happens next; an average of a spent account and a
 * fresh one describes neither. It is also the steadier reading — measured across
 * 45 days of production data the least-used account moved monotonically, while
 * the average jumped whenever an account rolled over.
 *
 * THE 5-HOUR WINDOW IS A ROW, NOT A SECOND CARD. The two were rendered as
 * symmetric tiles, which states that they are two budgets. They are not: the
 * weekly window is the budget and the 5-hour window is the rate governor that
 * paces you through it. Resetting or dodging the 5-hour window grants no
 * capacity — it only removes the pacing — so giving it equal visual weight
 * invited exactly the wrong reading of which number to worry about.
 */
export function PoolQuotaCard({
	weekly,
	fiveHour,
	weeklyResult,
	now,
	loading = false,
	unavailableReason,
	staleNote,
}: PoolQuotaCardProps) {
	const pending = loading && !unavailableReason;
	const resolved = !pending && !unavailableReason;
	const leastUsed = weekly.leastUsed;
	// Utilization, not headroom. Every other quota surface in the app — the
	// account bars right below this figure, the Usage page, the runway chip —
	// states percent USED, and a headline stating percent LEFT put two readings
	// of the same fact next to each other ("75% left" above a bar labelled 25%).
	// One frame, and it is the one the rest of the app already speaks.
	const usedPct = leastUsed?.pct ?? null;
	const tone = TONE_FIGURE_CLASS[poolClassOutlook(weekly).tone];
	// Scoped to THIS class. Handed the pool-wide result, every card rendered
	// every account: a Codex card announced that a Claude model family was
	// exhausted, and a one-account card's popover listed six.
	const scoped = scopeResultToClass(weeklyResult, weekly);
	const family = familyWeeklyBadge(scoped.familyWeekly);
	// Scoped to the class as well: the pool-wide count would state, on a
	// one-account card, how many accounts across every class will run out.
	const { willRunOut, capacity, spent } = willRunOutCount(scoped, "seven_day");

	const fiveHourLeast = fiveHour?.leastUsed ?? null;
	const paceText =
		fiveHourLeast == null
			? null
			: `5h pace: ${Math.round(fiveHourLeast.pct)}% used · ${fiveHourLeast.name}`;
	// A percentage is a POSITION; this is the RATE behind the one the headline
	// states. 48% used one day into the week and 48% used six days in are
	// opposite situations, and the reader was left to do that division against a
	// reset printed on another line.
	//
	// Divided by the WEEKLY window, matching the figure above it and the Usage
	// page's own pace row. Against the 5-hour window it was a rate for a
	// different quantity than the percentage it sat under, and the two surfaces
	// printed different multiples of "sustainable" for the same pool.
	const burn = computeBurnRatio(
		leastUsed?.pct ?? 0,
		leastUsed?.resetMs ?? null,
		"seven_day",
		now,
	);

	// An UNSTARTED weekly window reports a reset, but it is `now + 7d`
	// re-stamped on every poll until the first request pins it. Those windows are
	// excluded from `earliestResetMs` upstream, so the absence here has to say
	// which kind of absence it is rather than falling silent.
	const checkpoint =
		weekly.earliestResetMs == null
			? weekly.unstartedCount > 0
				? "not started; resets 7d after first use"
				: null
			: `${
					weekly.unstartedCount > 0
						? `${weekly.unstartedCount} not started · `
						: ""
				}resets ${windowTimeLabel(weekly.earliestResetMs, "seven_day")}${
					weekly.earliestResetAccountName
						? ` · ${weekly.earliestResetAccountName}`
						: ""
				}`;

	return (
		<Card>
			<CardContent className="p-4">
				<div className="mb-tight flex items-center justify-between gap-item">
					<p className="truncate text-sm text-muted-foreground">
						{weekly.label}
					</p>
					{resolved && weekly.eligibleTotal > 0 && (
						<Popover>
							<PopoverTrigger asChild>
								<button
									type="button"
									className="flex shrink-0 items-center gap-tight rounded text-xs text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									<span className="tabular-nums">
										({weekly.reportingCount}/{weekly.eligibleTotal} active)
									</span>
									<Info className="h-3 w-3" />
								</button>
							</PopoverTrigger>
							<PopoverContent className="w-72 space-y-row text-xs">
								<PoolDetailSection result={scoped} window="seven_day" />
							</PopoverContent>
						</Popover>
					)}
				</div>

				{unavailableReason ? (
					<>
						<p className="figure-xl text-muted-foreground/60">—</p>
						<p className="flex items-center gap-item text-xs text-warning-strong">
							<AlertCircle className="h-3.5 w-3.5 shrink-0" />
							{unavailableReason}
						</p>
					</>
				) : pending ? (
					<Skeleton className="h-7 w-24" />
				) : usedPct == null ? (
					<>
						<p className="figure-xl text-muted-foreground/60">—</p>
						<p className="text-xs text-muted-foreground">
							No account reporting weekly usage
						</p>
					</>
				) : (
					<>
						<p className={cn("figure-xl", tone)}>{Math.round(usedPct)}% used</p>
						<p className="truncate text-xs text-muted-foreground">
							lowest · {leastUsed?.name}
						</p>
					</>
				)}

				{/* Directly beneath the headline caption, ahead of the bars: this is
				    the rate behind the figure immediately above it, and further down
				    the card it read as a property of the account list instead. */}
				{resolved && burn && (
					<p
						className={cn(
							"truncate text-xs",
							TONE_FIGURE_CLASS[burnRatioTone(burn)],
						)}
					>
						pace {formatBurnRatio(burn)}
					</p>
				)}

				{resolved && (
					<PoolClassBars
						accounts={weekly.accounts}
						leastUsedAccountId={leastUsed?.accountId}
					/>
				)}

				<div className="mt-item space-y-tight">
					{/* "hit 100% before their OWN reset", never "run out". This counts
					    accounts individually against individually-staggered windows; the
					    Quota Runway card sitting beside it on the Overview reports the
					    POOL, which survives every one of these because each account's
					    window refills at its own reset while the others still have room.
					    Worded as "run out", the two cards read as a flat contradiction
					    ("5 of 5 projected to run out" next to "no run-out") with nothing
					    on screen to say they answer different questions.

					    "spent or projected" once any of them is ALREADY at 100%: the
					    count mixes measured exhaustion with forecast, and calling all of
					    it a projection invites the reader to discount capacity that is
					    already gone. */}
					{resolved && willRunOut > 0 && (
						<p className="flex items-center gap-item text-xs text-warning-strong">
							<AlertTriangle className="h-3.5 w-3.5 shrink-0" />
							{willRunOut} of {capacity}{" "}
							{capacity === 1 ? "account" : "accounts"}{" "}
							{spent > 0 ? "spent or projected" : "projected"} to hit 100%
							before {willRunOut === 1 ? "its" : "their"} own reset
						</p>
					)}
					{/* The counterweight to the line above: `willRunOut` excludes an
					    account whose burn is not measured yet, so a class early in its
					    week would otherwise read as one nothing is projected to run out
					    of. Muted, because it is a "wait", not a warning. */}
					{resolved && scoped.learning.length > 0 && (
						<p className="truncate text-xs text-muted-foreground">
							{scoped.learning.length} not yet projectable
						</p>
					)}
					{resolved && weekly.reportingCount < weekly.eligibleTotal && (
						<p className="truncate text-xs text-muted-foreground">
							{weekly.reportingCount} of {weekly.eligibleTotal} accounts
							reporting
						</p>
					)}
					{resolved && weekly.singlePointOfFailure && (
						<p className="flex items-center gap-item text-xs text-warning-strong">
							<AlertTriangle className="h-3.5 w-3.5 shrink-0" />
							{weekly.capacityCount === 1
								? "1 account, no failover"
								: "No account can serve this"}
						</p>
					)}
					{resolved && paceText && (
						<p className="truncate text-xs text-muted-foreground">{paceText}</p>
					)}
					{resolved && checkpoint && (
						<p className="truncate text-xs text-muted-foreground">
							{checkpoint}
						</p>
					)}
					{resolved && family.label != null && (
						<p className={cn("truncate text-xs", family.colorClass)}>
							{family.label}
						</p>
					)}
					{resolved && staleNote && (
						<p className="flex items-center gap-item text-xs text-muted-foreground">
							<Clock className="h-3.5 w-3.5 shrink-0" />
							{staleNote}
						</p>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
