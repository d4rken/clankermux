import type { AccountResponse } from "@clankermux/types";
import { extractFiveHour, extractSevenDay } from "../../lib/pool-usage";
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

interface AccountUtilizationCardProps {
	accounts: AccountResponse[];
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
}: AccountUtilizationCardProps) {
	const rows = accounts
		.filter(hasWindowedUsage)
		.sort((a, b) => maxUtilization(b) - maxUtilization(a));

	return (
		<Card>
			<CardHeader>
				<CardTitle>Account Utilization</CardTitle>
				<CardDescription>
					Current 5-hour and 7-day quota per account, with reset countdowns and
					a burn-rate projection. The tick marks the expected pace.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{rows.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No windowed accounts reporting usage yet.
					</p>
				) : (
					<div className="space-y-5">
						{rows.map((account) => (
							<div key={account.id} className="space-y-2">
								<div className="flex items-center justify-between gap-2">
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
									staleUsage={account.staleUsage}
									usageRateLimitedUntil={account.usageRateLimitedUntil}
									usageThrottledUntil={account.usageThrottledUntil}
									usageThrottledWindows={account.usageThrottledWindows}
									provider={account.provider}
									showWeekly={providerShowsWeeklyUsage(account.provider)}
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
