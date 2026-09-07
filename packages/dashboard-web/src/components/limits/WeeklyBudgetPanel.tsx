import {
	type ClassBudget,
	formatBurnRatio,
	type PacingSnapshot,
	type PoolUsageResult,
	scopeResultToClass,
	servableClassFor,
} from "@clankermux/core";
import { AlertCircle, BarChart3 } from "lucide-react";
import { formatDurationDhm } from "../../lib/format-prediction";
import type { QuotaSummaryRow } from "../../lib/quota-summary";
import { cn } from "../../lib/utils";
import { StatusChip } from "../accounts/StatusChip";
import { TONE_CLASSES, TONE_FIGURE_CLASS } from "../quota/outlook-tone";
import { familyWeeklyBadge } from "../quota/PoolDetailSection";
import { Skeleton } from "../ui/skeleton";

/**
 * The pace line for a class, rendered from the SERVED burn ratio.
 *
 * Formatting only — the ratio, the tone thresholds and the decision to withhold
 * a ratio at all now come from the server, so the page and the desk widget
 * cannot call the same pace sustainable and unsustainable.
 */
function classBurn(budget: ClassBudget) {
	if (budget.burn == null || budget.burnTone == null) return null;
	return {
		text: formatBurnRatio(budget.burn),
		tone: TONE_FIGURE_CLASS[budget.burnTone],
	};
}

interface WeeklyBudgetPanelProps {
	/** Served pacing and forecast details; remaining percentages come from summaryRows. */
	pacing: PacingSnapshot | undefined;
	/**
	 * The locally-computed weekly pool, for the per-model-family line ALONE.
	 *
	 * A family cap is a different quota fact from a pace — an account at its
	 * Fable cap still has account-wide weekly quota for every other family — and
	 * it is not on the pacing wire. The Overview's Model limits card derives it
	 * the same way from the same accounts.
	 */
	sevenDay: PoolUsageResult;
	/** Weekly averages across all configured accounts, independent of availability. */
	summaryRows?: QuotaSummaryRow[];
	now: number;
	/**
	 * Set while the first pacing read is in flight and nothing is cached.
	 * Required rather than inferred: an empty `classes` array is what a pool with
	 * no rolling-quota accounts also looks like.
	 */
	loading: boolean;
	/** Set when that read FAILED with nothing cached. Wins over `loading`. */
	unavailableReason?: string;
}

/**
 * The per-class badges, in one place so the row and its states cannot drift.
 *
 * Forecast badges come from the SERVED budget. The family line
 * is still derived here, from the local pool, because a per-model-family cap is
 * not a pace and is not on the pacing wire — an account at its Fable cap still
 * has account-wide weekly quota for every other family, and the Overview's
 * Model limits card derives it the same way from the same accounts.
 */
