import { AlertCircle, Clock } from "lucide-react";
import { formatDurationDhm } from "../../lib/format-prediction";
import {
	FAMILY_WEEKLY_ELEVATED_THRESHOLD_PCT,
	type FamilyRow,
	type FamilyWeeklyAccountUsage,
	type FamilyWeeklyUsage,
	type Outlook,
	type PoolAccountBar,
} from "../../lib/pool-usage";
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
import { PoolClassBars } from "./PoolClassBars";

interface FamilyWeeklyCardProps {
	rows: FamilyRow[];
	now: number;
	/** Set while the first `/api/accounts` read is in flight and nothing is cached. */
	loading?: boolean;
	/** Set when that read FAILED with nothing cached. Wins over `loading`. */
	unavailableReason?: string;
	/** Set when the rows are real but the most recent refresh failed. */
	staleNote?: string;
}

/** The verdict for ONE family, keyed on the account driving its figure. */
function familyOutlook(row: FamilyRow): Outlook {
	const usage = row.usage;
	if (usage == null) return { label: "No reading", tone: "neutral" };
	if (usage.exhaustedCount > 0) {
		return {
			label: `Exhausted on ${usage.exhaustedCount} of ${usage.accounts.length}`,
			tone: "destructive",
		};
	}
	if (usage.worstPct >= FAMILY_WEEKLY_ELEVATED_THRESHOLD_PCT) {
		return { label: `At ${Math.floor(usage.worstPct)}%`, tone: "warning" };
	}
	return { label: "On pace", tone: "success" };
}

/**
 * The account with the most room left in this family.
 *
 * `usage.accounts` is non-empty whenever `usage` exists — a family bucket is
 * only created by an account reporting a window for it — which is the same
 * assumption `worstPct` already rests on.
 */
function leastUsedAccount(usage: FamilyWeeklyUsage): FamilyWeeklyAccountUsage {
	return usage.accounts.reduce((least, entry) =>
		entry.pct < least.pct ? entry : least,
	);
}

/**
 * The family's accounts as distribution bars, ordered from most headroom to
 * least, so the account the headline names is the first row.
 *
 * `provider: "anthropic"` because only Anthropic-style payloads carry scoped
 * family windows at all — the bars use it for nothing but the servable-class
 * lookup, which no caller here performs. `state: "reporting"` for the same
 * reason: `computeFamilyWeeklyUsage` has already dropped every account that
 * could not report, so what remains is a reading by construction.
 */
function familyBars(row: FamilyRow): PoolAccountBar[] {
	return (row.usage?.accounts ?? [])
		.map((entry) => ({
			accountId: entry.accountId,
			name: entry.name,
			provider: "anthropic",
			pct: entry.pct,
			state: "reporting" as const,
			reason: null,
			resetMs: entry.resetMs,
		}))
		.sort((a, b) => a.pct - b.pct);
}

/**
 * The card's own wording for a reading: FLOORED, never rounded.
 *
 * The chip already floors (`At 80%`) and switches at a hard 80, so a rounded
 * headline printed "80% used" directly above an "On pace" chip for the same
 * 79.6. One quantisation for every figure on the card.
 */
const floorPct = (pct: number): string => `${Math.floor(pct)}%`;

/**
 * Per-model weekly caps, one block per family.
 *
 * A model family's weekly quota is INDEPENDENT of the account-wide weekly
 * window, so Fable can be spent while the account-wide figure the quota cards
 * show still reads healthy. Every other surface reduced that to a one-line badge
 * ("Fable weekly at 92% on 1 of 3 accounts"), which states the worst account and
 * hides the distribution — the thing that decides whether a sibling can still
 * take the request.
 *
 * THE HEADLINE IS THE LEAST-USED ACCOUNT, as on the servable-class cards.
 * Routing picks ONE account, so what decides whether the next request for this
 * family goes through is whether ANY account still has room for it; headlining
 * the worst one announced a problem the pool could already route around, and
 * put the two Overview quota surfaces in different frames for the same
 * question. The chip is the other end deliberately: `Exhausted on 1 of 3` /
 * `At 92%` count who is spent, which is what the headline no longer says.
 *
 * Codex's synthetic per-model weekly windows are not here; see
 * {@link listFamilyRows} for why, and the Accounts tab for where they are.
 */
export function FamilyWeeklyCard({
	rows,
	now,
	loading = false,
	unavailableReason,
	staleNote,
}: FamilyWeeklyCardProps) {
	const pending = loading && !unavailableReason;
	const resolved = !pending && !unavailableReason;
	// Nothing to disclose and nothing outstanding: a card saying "no model
	// limits" would be a permanent empty frame for every pool without a scoped
	// window, which is most of them.
	if (resolved && rows.length === 0) return null;

	return (
		<Card>
			<CardHeader>
				<CardTitle>Model limits</CardTitle>
				<CardDescription>
					Per-model weekly caps. A model can be spent while the account-wide
					weekly still has room.
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
						{rows.map((row) => {
							const usage = row.usage;
							const least = usage == null ? null : leastUsedAccount(usage);
							const outlook = familyOutlook(row);
							const total = row.reportingCount + row.unavailableReporters;
							// Only a FUTURE reset is offered. `earliestResetMs` is the
							// soonest across the family's accounts, so the name beside it
							// has to be that account's — not `worstAccountName`, which is
							// the account driving the percentage above and need not be the
							// same one.
							const resetsInMs =
								usage != null && usage.earliestResetMs > now
									? usage.earliestResetMs - now
									: null;
							const earliestResetAccountName =
								usage?.accounts.find((a) => a.resetMs === usage.earliestResetMs)
									?.name ?? null;
							return (
								<div key={row.family} className="min-w-0">
									<div className="flex items-center justify-between gap-item">
										<p className="truncate text-sm font-medium">
											{row.displayName}
										</p>
										<StatusChip className={TONE_CLASSES[outlook.tone].chip}>
											{outlook.label}
										</StatusChip>
									</div>

									{usage == null || least == null ? (
										// The family exists — a live account reports the window —
										// but every account that has it is unavailable. Saying
										// nothing would read as "no such limit".
										<p className="mt-tight text-xs text-muted-foreground">
											Reported only by {row.unavailableReporters}{" "}
											{row.unavailableReporters === 1 ? "account" : "accounts"}{" "}
											that cannot serve right now
										</p>
									) : (
										<>
											<p
												className={cn(
													"figure-xl",
													TONE_FIGURE_CLASS[outlook.tone],
												)}
											>
												{floorPct(least.pct)} used
											</p>
											<p className="truncate text-xs text-muted-foreground">
												lowest · {least.name}
											</p>
											<PoolClassBars
												accounts={familyBars(row)}
												leastUsedAccountId={least.accountId}
												formatPct={floorPct}
											/>
											<div className="mt-item space-y-tight text-xs text-muted-foreground">
												<p className="truncate">
													{row.reportingCount} of {total} reporting
													{row.unavailableReporters > 0
														? ` · ${row.unavailableReporters} unavailable`
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
												{usage.atRiskCount > 0 && (
													<p className="truncate text-warning-strong">
														{usage.atRiskCount} projected to hit the cap before
														reset
													</p>
												)}
											</div>
										</>
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
