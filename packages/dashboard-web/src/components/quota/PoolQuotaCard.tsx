import { AlertCircle, AlertTriangle, Clock, Info } from "lucide-react";
import {
	type PoolUsageResult,
	poolOutlook,
	type ServableClassPool,
} from "../../lib/pool-usage";
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
	loading = false,
	unavailableReason,
	staleNote,
}: PoolQuotaCardProps) {
	const pending = loading && !unavailableReason;
	const resolved = !pending && !unavailableReason;
	const leastUsed = weekly.leastUsed;
	// A class with no reporting account has no headroom to state. The explicit
	// dash is required: rendering 100% left for a pool nobody has read would be
	// the most dangerous possible failure of this card.
	const headroom = leastUsed == null ? null : Math.max(0, 100 - leastUsed.pct);
	const tone = TONE_FIGURE_CLASS[poolOutlook(weeklyResult).tone];
	const family = familyWeeklyBadge(weeklyResult.familyWeekly);

	const fiveHourLeast = fiveHour?.leastUsed ?? null;
	const paceText =
		fiveHourLeast == null
			? null
			: `5h pace: ${Math.round(fiveHourLeast.pct)}% used on ${fiveHourLeast.name}`;

	const checkpoint =
		weekly.earliestResetMs == null
			? null
			: `resets ${windowTimeLabel(weekly.earliestResetMs, "seven_day")}${
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
								<PoolDetailSection result={weeklyResult} window="seven_day" />
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
				) : headroom == null ? (
					<>
						<p className="figure-xl text-muted-foreground/60">—</p>
						<p className="text-xs text-muted-foreground">
							No account reporting weekly usage
						</p>
					</>
				) : (
					<>
						<p className={cn("figure-xl", tone)}>
							{Math.round(headroom)}% left
						</p>
						<p className="truncate text-xs text-muted-foreground">
							on {leastUsed?.name}
						</p>
					</>
				)}

				{resolved && (
					<PoolClassBars
						accounts={weekly.accounts}
						leastUsedAccountId={leastUsed?.accountId}
					/>
				)}

				<div className="mt-item space-y-tight">
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
