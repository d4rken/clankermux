import {
	burnRatioTone,
	computeBurnRatio,
	formatBurnRatio,
	type PoolUsageResult,
	type ServableClassPool,
	scopeResultToClass,
	willRunOutCount,
} from "@clankermux/core";
import { AlertCircle, AlertTriangle, Clock, Info } from "lucide-react";
import type { QuotaSummaryRow } from "../../lib/quota-summary";
import { cn } from "../../lib/utils";
import { Card, CardContent } from "../ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Skeleton } from "../ui/skeleton";
import { TONE_FIGURE_CLASS } from "./outlook-tone";
import { type PoolClassBar, PoolClassBars } from "./PoolClassBars";
import {
	familyWeeklyBadge,
	PoolDetailSection,
	windowTimeLabel,
} from "./PoolDetailSection";

interface PoolQuotaCardProps {
	/** The weekly pool for ONE servable class. The budget. */
	weekly: ServableClassPool;
	/** All configured provider accounts, independent of temporary availability. */
	summary?: QuotaSummaryRow;
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

/** The original provider card, showing average quota remaining across its accounts. */
export function PoolQuotaCard({
	weekly,
	summary,
	fiveHour,
	weeklyResult,
	now,
	loading = false,
	unavailableReason,
	staleNote,
}: PoolQuotaCardProps) {
	const pending = loading && !unavailableReason;
	const resolved = !pending && !unavailableReason;
	const bars: PoolClassBar[] = summary
		? summary.accounts.map((account) => ({
				accountId: account.id,
				name: account.name,
				provider: summary.provider,
				pct: account.remainingPct == null ? null : 100 - account.remainingPct,
				state: account.available
					? "reporting"
					: account.unknown
						? "unknown"
						: "exhausted",
				reason: account.available ? null : account.status,
				resetMs: account.resetMs,
			}))
		: [...weekly.accounts].sort(
				(a, b) =>
					a.name.localeCompare(b.name) ||
					a.accountId.localeCompare(b.accountId),
			);
	const average = (values: Array<number | null>) =>
		values.length > 0 && values.every((value) => value !== null)
			? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) /
				values.length
			: null;
	const remainingPct = summary
		? summary.remainingPct
		: average(bars.map((bar) => (bar.pct === null ? null : 100 - bar.pct)));
	const tone =
		TONE_FIGURE_CLASS[
			remainingPct === null
				? "neutral"
				: remainingPct <= 10
					? "destructive"
					: remainingPct <= 30
						? "warning"
						: "success"
		];
	const reportingCount =
		summary?.knownCount ?? bars.filter((bar) => bar.pct !== null).length;
	const availableCount =
		summary?.availableCount ??
		bars.filter((bar) => bar.state === "reporting").length;
	const total = bars.length;
	// Scoped to THIS class. Handed the pool-wide result, every card rendered
	// every account: a Codex card announced that a Claude model family was
	// exhausted, and a one-account card's popover listed six.
	const scoped = scopeResultToClass(weeklyResult, weekly);
	const family = familyWeeklyBadge(scoped.familyWeekly);
	// Scoped to the class as well: the pool-wide count would state, on a
	// one-account card, how many accounts across every class will run out.
	const { willRunOut, capacity, spent } = willRunOutCount(scoped, "seven_day");

	const fiveHourRemaining = average(
		summary
			? summary.accounts.map((account) => account.fiveHourRemainingPct)
			: (fiveHour?.accounts ?? []).map((bar) =>
					bar.pct === null ? null : 100 - bar.pct,
				),
	);
	const paceText =
		fiveHourRemaining == null
			? null
			: `5h: ${Math.round(fiveHourRemaining)}% remaining · account average`;
	// Compare each account against its own weekly window before averaging pace.
	const burns = bars.map((bar) =>
		bar.pct === null
			? null
			: computeBurnRatio(bar.pct, bar.resetMs, "seven_day", now),
	);
	const burnRatio = average(burns.map((burn) => burn?.ratio ?? null));
	const burn = burnRatio == null ? null : { ratio: burnRatio, expectedPct: 0 };

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
					{resolved && total > 0 && (
						<Popover>
							<PopoverTrigger asChild>
								<button
									type="button"
									className="flex shrink-0 items-center gap-tight rounded text-xs text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									<span className="tabular-nums">
										({availableCount}/{total} available)
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
				) : remainingPct == null ? (
					<>
						<p className="figure-xl text-muted-foreground/60">—</p>
						<p className="text-xs text-muted-foreground">
							{reportingCount > 0
								? "Weekly quota incomplete"
								: "No account reporting weekly usage"}
						</p>
					</>
				) : (
					<>
						<p className={cn("figure-xl", tone)}>
							{Math.round(remainingPct)}% remaining
						</p>
						<p
							className="truncate text-xs text-muted-foreground"
							title="Equal average across all configured accounts, including paused or temporarily limited accounts. Quota capacities may differ between plans."
						>
							Weekly · account average
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
						Average pace {formatBurnRatio(burn)}
					</p>
				)}

				{resolved && <PoolClassBars accounts={bars} display="remaining" />}

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
					{resolved && reportingCount < total && (
						<p className="truncate text-xs text-muted-foreground">
							{reportingCount} of {total} accounts reporting
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
