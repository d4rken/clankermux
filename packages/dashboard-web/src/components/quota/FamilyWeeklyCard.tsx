import {
	FAMILY_WEEKLY_ELEVATED_THRESHOLD_PCT,
	type FamilyRow,
	type Outlook,
	type PoolAccountBar,
} from "@clankermux/core";
import { AlertCircle, Clock } from "lucide-react";
import { formatDurationDhm } from "../../lib/format-prediction";
import type { QuotaSummaryRow } from "../../lib/quota-summary";
import { cn } from "../../lib/utils";
import { StatusChip } from "../accounts/StatusChip";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { TONE_CLASSES, TONE_FIGURE_CLASS } from "./outlook-tone";
import { type PoolClassBar, PoolClassBars } from "./PoolClassBars";

interface FamilyWeeklyCardProps {
	rows: FamilyRow[];
	/** Complete configured membership, including historical model windows. */
	summaryRows?: QuotaSummaryRow[];
	now: number;
	/** Set while the first `/api/accounts` read is in flight and nothing is cached. */
	loading?: boolean;
	/** Set when that read FAILED with nothing cached. Wins over `loading`. */
	unavailableReason?: string;
	/** Set when the rows are real but the most recent refresh failed. */
	staleNote?: string;
}

/** The family warning summarizes accounts with elevated or exhausted usage. */
function familyOutlook(row: FamilyRow): Outlook {
	const usage = row.usage;
	if (usage == null) {
		return row.unopenedCount > 0
			? { label: "Unused capacity", tone: "success" }
			: { label: "Unavailable", tone: "neutral" };
	}
	if (usage.exhaustedCount > 0) {
		return {
			label: `Exhausted on ${usage.exhaustedCount} of ${usage.accounts.length + row.unopenedCount}`,
			tone: "destructive",
		};
	}
	if (usage.worstPct >= FAMILY_WEEKLY_ELEVATED_THRESHOLD_PCT) {
		return { label: `At ${Math.floor(usage.worstPct)}%`, tone: "warning" };
	}
	return { label: "On pace", tone: "success" };
}

/** Include untouched accounts as zero use without inventing a reset or forecast. */
function familyBars(row: FamilyRow): PoolAccountBar[] {
	return [
		...row.unavailableAccounts,
		...(row.usage?.accounts ?? []).map((entry) => ({
			accountId: entry.accountId,
			name: entry.name,
			provider: "anthropic",
			pct: entry.pct,
			state: "reporting" as const,
			reason: null,
			resetMs: entry.resetMs,
		})),
		...row.unopenedAccounts.map((account) => ({
			...account,
			pct: 0,
			state: "reporting" as const,
			reason: null,
			resetMs: null,
		})),
	].sort(
		(a, b) =>
			a.name.localeCompare(b.name) || a.accountId.localeCompare(b.accountId),
	);
}

/** Floor remaining quota so rounding never overstates capacity. */
const floorPct = (pct: number): string => `${Math.floor(pct)}%`;

