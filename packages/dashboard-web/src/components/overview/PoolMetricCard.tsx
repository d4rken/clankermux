import { formatPercentage } from "@clankermux/ui-common";
import { AlertCircle, Clock, Info } from "lucide-react";
import {
	type ExcludedReason,
	FAMILY_WEEKLY_ELEVATED_THRESHOLD_PCT,
	type FamilyWeeklyAccountUsage,
	type FamilyWeeklyUsage,
	type PoolUsageResult,
	type PoolWindow,
} from "../../lib/pool-usage";
import { cn } from "../../lib/utils";
import { Card, CardContent } from "../ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Skeleton } from "../ui/skeleton";

interface PoolMetricCardProps {
	title: string;
	icon: React.ComponentType<{ className?: string }>;
	result: PoolUsageResult;
	window: PoolWindow;
	inlineDetails?: boolean;
	/**
	 * Set while the first `/api/accounts` fetch is in flight and nothing is
	 * cached.
	 *
	 * Required rather than inferable from `result`: `computePoolUsage([], …)`
	 * returns an all-empty result that is indistinguishable from "no accounts
	 * contribute to this pool" — a claim this card must not make about accounts
	 * it has not read yet.
	 */
	loading?: boolean;
	/**
	 * Set when that read FAILED with nothing cached. Same reasoning as `loading`:
	 * an empty pool would read as measured capacity of zero.
	 *
	 * Precedence is `unavailableReason` → `loading` → resolved.
	 */
	unavailableReason?: string;
	/**
	 * Set when the pool is real but the most recent `/api/accounts` refresh
	 * failed. The quota numbers, the next-quota line and the badges still render;
	 * the card says how old they are.
	 */
	staleNote?: string;
}

const REASON_LABELS: Record<ExcludedReason, string> = {
	paused: "Paused",
	rate_limited: "Rate-limited",
	token_expired: "OAuth token expired",
	usage_rate_limited: "Usage data unavailable (provider 429)",
	five_hour_exhausted: "5h quota exhausted",
	seven_day_exhausted: "7d quota exhausted",
	no_usage_data: "No usage data yet",
};

const REASON_ORDER: ExcludedReason[] = [
	"paused",
	"rate_limited",
	"token_expired",
	"usage_rate_limited",
	"five_hour_exhausted",
	"seven_day_exhausted",
	"no_usage_data",
];

function headlineColor(average: number | null): string | undefined {
	if (average == null) return undefined;
	if (average < 60) return "text-success-strong";
	if (average < 80) return "text-warning-strong";
	return "text-destructive-strong";
}

function groupExcluded(
	excluded: PoolUsageResult["excluded"],
): Array<{ reason: ExcludedReason; items: PoolUsageResult["excluded"] }> {
	const map = new Map<ExcludedReason, PoolUsageResult["excluded"]>();
	for (const entry of excluded) {
		const bucket = map.get(entry.reason);
		if (bucket) {
			bucket.push(entry);
		} else {
			map.set(entry.reason, [entry]);
		}
	}
	const groups: Array<{
		reason: ExcludedReason;
		items: PoolUsageResult["excluded"];
	}> = [];
	for (const reason of REASON_ORDER) {
		const items = map.get(reason);
		if (items && items.length > 0) {
			groups.push({ reason, items });
		}
	}
	return groups;
}

function nextQuotaTimeLabel(
	earliestResetMs: number,
	window: PoolWindow,
): string {
	const date = new Date(earliestResetMs);
	return window === "seven_day"
		? date.toLocaleString(undefined, {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			})
		: date.toLocaleTimeString(undefined, {
				hour: "2-digit",
				minute: "2-digit",
			});
}

function nextQuotaLabel(
	earliestResetMs: number,
	accountName: string | null,
	window: PoolWindow,
): string {
	const name = accountName ?? "unknown";
	return `${name} at ${nextQuotaTimeLabel(earliestResetMs, window)}`;
}

