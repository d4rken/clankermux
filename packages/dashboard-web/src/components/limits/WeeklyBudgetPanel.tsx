import {
	type ClassBudget,
	formatBurnRatio,
	type Outlook,
	type PacingSnapshot,
	type PoolUsageResult,
	scopeResultToClass,
} from "@clankermux/core";
import { AlertCircle, BarChart3 } from "lucide-react";
import { formatDurationDhm } from "../../lib/format-prediction";
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
	/** The served pacing scan. Every figure on this panel except the family line. */
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
 * Everything but the family line comes from the SERVED budget. The family line
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
	budget: ClassBudget,
	waitingOnFiveHour: number,
	now: number,
): string {
	const parts = [
		`${budget.reportingCount} of ${budget.eligibleTotal} reporting`,
	];
	if (waitingOnFiveHour > 0) parts.push(`${waitingOnFiveHour} waiting on 5h`);
	if (budget.alreadySpent > 0) {
		parts.push(`${budget.alreadySpent} weekly spent`);
	}
	if (budget.unknownCount > 0) parts.push(`${budget.unknownCount} unknown`);
	// A reset is stated only when there IS one in the future. "reset not
	// reported" is the honest alternative: the class may well reset, but nothing
	// in the polled state says when, and a missing figure must not be filled in.
	parts.push(
		budget.earliestResetMs == null
			? "reset not reported"
			: `resets in ${formatDurationDhm(budget.earliestResetMs - now)}${
					budget.earliestResetAccountName
						? ` · ${budget.earliestResetAccountName}`
						: ""
				}`,
	);
	return parts.join(" · ");
}

/**
 * The weekly quota as a BUDGET: how much of the week's allowance the freshest
 * account in each servable class has left.
 *
 * This is the number that decides whether work gets done at all. Its counterpart
 * next door — the 5-hour pacing — decides only how fast you may spend it, and
 * the two were rendered as symmetric panels headlined by the same statistic (a
 * pooled average of both), which stated that they are two budgets of the same
 * kind. They are not: resetting or dodging the 5-hour window grants no capacity.
 *
 * The headline names the TIGHTEST class rather than averaging across classes. A
 * Claude request cannot be served by a Codex account, so a figure spanning both
 * describes no decision anyone makes, and the class with the least room is the
 * one that stops you first.
 */
export function WeeklyBudgetPanel({
	pacing,
	sevenDay,
	now,
	loading,
	unavailableReason,
}: WeeklyBudgetPanelProps) {
	const pending = loading && unavailableReason == null;
	const resolved = !pending && unavailableReason == null && pacing != null;
	const classes = pacing?.classes ?? [];
	const binding =
		classes.find((c) => c.classId === pacing?.bindingClassId) ?? null;
	// The verdict LABEL and TONE are served. The thresholds behind them (60%
	// "watch", 80% "high") are policy, and re-deriving them here is how the page
	// and the widget come to disagree about the same pool.
	const outlook: Outlook = !resolved
		? { label: pending ? "Loading" : "Unavailable", tone: "neutral" }
		: binding == null
			? { label: "No reading", tone: "neutral" }
			: { label: binding.outlookLabel, tone: binding.outlookTone };
	const toneClasses = TONE_CLASSES[outlook.tone];
	const bindingBurn = binding == null ? null : classBurn(binding);
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
				) : classes.length === 0 ? (
					<>
						<p className="figure-xl text-muted-foreground">—</p>
						<p className="mt-tight text-xs text-muted-foreground">
							No rolling-quota accounts
						</p>
					</>
				) : binding == null ? (
					<>
						<p className="figure-xl text-muted-foreground">—</p>
						<p className="mt-tight text-xs text-muted-foreground">
							No class reporting weekly usage
						</p>
					</>
				) : (
					<>
						<div className="flex items-baseline justify-between gap-row">
							<p className={cn("figure-xl", toneClasses.figure)}>
								{Math.round(binding.utilizationPct ?? 0)}% used
							</p>
							<p className="text-xs text-muted-foreground">Tightest class</p>
						</div>
						<p className="mt-tight truncate text-xs text-muted-foreground">
							{binding.label} · lowest {binding.leastUsedAccountName}
							{bindingBurn && (
								<>
									{" · "}
									<span className={bindingBurn.tone}>{bindingBurn.text}</span>
								</>
							)}
						</p>
					</>
				)}
			</div>

			{resolved && classes.length > 0 && (
				<ul
					className="mt-group space-y-item"
					aria-label="Weekly budget by class"
				>
					{classes.map((budget) => {
						const badges = classBadges(budget, sevenDay);
						const burn = classBurn(budget);
						return (
							<li key={budget.classId} className="min-w-0 text-xs">
								<p className="truncate">
									<span
										className={cn(
											budget.classId === binding?.classId
												? "font-medium text-foreground"
												: "text-muted-foreground",
										)}
									>
										{budget.label}
									</span>
									<span className="text-muted-foreground">
										{" · "}
										{budget.utilizationPct == null ? (
											"— · no weekly reading"
										) : (
											<>
												<span className="tabular-nums">
													{Math.round(budget.utilizationPct)}% used
												</span>
												{" · lowest "}
												{budget.leastUsedAccountName}
												{/* The pace belongs on THIS line and nowhere else: it
												    is computed over the least-used account named
												    immediately to its left. Below, it sat at the end of
												    the coverage line, whose own trailing name is the
												    class's EARLIEST-resetting account — a different
												    account whenever the two differ, which read as
												    "Claude-1 · 1.2× sustainable pace" while the 1.2×
												    described Claude-4. Same placement the Overview's
												    PoolQuotaCard already uses. */}
												{burn && (
													<>
														{" · "}
														<span className={burn.tone}>{burn.text}</span>
													</>
												)}
											</>
										)}
									</span>
								</p>
								<p className="truncate text-xs text-muted-foreground">
									{coverageLine(budget, waitingFor(budget.classId), now)}
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
