import {
	listLiveScopedFamiliesByClass,
	servableClassFor,
} from "@clankermux/core";
import type { AccountResponse } from "@clankermux/types";
import { AlertCircle } from "lucide-react";
import { useMemo, useState } from "react";
import {
	ACCOUNT_UTILIZATION_SORT_LABELS,
	ACCOUNT_UTILIZATION_SORT_MODES,
	ACCOUNT_UTILIZATION_SORT_STORAGE_KEY,
	type AccountUtilizationSortMode,
	accountToUsageCardSource,
	DEFAULT_ACCOUNT_UTILIZATION_SORT_MODE,
	parseAccountUtilizationSortMode,
	sortAccountsByUtilization,
} from "../../lib/account-utilization-sort";
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
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
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

/**
 * Windowed-quota accounts (or rate-limited ones) that RateLimitProgress can render.
 *
 * `staleUsage` counts: an account whose live usage read failed still carries a
 * persisted snapshot, which `classifyUsageCard` classifies as `stale` and
 * RateLimitProgress renders as a "last known as of HH:MM" row. Leaving it out
 * of this predicate made the filter and the renderer disagree, and the filter
 * was the one that was wrong.
 */
function hasWindowedUsage(account: AccountResponse): boolean {
	return (
		account.usageData != null ||
		account.staleUsage != null ||
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
	// Row order, persisted so the choice survives reloads. localStorage can throw
	// (e.g. Safari private mode) — degrade to the in-memory default.
	const [sortMode, setSortMode] = useState<AccountUtilizationSortMode>(() => {
		if (typeof window === "undefined")
			return DEFAULT_ACCOUNT_UTILIZATION_SORT_MODE;
		try {
			return parseAccountUtilizationSortMode(
				window.localStorage.getItem(ACCOUNT_UTILIZATION_SORT_STORAGE_KEY),
			);
		} catch {
			return DEFAULT_ACCOUNT_UTILIZATION_SORT_MODE;
		}
	});

	const handleSortModeChange = (value: string) => {
		const mode = parseAccountUtilizationSortMode(value);
		setSortMode(mode);
		try {
			window.localStorage.setItem(ACCOUNT_UTILIZATION_SORT_STORAGE_KEY, mode);
		} catch {
			// ignore — degrade to in-memory
		}
	};

	const pending = loading && unavailableReason == null;
	const rows = sortAccountsByUtilization(
		accounts.filter(hasWindowedUsage),
		sortMode,
		now,
	);

	// Built from `rows`, not `accounts`: an account filtered out of this card has
	// no countdown here to emphasize, and letting it define either endpoint
	// would leave a visible category incorrectly marked.
	const resetExtremes = computeWindowResetExtremes(
		rows.map(accountToUsageCardSource),
		now,
	);

	// Which model families each servable class currently reports, from UNPAUSED
	// accounts only — the same set the server's family scan builds its class gate
	// from, so both surfaces call the same accounts untouched. Built from every
	// account rather than from `rows`: an account filtered out of this card can
	// still be the one proving the family exists for the class.
	const familiesByClass = useMemo(
		() =>
			listLiveScopedFamiliesByClass(
				accounts.filter((account) => account.paused !== true),
				now,
			),
		[accounts, now],
	);

	// A sort control over an error message, a skeleton, the empty state or a
	// single row is a dead affordance.
	const showSortControl =
		unavailableReason == null && !pending && rows.length > 1;

	return (
		<Card id="account-utilization" className="scroll-mt-section">
			<CardHeader>
				{/* A CONTAINER query, not a viewport one: this card is full-width on
				    the Limits page today but sits in a grid elsewhere, and viewport
				    width says nothing about the room this header actually has. Keyed
				    on `sm:` the same mistake in SettingRow switched a two-track layout
				    on at 640px while the row still had ~340px, overflowing its
				    control. The threshold here is `@xl` (576px): at a 448px container
				    (`@md`) the "Sort by" label plus the 190px trigger forms a roughly
				    237px cluster, leaving the five-sentence description about 203px.
				    That wraps without overlap or truncation, but stays cramped until
				    roughly 576px, so the header stays stacked until then. */}
				<div className="@container">
					<div className="flex flex-col gap-item @xl:flex-row @xl:items-start @xl:justify-between">
						<div className="min-w-0">
							<CardTitle>Account Utilization</CardTitle>
							<CardDescription>
								Current 5-hour and 7-day quota per account, with reset
								countdowns and a burn-rate projection. The tick marks the
								expected pace; a bar turns amber when it is projected to run out
								before its reset, and red once that projection is well clear of
								the reset. Green reset times come back first; red reset times
								come back last.
							</CardDescription>
						</div>
						{showSortControl && (
							<div className="flex items-center gap-item @xl:shrink-0">
								<Label
									htmlFor="account-utilization-sort"
									className="text-xs text-muted-foreground whitespace-nowrap"
								>
									Sort by
								</Label>
								<Select value={sortMode} onValueChange={handleSortModeChange}>
									<SelectTrigger
										id="account-utilization-sort"
										className="h-9 w-full @xl:w-[190px]"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{ACCOUNT_UTILIZATION_SORT_MODES.map((mode) => (
											<SelectItem key={mode} value={mode}>
												{ACCOUNT_UTILIZATION_SORT_LABELS[mode]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						)}
					</div>
				</div>
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
									poolScopedFamilies={
										familiesByClass.get(
											servableClassFor(account.provider).classId,
										) ?? []
									}
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