function formatShortDuration(ms: number): string {
	const totalMinutes = Math.max(0, Math.round(ms / 60000));
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

function atRiskBadge(
	willRunOutCount: number,
	capacityCount: number,
): { label: string | null; colorClass: string | null } {
	if (willRunOutCount === 0 || capacityCount === 0) {
		return { label: null, colorClass: null };
	}
	const colorClass =
		willRunOutCount >= capacityCount
			? "text-destructive-strong"
			: "text-warning-strong";
	return {
		label: `${willRunOutCount} of ${capacityCount} will run out`,
		colorClass,
	};
}

/**
 * Percent for display. Floors rather than rounds: every threshold here (100
 * exhausted, {@link FAMILY_WEEKLY_ELEVATED_THRESHOLD_PCT} elevated) is tested on
 * the raw value, and `toFixed(0)` rounds 99.6 up to a "100%" the logic did not
 * treat as exhausted — a label claiming a threshold no count agrees with.
 * Flooring makes the shown number cross a threshold exactly when the raw one
 * does. Percents are fractional in the wire payload, so this is reachable.
 */
function displayPct(pct: number): string {
	return `${Math.floor(pct)}%`;
}

/**
 * One-line summary of the per-family weekly limits for the 7d tile.
 *
 * `worstPct` is the single most-spent account, NOT a pool aggregate, so every
 * label states the scope it covers: one account at 100% out of six with
 * headroom must not read as "the pool is out of Fable". The denominator is the
 * accounts that actually report that family's window (already filtered to ones
 * the tile counts as available); the numerator is how many of them crossed the
 * line being reported.
 */
export function familyWeeklyBadge(familyWeekly: FamilyWeeklyUsage[]): {
	label: string | null;
	colorClass: string | null;
} {
	const elevated = familyWeekly.filter((f) => f.elevated);
	if (elevated.length === 0) return { label: null, colorClass: null };
	const anyExhausted = elevated.some((f) => f.worstPct >= 100);
	const colorClass = anyExhausted
		? "text-destructive-strong"
		: "text-warning-strong";
	if (elevated.length === 1) {
		const f = elevated[0];
		const total = f.accounts.length;
		const noun = total === 1 ? "account" : "accounts";
		// Report the count for the condition actually named: exhausted accounts
		// for "exhausted", merely-elevated ones for the percentage form.
		const label =
			f.worstPct >= 100
				? `${f.label} weekly exhausted on ${f.exhaustedCount} of ${total} ${noun}`
				: `${f.label} weekly at ${displayPct(f.worstPct)} on ${f.elevatedCount} of ${total} ${noun}`;
		return { label, colorClass };
	}
	// Several families elevated: no room for per-account scope on one line, so
	// scope against the tracked families instead. The unit word is spelled out
	// so this count can't be read as an account count.
	return {
		label: `${elevated.length} of ${familyWeekly.length} model limits elevated`,
		colorClass,
	};
}

/**
 * Meta line for a family in the popover: who the `max` figure above covers, and
 * when that same set recovers.
 *
 * The reset is scoped to the accounts the prefix names, NOT the family-wide
 * earliest. "1 of 6 exhausted · resets Tue" alongside a Tuesday belonging to a
 * healthy account would read as the exhausted account recovering Tuesday, which
 * is a claim nothing here checked.
 */
export function familyScopeSummary(f: FamilyWeeklyUsage): {
	prefix: string;
	resetMs: number;
} {
	const total = f.accounts.length;
	const earliestOf = (rows: FamilyWeeklyAccountUsage[]) =>
		Math.min(...rows.map((a) => a.resetMs));

	if (total === 1) {
		return { prefix: `${f.worstAccountName} · `, resetMs: f.earliestResetMs };
	}
	if (f.exhaustedCount > 0) {
		return {
			prefix: `${f.exhaustedCount} of ${total} exhausted · `,
			resetMs: earliestOf(f.accounts.filter((a) => a.pct >= 100)),
		};
	}
	if (f.elevatedCount > 0) {
		return {
			prefix: `${f.elevatedCount} of ${total} elevated · `,
			resetMs: earliestOf(
				f.accounts.filter((a) => a.pct >= FAMILY_WEEKLY_ELEVATED_THRESHOLD_PCT),
			),
		};
	}
	return { prefix: `${total} accounts · `, resetMs: f.earliestResetMs };
}

function PoolDetailSection({
	result,
	window,
}: {
	result: PoolUsageResult;
	window: PoolWindow;
}) {
	const {
		activeAverage,
		contributing,
		exhausted,
		excluded,
		fallback,
		earliestResetMs,
		earliestResetAccountName,
		atRisk,
		familyWeekly,
	} = result;

	const sortedContributing = contributing.slice().sort((a, b) => b.pct - a.pct);
	const sortedAtRisk = atRisk
		.slice()
		.sort((a, b) => a.exhaustsAtMs - b.exhaustsAtMs);
	const exhaustedGroups = groupExcluded(exhausted);
	const excludedGroups = groupExcluded(excluded);

	const hasContributing = contributing.length > 0;
	const hasExhausted = exhausted.length > 0;
	const hasExcluded = excluded.length > 0;
	const hasFallback = fallback.length > 0;
	const hasAtRisk = atRisk.length > 0;

	return (
		<div className="space-y-row">
			<div>
				<div className="font-medium mb-1">Pool usage</div>
				<div className="text-muted-foreground">
					Headline counts unavailable eligible accounts as 100% used.
				</div>
				{activeAverage != null && (
					<div className="mt-1">
						Active accounts average: {activeAverage.toFixed(0)}%
					</div>
				)}
			</div>
			{hasContributing && (
				<div>
					<div className="font-medium mb-1">
						Contributing ({contributing.length})
					</div>
					<ul className="space-y-tight">
						{sortedContributing.map((c) => (
							<li
								key={c.name}
								className="flex items-center justify-between gap-item"
							>
								<span className="truncate" title={c.name}>
									{c.name}
								</span>
								<span className="tabular-nums">{c.pct.toFixed(0)}%</span>
							</li>
						))}
					</ul>
				</div>
			)}
			{familyWeekly.length > 0 && (
				<div>
					<div className="font-medium mb-1">
						Model limits ({familyWeekly.length})
					</div>
					<div className="text-muted-foreground mb-1">
						Per-model weekly quota — can throttle one model while the pool looks
						healthy.
					</div>
					<ul className="space-y-tight">
						{familyWeekly.map((f) => {
							const scope = familyScopeSummary(f);
							return (
								<li key={f.family}>
									<div className="flex items-center justify-between gap-item">
										<span className="truncate" title={f.label}>
											{f.label}
										</span>
										<span
											className={cn(
												"tabular-nums",
												f.worstPct >= 100
													? "text-destructive-strong"
													: f.elevated
														? "text-warning-strong"
														: undefined,
											)}
											title={
												f.accounts.length > 1
													? `Highest single account (${f.worstAccountName})`
													: undefined
											}
										>
											{f.accounts.length > 1 && "max "}
											{displayPct(f.worstPct)}
										</span>
									</div>
									<div className="text-muted-foreground">
										{scope.prefix}
										resets {nextQuotaTimeLabel(scope.resetMs, "seven_day")}
									</div>
									{f.accounts.length > 1 && (
										<ul className="ml-2 space-y-tight">
											{f.accounts.map((a) => (
												<li
													key={a.name}
													className="flex items-center justify-between gap-item"
												>
													<span className="truncate" title={a.name}>
														{a.name}
													</span>
													<span className="tabular-nums">
														{displayPct(a.pct)}
													</span>
												</li>
											))}
										</ul>
									)}
								</li>
							);
						})}
					</ul>
				</div>
			)}
			{hasAtRisk && (
				<div>
					<div className="font-medium mb-1">At risk ({atRisk.length})</div>
					<div className="text-muted-foreground mb-1">
						Projected to exhaust before their window resets.
					</div>
					<ul className="space-y-tight">
						{sortedAtRisk.map((a) => (
							<li
								key={a.name}
								className="flex items-center justify-between gap-item"
							>
								<span className="truncate" title={a.name}>
									{a.name}
								</span>
								<span className="tabular-nums">
									runs out in {formatShortDuration(a.timeToExhaustMs)}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
			{hasExhausted && (
				<div>
					<div className="font-medium mb-1">
						Unavailable ({exhausted.length})
					</div>
					<div className="space-y-item">
						{exhaustedGroups.map(({ reason, items }) => (
							<div key={reason}>
								<div className="text-muted-foreground">
									{REASON_LABELS[reason]} · counted as 100%
								</div>
								<ul className="ml-2 space-y-tight">
									{items.map((e) => (
										<li key={e.name} className="truncate" title={e.name}>
											{e.name}
										</li>
									))}
								</ul>
							</div>
						))}
					</div>
				</div>
			)}
			{hasExcluded && (
				<div>
					<div className="font-medium mb-1">Unknown ({excluded.length})</div>
					<div className="space-y-item">
						{excludedGroups.map(({ reason, items }) => (
							<div key={reason}>
								<div className="text-muted-foreground">
									{REASON_LABELS[reason]} · not counted
								</div>
								<ul className="ml-2 space-y-tight">
									{items.map((e) => (
										<li key={e.name} className="truncate" title={e.name}>
											{e.name}
										</li>
									))}
								</ul>
							</div>
						))}
					</div>
				</div>
			)}
			{hasFallback && (
				<div>
					<div className="font-medium mb-1">Fallback ({fallback.length})</div>
					<div className="text-muted-foreground mb-1">
						Pay-as-you-go capacity, not counted in this pool.
					</div>
					<ul className="space-y-tight">
						{fallback.map((f) => (
							<li
								key={f.name}
								className="truncate"
								title={`${f.name} (${f.provider})`}
							>
								{f.name}{" "}
								<span className="text-muted-foreground">({f.provider})</span>
							</li>
						))}
					</ul>
				</div>
			)}
			{earliestResetMs != null && (
				<div>
					<div className="font-medium mb-1">More quota</div>
					<div>
						{nextQuotaLabel(earliestResetMs, earliestResetAccountName, window)}
					</div>
				</div>
			)}
		</div>
	);
}

export function PoolMetricCard({
	title,
	icon: Icon,
	result,
	window,
	inlineDetails = false,
	loading = false,
	unavailableReason,
	staleNote,
}: PoolMetricCardProps) {
	const {
		average,
		contributing,
		exhausted,
		excluded,
		earliestResetMs,
		atRisk,
		familyWeekly,
	} = result;

	const eligibleTotal =
		contributing.length + exhausted.length + excluded.length;
	const capacityCount = contributing.length + exhausted.length;
	const willRunOutCount = atRisk.length + exhausted.length;
	const { label: willRunOutText, colorClass: willRunOutColor } = atRiskBadge(
		willRunOutCount,
		capacityCount,
	);
	const { label: familyWeeklyText, colorClass: familyWeeklyColor } =
		familyWeeklyBadge(familyWeekly);
	// See the prop docs: an unread account list must not be rendered as a
	// measured pool, and a failed read wins over a pending one.
	const pending = loading && !unavailableReason;
	const resolved = !pending && !unavailableReason;
	const showChip = resolved && eligibleTotal > 0;
	const colorClass = headlineColor(average);
	const headline = average != null ? formatPercentage(average, 0) : "—";
	const nextQuotaText =
		!resolved || earliestResetMs == null
			? null
			: `more quota at ${nextQuotaTimeLabel(earliestResetMs, window)}`;

	const triggerNode = showChip ? (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="flex items-center gap-tight shrink-0 text-xs text-muted-foreground cursor-help focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
				>
					<span className="tabular-nums">
						({contributing.length}/{eligibleTotal} active)
					</span>
					<Info className="h-3 w-3" />
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-72 text-xs space-y-row">
				<PoolDetailSection result={result} window={window} />
			</PopoverContent>
		</Popover>
	) : null;

	return (
		<Card>
			<CardContent>
				<div className="flex items-center justify-between gap-item mb-1.5">
					<div className="flex items-center gap-item min-w-0">
						<Icon className="h-4 w-4 shrink-0 text-muted-foreground/40" />
						<p className="text-sm text-muted-foreground truncate">{title}</p>
					</div>
					{inlineDetails ? (
						showChip ? (
							<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
								({contributing.length}/{eligibleTotal} active)
							</span>
						) : null
					) : (
						triggerNode
					)}
				</div>
				<div className="space-y-tight">
					{unavailableReason ? (
						<>
							<p className="figure-xl text-muted-foreground/60">—</p>
							<p className="flex items-center gap-item text-xs text-warning-strong">
								<AlertCircle className="h-3.5 w-3.5 shrink-0" />
								{unavailableReason}
							</p>
						</>
					) : pending ? (
						// Same line box as the resolved headline (.figure-xl is a fixed
						// 1.75rem = h-7), so the tile keeps its height when the accounts
						// land.
						<Skeleton className="h-7 w-20" />
					) : (
						<p className={cn("figure-xl", colorClass)}>{headline}</p>
					)}
					<p className="text-xs text-muted-foreground truncate">
						capacity used
					</p>
					{resolved && staleNote && (
						<p className="flex items-center gap-item text-xs text-muted-foreground">
							<Clock className="h-3.5 w-3.5 shrink-0" />
							{staleNote}
						</p>
					)}
					{nextQuotaText && (
						<p className="text-xs text-muted-foreground truncate">
							{nextQuotaText}
						</p>
					)}
					{resolved && willRunOutText && (
						<p className={cn("text-xs truncate", willRunOutColor)}>
							{willRunOutText}
						</p>
					)}
					{resolved && familyWeeklyText && (
						<p className={cn("text-xs truncate", familyWeeklyColor)}>
							{familyWeeklyText}
						</p>
					)}
				</div>
				{inlineDetails && showChip && (
					<div className="mt-3 pt-3 border-t border-border/50 text-xs">
						<PoolDetailSection result={result} window={window} />
					</div>
				)}
			</CardContent>
		</Card>
	);
}
