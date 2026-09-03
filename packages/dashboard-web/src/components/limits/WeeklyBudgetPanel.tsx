import { AlertCircle, BarChart3 } from "lucide-react";
import { formatDurationDhm } from "../../lib/format-prediction";
import {
	type Outlook,
	type PoolUsageResult,
	poolClassOutlook,
	type ServableClassPool,
	scopeResultToClass,
	willRunOutCount,
} from "../../lib/pool-usage";
import { cn } from "../../lib/utils";
import { StatusChip } from "../accounts/StatusChip";
import { TONE_CLASSES } from "../quota/outlook-tone";
import { familyWeeklyBadge } from "../quota/PoolDetailSection";
import { Skeleton } from "../ui/skeleton";

interface WeeklyBudgetPanelProps {
	sevenDay: PoolUsageResult;
	now: number;
	/**
	 * Set while the first `/api/accounts` read is in flight and nothing is
	 * cached. Required rather than inferred: `computePoolUsage([], …)` returns an
	 * all-empty result that reads as a measured empty pool.
	 */
	loading: boolean;
	/** Set when that read FAILED with nothing cached. Wins over `loading`. */
	unavailableReason?: string;
}

/** The per-class badges, in one place so the row and its states cannot drift. */
function classBadges(
	sevenDay: PoolUsageResult,
	pool: ServableClassPool,
): Array<{ label: string; colorClass: string }> {
	const badges: Array<{ label: string; colorClass: string }> = [];
	if (pool.singlePointOfFailure) {
		badges.push({
			label:
				pool.capacityCount === 1
					? "1 account, no failover"
					: "No account can serve this",
			colorClass: "text-warning-strong",
		});
	}
	const scoped = scopeResultToClass(sevenDay, pool);
	const { willRunOut, capacity } = willRunOutCount(scoped, "seven_day");
	if (willRunOut > 0) {
		badges.push({
			label: `${willRunOut} of ${capacity} projected to run out before reset`,
			colorClass: "text-warning-strong",
		});
	}
	const family = familyWeeklyBadge(scoped.familyWeekly);
	if (family.label != null) {
		badges.push({
			label: family.label,
			colorClass: family.colorClass ?? "text-warning-strong",
		});
	}
	return badges;
}

/** The second line of a class row: who is reporting, who is not, and when it lifts. */
function coverageLine(pool: ServableClassPool, now: number): string {
	const waiting = pool.accounts.filter(
		(a) => a.reason === "five_hour_exhausted",
	).length;
	const weeklySpent = pool.accounts.filter(
		(a) => a.reason === "seven_day_exhausted",
	).length;
	const unknown = pool.eligibleTotal - pool.capacityCount;

	const parts = [`${pool.reportingCount} of ${pool.eligibleTotal} reporting`];
	if (waiting > 0) parts.push(`${waiting} waiting on 5h`);
	if (weeklySpent > 0) parts.push(`${weeklySpent} weekly spent`);
	if (unknown > 0) parts.push(`${unknown} unknown`);
	// A reset is stated only when there IS one in the future. "reset not
	// reported" is the honest alternative: the class may well reset, but nothing
	// in the polled state says when, and a missing figure must not be filled in.
	parts.push(
		pool.earliestResetMs == null
			? "reset not reported"
			: `resets in ${formatDurationDhm(pool.earliestResetMs - now)}${
					pool.earliestResetAccountName
						? ` · ${pool.earliestResetAccountName}`
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
	sevenDay,
	now,
	loading,
	unavailableReason,
}: WeeklyBudgetPanelProps) {
	const pending = loading && unavailableReason == null;
	const resolved = !pending && unavailableReason == null;
	const binding = sevenDay.bindingClass;
	const outlook: Outlook = !resolved
		? { label: pending ? "Loading" : "Unavailable", tone: "neutral" }
		: binding == null
			? { label: "No reading", tone: "neutral" }
			: poolClassOutlook(binding);
	const toneClasses = TONE_CLASSES[outlook.tone];

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
				) : sevenDay.classes.length === 0 ? (
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
								{Math.round(binding.leastUsed?.pct ?? 0)}% used
							</p>
							<p className="text-xs text-muted-foreground">Tightest class</p>
						</div>
						<p className="mt-tight truncate text-xs text-muted-foreground">
							{binding.label} · lowest {binding.leastUsed?.name}
						</p>
					</>
				)}
			</div>

			{resolved && sevenDay.classes.length > 0 && (
				<ul
					className="mt-group space-y-item"
					aria-label="Weekly budget by class"
				>
					{sevenDay.classes.map((pool) => {
						const badges = classBadges(sevenDay, pool);
						return (
							<li key={pool.classId} className="min-w-0 text-xs">
								<p className="truncate">
									<span
										className={cn(
											pool.classId === binding?.classId
												? "font-medium text-foreground"
												: "text-muted-foreground",
										)}
									>
										{pool.label}
									</span>
									<span className="text-muted-foreground">
										{" · "}
										{pool.leastUsed == null ? (
											"— · no weekly reading"
										) : (
											<>
												<span className="tabular-nums">
													{Math.round(pool.leastUsed.pct)}% used
												</span>
												{" · lowest "}
												{pool.leastUsed.name}
											</>
										)}
									</span>
								</p>
								<p className="truncate text-xs text-muted-foreground">
									{coverageLine(pool, now)}
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