function classBadges(
	budget: ClassBudget,
	sevenDay: PoolUsageResult,
): Array<{ label: string; colorClass: string }> {
	const badges: Array<{ label: string; colorClass: string }> = [];
	if (budget.singlePointOfFailure) {
		badges.push({
			label:
				budget.willRunOutCapacity === 1
					? "1 account, no failover"
					: "No account can serve this",
			colorClass: "text-warning-strong",
		});
	}
	const willRunOut = budget.willRunOut;
	const capacity = budget.willRunOutCapacity;
	const spent = budget.alreadySpent;
	if (willRunOut > 0) {
		badges.push({
			// "hit 100% before their OWN reset", never "run out": this counts
			// accounts individually, against individually-staggered windows, and
			// the runway panel one column over reports the POOL — which survives
			// every one of these, because each account's window refills at its own
			// reset while the others still have room. Worded as "run out" the two
			// read as a flat contradiction, and the reader has no way to tell that
			// they are answering different questions.
			//
			// "spent or projected" once any of them is ALREADY at 100%: the count
			// mixes measured exhaustion with forecast, and calling the whole of it a
			// projection invites the reader to discount capacity that is already
			// gone.
			label: `${willRunOut} of ${capacity} ${
				capacity === 1 ? "account" : "accounts"
			} ${spent > 0 ? "spent or projected" : "projected"} to hit 100% before ${
				willRunOut === 1 ? "its" : "their"
			} own reset`,
			colorClass: "text-warning-strong",
		});
	}
	if (budget.learning > 0) {
		// The counterweight to the badge above: `willRunOut` excludes accounts
		// whose burn is not measured yet, so without this a class early in its
		// week reads as one nothing is projected to run out of.
		badges.push({
			label: `${budget.learning} ${
				budget.learning === 1 ? "account" : "accounts"
			} not yet projectable`,
			colorClass: "text-muted-foreground",
		});
	}
	const pool = sevenDay.classes.find((c) => c.classId === budget.classId);
	const family =
		pool == null
			? { label: null, colorClass: undefined }
			: familyWeeklyBadge(scopeResultToClass(sevenDay, pool).familyWeekly);
	if (family.label != null) {
		badges.push({
			label: family.label,
			colorClass: family.colorClass ?? "text-warning-strong",
		});
	}
	return badges;
}

/**
 * The second line of a class row: who is reporting, who is not, and when it
 * resets.
 *
 * `waiting on 5h` comes from the served 5-hour rollup rather than being counted
 * a second time here, so this line cannot disagree with the panel next door
 * that is about exactly that number.
 */
function coverageLine(
	budget: ClassBudget | undefined,
	row: QuotaSummaryRow,
	waitingOnFiveHour: number,
	now: number,
): string {
	const parts = [
		`${row.knownCount} of ${row.accounts.length} reporting`,
		`${row.availableCount} of ${row.accounts.length} available`,
	];
	if (waitingOnFiveHour > 0) parts.push(`${waitingOnFiveHour} waiting on 5h`);
	if (row.unknownCount > 0) parts.push(`${row.unknownCount} unknown`);
	if (!budget) return parts.join(" · ");
	if (budget.alreadySpent > 0) {
		parts.push(`${budget.alreadySpent} weekly spent`);
	}
	// A reset is stated only when there IS one in the future. "reset not
	// reported" is the honest alternative: the class may well reset, but nothing
	// in the polled state says when, and a missing figure must not be filled in.
	//
	// An UNSTARTED window is a third case between the two: the provider does
	// report a reset, but it is `now + 7d` re-stamped on every poll and slides
	// forward until the first request pins it. It is excluded from
	// `earliestResetMs` upstream, so saying only "reset not reported" here would
	// describe a window nobody has touched as an unread one.
	if (budget.earliestResetMs == null) {
		parts.push(
			budget.unstartedCount > 0
				? "not started; resets 7d after first use"
				: "reset not reported",
		);
	} else {
		if (budget.unstartedCount > 0) {
			parts.push(`${budget.unstartedCount} not started`);
		}
		parts.push(
			`resets in ${formatDurationDhm(budget.earliestResetMs - now)}${
				budget.earliestResetAccountName
					? ` · ${budget.earliestResetAccountName}`
					: ""
			}`,
		);
	}
	return parts.join(" · ");
}