/** Per-model weekly quota, averaged across configured accounts independently of availability. */
export function FamilyWeeklyCard({
	rows,
	summaryRows,
	now,
	loading = false,
	unavailableReason,
	staleNote,
}: FamilyWeeklyCardProps) {
	const displayedRows = summaryRows
		? summaryRows
				.filter((summary) => summary.model !== null)
				.map((summary) => ({
					row: rows.find(
						(row) =>
							summary.provider === "anthropic" && row.family === summary.model,
					),
					summary,
				}))
		: [...rows]
				.sort((a, b) => a.family.localeCompare(b.family))
				.map((row) => ({ row, summary: undefined }));
	const pending = loading && !unavailableReason;
	const resolved = !pending && !unavailableReason;
	// Nothing to disclose and nothing outstanding: a card saying "no model
	// limits" would be a permanent empty frame for every pool without a scoped
	// window, which is most of them.
	if (resolved && displayedRows.length === 0) return null;

	return (
		<Card>
			<CardHeader>
				<CardTitle>Model limits</CardTitle>
				<CardDescription>
					Average weekly quota remaining per model. Includes accounts that are
					paused or temporarily limited.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{unavailableReason ? (
					<p className="flex items-center gap-item text-xs text-warning-strong">
						<AlertCircle className="h-3.5 w-3.5 shrink-0" />
						{unavailableReason}
					</p>
				) : pending ? (
					<div className="space-y-tight">
						<Skeleton className="h-4 w-32" />
						<Skeleton className="h-7 w-40" />
					</div>
				) : (
					<div className="space-y-group">
						{displayedRows.map(({ row, summary }) => {
							const usage = row?.usage;
							const bars: PoolClassBar[] = summary
								? summary.accounts.map((account) => ({
										accountId: account.id,
										name: account.name,
										provider: summary.provider,
										pct:
											account.remainingPct === null
												? null
												: 100 - account.remainingPct,
										state: account.available
											? "reporting"
											: account.unknown
												? "unknown"
												: "exhausted",
										reason: account.available ? null : account.status,
										resetMs: account.resetMs,
									}))
								: row
									? familyBars(row)
									: [];
							const total = bars.length;
							const knownCount = bars.filter((bar) => bar.pct !== null).length;
							const averageRemaining = summary
								? summary.remainingPct
								: total > 0 && knownCount === total
									? bars.reduce((sum, bar) => sum + 100 - (bar.pct ?? 0), 0) /
										total
									: null;
							const unavailableCount = bars.filter(
								(bar) => bar.state !== "reporting",
							).length;
							const outlook: Outlook = summary
								? {
										label: `${summary.availableCount} of ${total} available`,
										tone: summary.availableCount > 0 ? "success" : "neutral",
									}
								: row
									? familyOutlook(row)
									: { label: "Unavailable", tone: "neutral" };
							// Reset evidence is independent of which accounts can serve now.
							const nextReset = summary?.accounts
								.filter(
									(account) =>
										account.resetMs !== null && account.resetMs > now,
								)
								.sort(
									(a, b) => (a.resetMs ?? Infinity) - (b.resetMs ?? Infinity),
								)[0];
							const resetsInMs = summary
								? nextReset?.resetMs
									? nextReset.resetMs - now
									: null
								: usage != null && usage.earliestResetMs > now
									? usage.earliestResetMs - now
									: null;
							const earliestResetAccountName =
								nextReset?.name ??
								usage?.accounts.find((a) => a.resetMs === usage.earliestResetMs)
									?.name ??
								null;
							return (
								<div key={summary?.id ?? row?.family} className="min-w-0">
									<div className="flex items-center justify-between gap-item">
										<p className="truncate text-sm font-medium">
											{summary?.label ?? row?.displayName}
										</p>
										<StatusChip className={TONE_CLASSES[outlook.tone].chip}>
											{outlook.label}
										</StatusChip>
									</div>

									<p
										className={cn(
											"figure-xl",
											TONE_FIGURE_CLASS[
												averageRemaining === null
													? "neutral"
													: averageRemaining <= 0
														? "destructive"
														: averageRemaining <= 20
															? "warning"
															: "success"
											],
										)}
									>
										{averageRemaining === null
											? "—"
											: `${floorPct(averageRemaining)} remaining`}
									</p>
									<p className="truncate text-xs text-muted-foreground">
										{averageRemaining === null
											? `${knownCount} of ${total} quota readings`
											: `average across ${total} account${total === 1 ? "" : "s"}`}
									</p>
									<PoolClassBars
										accounts={bars}
										display="remaining"
										formatPct={floorPct}
									/>
									{total > 0 && (
										<div className="mt-item space-y-tight text-xs text-muted-foreground">
											<p className="truncate">
												{summary
													? `${knownCount} of ${total} quota readings`
													: `${row?.reportingCount ?? 0} of ${total} reporting`}
												{(row?.unopenedCount ?? 0) > 0
													? ` · ${row?.unopenedCount} not used this week`
													: ""}
												{unavailableCount > 0
													? ` · ${unavailableCount} unavailable`
													: ""}
											</p>
											{resetsInMs != null && (
												<p className="truncate">
													resets in {formatDurationDhm(resetsInMs)}
													{earliestResetAccountName
														? ` · ${earliestResetAccountName}`
														: ""}
												</p>
											)}
											{usage != null && usage.atRiskCount > 0 && (
												<p className="truncate text-warning-strong">
													{usage.atRiskCount} projected to hit the cap before
													reset
												</p>
											)}
											{/* The counterweight: an account whose burn is not
												    measured yet is excluded from the count above, so
												    without this a family early in its week reads as one
												    nothing is projected to hit. */}
											{usage != null && usage.learningCount > 0 && (
												<p className="truncate text-muted-foreground">
													{usage.learningCount} not yet projectable
												</p>
											)}
										</div>
									)}
								</div>
							);
						})}
						{staleNote && (
							<p className="flex items-center gap-item text-xs text-muted-foreground">
								<Clock className="h-3.5 w-3.5 shrink-0" />
								{staleNote}
							</p>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
