import {
	type ExcludedReason,
	FAMILY_WEEKLY_ELEVATED_THRESHOLD_PCT,
	type FamilyWeeklyAccountUsage,
	type FamilyWeeklyUsage,
	type PoolUsageResult,
	type PoolWindow,
} from "@clankermux/core";
import { cn } from "../../lib/utils";

/**
 * The full per-account breakdown behind a pool figure, and the badge/label
 * helpers that go with it.
 *
 * This lives in `quota/` rather than `overview/` because BOTH pages render it:
 * the Overview inside its card's popover, the Usage page inside a `<details>`
 * disclosure. While it sat inside the Overview's own tile component, the Usage
 * page reached across into an `overview/` module to get it — an import that
 * made the sharing invisible and invited the two pages to drift apart around
 * it, which is exactly what happened to the outlook and at-risk rules that used
 * to live beside it.
 *
 * Everything here is presentation over an already-computed `PoolUsageResult`.
 * The rules about what those numbers MEAN — the outlook verdict, the eligible
 * total, the at-risk numerator — belong to `core/pool-usage.ts`, so that no
 * caller can render a different verdict by reimplementing one locally.
 */
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

export function windowTimeLabel(
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

export function checkpointLabel(
	earliestResetMs: number,
	accountName: string | null,
	window: PoolWindow,
): string {
	const name = accountName ?? "unknown";
	return `${name} at ${windowTimeLabel(earliestResetMs, window)}`;
}

function formatShortDuration(ms: number): string {
	const totalMinutes = Math.max(0, Math.round(ms / 60000));
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

export function atRiskBadge(
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

export function PoolDetailSection({
	result,
	window,
}: {
	result: PoolUsageResult;
	window: PoolWindow;
}) {
	const {
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
			{hasContributing && (
				<div>
					<div className="font-medium mb-tight">
						Reporting ({contributing.length})
					</div>
					<ul className="space-y-tight">
						{sortedContributing.map((c) => (
							<li
								key={c.accountId}
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
					<div className="font-medium mb-tight">
						Model limits ({familyWeekly.length})
					</div>
					<div className="text-muted-foreground mb-tight">
						Per-model weekly quota — can throttle one model while the
						account-wide weekly still has room.
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
										resets {windowTimeLabel(scope.resetMs, "seven_day")}
									</div>
									{/*
									 * Deliberately muted, never a warning/destructive tone: this
									 * projection is always the lifetime-average branch of the
									 * shared estimator (no per-family regression exists), and the
									 * tile's rule is that a low-confidence projection does not
									 * drive alarm colour.
									 *
									 * `data-tone` states that as a contract a test can hold
									 * without pinning the class that implements it: the rule is
									 * "this line is neutral", and asserting only that the line
									 * renders would pass again the day a tint comes back.
									 *
									 * "hit the cap", matching FamilyWeeklyCard, never "run out":
									 * this is a PER-FAMILY cap, and an account that reaches it
									 * still has account-wide weekly quota left for every other
									 * family. "Run out" claims the account is finished, which is
									 * the exact confusion this section exists to prevent.
									 */}
									{f.soonestExhaustsAtMs !== null && (
										<div data-tone="neutral" className="text-muted-foreground">
											{f.accounts.length > 1
												? `${f.atRiskCount} of ${f.accounts.length} projected to hit the cap · first `
												: "projected to hit the cap "}
											{windowTimeLabel(f.soonestExhaustsAtMs, "seven_day")}
										</div>
									)}
									{f.accounts.length > 1 && (
										<ul className="ml-item space-y-tight">
											{f.accounts.map((a) => (
												<li
													key={a.accountId}
													className="flex items-center justify-between gap-item"
												>
													<span className="truncate" title={a.name}>
														{a.name}
													</span>
													<span className="tabular-nums whitespace-nowrap">
														{a.exhaustsAtMs !== null && (
															<span className="text-muted-foreground">
																out{" "}
																{windowTimeLabel(a.exhaustsAtMs, "seven_day")} ·{" "}
															</span>
														)}
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
					<div className="font-medium mb-tight">At risk ({atRisk.length})</div>
					<div className="text-muted-foreground mb-tight">
						Projected to exhaust before their window resets.
					</div>
					<ul className="space-y-tight">
						{sortedAtRisk.map((a) => (
							<li
								key={a.accountId}
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
					<div className="font-medium mb-tight">
						Unavailable ({exhausted.length})
					</div>
					<div className="space-y-item">
						{exhaustedGroups.map(({ reason, items }) => (
							<div key={reason}>
								<div className="text-muted-foreground">
									{REASON_LABELS[reason]} · counted as 100%
								</div>
								<ul className="ml-item space-y-tight">
									{items.map((e) => (
										<li key={e.accountId} className="truncate" title={e.name}>
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
					<div className="font-medium mb-tight">
						Unknown ({excluded.length})
					</div>
					<div className="space-y-item">
						{excludedGroups.map(({ reason, items }) => (
							<div key={reason}>
								<div className="text-muted-foreground">
									{REASON_LABELS[reason]} · not counted
								</div>
								<ul className="ml-item space-y-tight">
									{items.map((e) => (
										<li key={e.accountId} className="truncate" title={e.name}>
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
					<div className="font-medium mb-tight">
						Outside this window ({fallback.length})
					</div>
					<div className="text-muted-foreground mb-tight">
						Accounts outside this rolling window; they do not take part in this
						class's figures.
					</div>
					<ul className="space-y-tight">
						{fallback.map((f) => (
							<li
								key={f.accountId}
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
					<div className="font-medium mb-tight">Next checkpoint</div>
					<div>
						{checkpointLabel(earliestResetMs, earliestResetAccountName, window)}
					</div>
				</div>
			)}
		</div>
	);
}