/** Weekly remaining quota per provider, with availability and served pacing kept separate. */
export function WeeklyBudgetPanel({
	pacing,
	sevenDay,
	summaryRows = [],
	now,
	loading,
	unavailableReason,
}: WeeklyBudgetPanelProps) {
	const pending = loading && unavailableReason == null;
	const resolved = !pending && unavailableReason == null && pacing != null;
	const classes = pacing?.classes ?? [];
	const providers = summaryRows.filter(
		(row) => row.model === null && row.metered,
	);
	// Keep the original limiting-provider headline, using its account average.
	// An incomplete provider takes precedence so missing data cannot look healthy.
	const headline = [...providers].sort(
		(a, b) => (a.remainingPct ?? -1) - (b.remainingPct ?? -1),
	)[0];
	const outlook = {
		label: !resolved
			? pending
				? "Loading"
				: "Unavailable"
			: providers.length === 0
				? "No reading"
				: providers.some((row) => row.remainingPct === null)
					? "Incomplete"
					: "Reported",
		tone: "neutral" as const,
	};
	const toneClasses = TONE_CLASSES[outlook.tone];
	/** The served 5-hour waiting count for one class, for the coverage line. */
	const waitingFor = (classId: string): number =>
		pacing?.fiveHour.classes.find((c) => c.classId === classId)?.waiting ?? 0;

	return (
		<section
			className="flex min-w-0 flex-col p-group"
			aria-label="Weekly budget"
		>
			<div className="flex items-center justify-between gap-row">
				<div className="flex min-w-0 items-center gap-item">
					<BarChart3 className="h-4 w-4 shrink-0 text-muted-foreground" />
					<h4 className="truncate text-sm font-medium">Weekly budget</h4>
				</div>
				<StatusChip className={toneClasses.chip}>{outlook.label}</StatusChip>
			</div>

			<div className="mt-group">
				{unavailableReason != null ? (
					<>
						<p className="figure-xl text-muted-foreground">—</p>
						<p className="mt-tight flex items-center gap-item text-xs text-warning-strong">
							<AlertCircle className="h-3.5 w-3.5 shrink-0" />
							{unavailableReason}
						</p>
					</>
				) : pending ? (
					<>
						{/* Same line box as the resolved headline (.figure-xl is a fixed
						    1.75rem = h-7), so the panel keeps its height when the accounts
						    land. */}
						<Skeleton className="h-7 w-20" />
						<p className="mt-tight text-xs text-muted-foreground">
							Reading accounts
						</p>
					</>
				) : providers.length === 0 ? (
					<>
						<p className="figure-xl text-muted-foreground">—</p>
						<p className="mt-tight text-xs text-muted-foreground">
							No rolling-quota accounts
						</p>
					</>
				) : (
					<>
						<div className="flex items-baseline justify-between gap-row">
							<p
								className={cn("figure-xl", toneClasses.figure)}
								title="Lowest provider average; each provider is listed below."
							>
								{headline?.remainingPct == null
									? "—"
									: `${Math.round(headline.remainingPct)}% remaining`}
							</p>
							<p className="text-xs text-muted-foreground">{headline?.label}</p>
						</div>
						<p className="mt-tight truncate text-xs text-muted-foreground">
							Average per account within each provider
						</p>
					</>
				)}
			</div>

			{resolved && providers.length > 0 && (
				<ul
					className="mt-group space-y-item"
					aria-label="Weekly budget by provider"
				>
					{providers.map((row) => {
						const classId = servableClassFor(row.provider).classId;
						const budget = classes.find((entry) => entry.classId === classId);
						const badges = budget ? classBadges(budget, sevenDay) : [];
						const burn = budget ? classBurn(budget) : null;
						return (
							<li key={row.id} className="min-w-0 text-xs">
								<p className="truncate">
									<span className="font-medium text-foreground">
										{row.label}
									</span>
									<span className="text-muted-foreground">
										{" · "}
										{row.remainingPct == null ? (
											"— · incomplete weekly readings"
										) : (
											<>
												<span className="tabular-nums">
													{Math.round(row.remainingPct)}% remaining
												</span>
												{" · average per account"}
												{burn && (
													<>
														{" · "}
														<span className={burn.tone}>
															{budget?.leastUsedAccountName}: {burn.text}
														</span>
													</>
												)}
											</>
										)}
									</span>
								</p>
								<p className="truncate text-xs text-muted-foreground">
									{coverageLine(budget, row, waitingFor(classId), now)}
								</p>
								{badges.map((badge) => (
									<p
										key={badge.label}
										className={cn("truncate text-xs", badge.colorClass)}
									>
										{badge.label}
									</p>
								))}
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
