import { extractFiveHour, extractSevenDay } from "@clankermux/core";
import type { AccountResponse } from "@clankermux/types";
import { AlertCircle } from "lucide-react";
import { computeWindowResetExtremes } from "../../lib/usage-windows";
import { providerShowsWeeklyUsage } from "../../utils/provider-utils";
import { AccountStatusChips } from "../accounts/AccountStatusChips";
import { ProviderChip } from "../accounts/ProviderChip";
import { RateLimitProgress } from "../accounts/RateLimitProgress";
import { OAuthTokenStatusWithBoundary } from "../OAuthTokenStatus";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Skeleton } from "../ui/skeleton";

interface AccountUtilizationCardProps {
	accounts: AccountResponse[];
	/** Shared clock from the Limits tab, so countdowns and reset-endpoint
	 *  comparisons advance together. */
	now: number;
	/**
	 * Set while the first `/api/accounts` fetch is in flight and nothing is
	 * cached. Without it an unread list renders the card's empty state, which
	 * claims no account is reporting usage — a measurement the read never made.
	 */
	loading?: boolean;
	/**
	 * Set when that read FAILED with nothing cached. Precedence is
	 * `unavailableReason` -> `loading` -> resolved.
	 */
	unavailableReason?: string;
}

/** Highest of the account's 5h/7d utilization, for sort ordering (no data → -1). */
function maxUtilization(account: AccountResponse): number {
	if (!account.usageData) return -1;
	const five = extractFiveHour(account.usageData)?.pct ?? null;
	const seven = extractSevenDay(account.usageData)?.pct ?? null;
	if (five == null && seven == null) return -1;
	return Math.max(five ?? 0, seven ?? 0);
}

/** Windowed-quota accounts (or rate-limited ones) that RateLimitProgress can render. */
function hasWindowedUsage(account: AccountResponse): boolean {
	return (
		account.usageData != null ||
		account.usageRateLimitedUntil != null ||
		account.rateLimitReset != null
	);
}

/**
 * Per-account utilization for the Limits page: every windowed account shows
 * both its 5-hour and 7-day bars with the expected-pace marker and an inline
 * burn-rate projection (no hover), reusing the Accounts-page RateLimitProgress.
 */
export function AccountUtilizationCard({
	accounts,
	now,
	loading = false,
	unavailableReason,
}: AccountUtilizationCardProps) {
	const pending = loading && unavailableReason == null;
	const rows = accounts
		.filter(hasWindowedUsage)
		.sort((a, b) => maxUtilization(b) - maxUtilization(a));

	// Built from `rows`, not `accounts`: an account filtered out of this card has
	// no countdown here to emphasize, and letting it define either endpoint
	// would leave a visible category incorrectly marked.
	const resetExtremes = computeWindowResetExtremes(
		rows.map((account) => ({
			resetIso: account.rateLimitReset,
			usageUtilization: account.usageUtilization,
			usageWindow: account.usageWindow,
			usageData: account.usageData,
			staleUsage: account.staleUsage,
			usageRateLimitedUntil: account.usageRateLimitedUntil,
			provider: account.provider,
			showWeekly: providerShowsWeeklyUsage(account.provider),
		})),
		now,
	);

	return (
		<Card id="account-utilization" className="scroll-mt-section">
			<CardHeader>
				<CardTitle>Account Utilization</CardTitle>
				<CardDescription>
					Current 5-hour and 7-day quota per account, with reset countdowns and
					a burn-rate projection. The tick marks the expected pace; a bar turns
					amber when it is projected to run out before its reset, and red once
					that projection is well clear of the reset. Green reset times come
					back first; red reset times come back last.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{unavailableReason != null ? (
					<p className="flex items-center gap-item text-sm text-warning-strong">
						<AlertCircle className="h-3.5 w-3.5 shrink-0" />
						{unavailableReason}
					</p>
				) : pending ? (
					<div className="space-y-section">
						{/* Three placeholder rows: enough to say "accounts are coming"
						    without claiming how many there are. */}
						{[0, 1, 2].map((index) => (
							<div key={index} className="space-y-item">
								<Skeleton className="h-4 w-40" />
								<Skeleton className="h-2.5 w-full" />
							</div>
						))}
					</div>
				) : rows.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No windowed accounts reporting usage yet.
					</p>
				) : (
					<div className="space-y-section">
						{rows.map((account) => (
							<div key={account.id} className="space-y-item">
								<div className="flex items-center justify-between gap-item">
									<span
										className="truncate text-sm font-medium"
										title={account.name}
									>
										{account.name}
									</span>
									<ProviderChip
										provider={account.provider}
										className="shrink-0"
									/>
									<OAuthTokenStatusWithBoundary
										accountName={account.name}
										hasRefreshToken={account.hasRefreshToken}
									/>
								</div>
								<AccountStatusChips account={account} />
								<RateLimitProgress
									resetIso={account.rateLimitReset}
									usageUtilization={account.usageUtilization}
									usageWindow={account.usageWindow}
									usageData={account.usageData}
									prediction={account.prediction}
									burnAnchors={account.burnAnchors}
									staleUsage={account.staleUsage}
									usageAsOfIso={account.usageAsOfIso}
									usageRateLimitedUntil={account.usageRateLimitedUntil}
									usageThrottledUntil={account.usageThrottledUntil}
									usageThrottledWindows={account.usageThrottledWindows}
									provider={account.provider}
									showWeekly={providerShowsWeeklyUsage(account.provider)}
									earliestResets={resetExtremes.earliest}
									latestResets={resetExtremes.latest}
									inlineProjection
								/>
							</div>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
