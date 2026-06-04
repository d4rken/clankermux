import type { AccountResponse } from "@clankermux/types";
import { AlertCircle } from "lucide-react";
import {
	type AccountStatus,
	deriveAccountStatus,
} from "../../lib/account-status";
import { OAuthTokenStatusWithBoundary } from "../OAuthTokenStatus";
import { RateLimitStatusChip } from "./RateLimitStatusChip";

interface AccountStatusChipsProps {
	account: AccountResponse;
	/** Pre-derived status; falls back to deriving from `account` when omitted. */
	status?: AccountStatus;
}

/**
 * The per-account status chip row shared by the Accounts page (`AccountListItem`)
 * and the Limits page (`AccountUtilizationCard`): Primary / priority / OAuth
 * token health, the rate-limit state, stale-lock and usage-throttle warnings,
 * the provider-overload cooldown and the peak / off-peak window. All flags come
 * from `deriveAccountStatus` so both pages stay in sync. Action buttons (e.g.
 * Force Reset) and request/session stats are intentionally left to the host.
 */
export function AccountStatusChips({
	account,
	status: providedStatus,
}: AccountStatusChipsProps) {
	const status = providedStatus ?? deriveAccountStatus(account);

	return (
		<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
			{status.isPrimary && (
				<span className="px-2 py-0.5 text-xs font-medium bg-primary text-primary-foreground rounded-full">
					Primary
				</span>
			)}
			<span className="px-2 py-0.5 text-xs font-medium bg-secondary text-secondary-foreground rounded-full">
				Priority: {status.priority}
			</span>
			<OAuthTokenStatusWithBoundary
				accountName={account.name}
				hasRefreshToken={account.hasRefreshToken}
			/>
			{status.isRateLimited && (
				<span title="Account is rate-limited - requests will be rejected until the limit resets">
					<AlertCircle className="h-4 w-4 text-yellow-600" />
				</span>
			)}
			{status.isPaused && <span className="text-muted-foreground">Paused</span>}
			{status.showRateLimitChip && (
				<RateLimitStatusChip status={status.rateLimitStatus} />
			)}
			{status.staleLockDetected && (
				<span
					className="text-amber-600"
					title="Stale lock detected: usage data shows available capacity but account is still rate-limited"
				>
					Stale lock detected
				</span>
			)}
			{status.isUsageThrottled && (
				<span
					className="text-amber-600"
					title="Usage throttling is delaying requests for this account until pacing catches up"
				>
					Usage throttled
				</span>
			)}
			{status.providerOverloadedUntil && (
				<span
					className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
					title={`Provider overload cooldown active until ${new Date(
						status.providerOverloadedUntil,
					).toLocaleString()}`}
				>
					<AlertCircle className="h-3.5 w-3.5" />
					Provider overloaded ({status.providerOverloadMinutes}m)
				</span>
			)}
			{status.showPeakChip && (
				<span
					className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ${
						status.isPeak
							? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
							: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
					}`}
				>
					<span
						className={`h-1.5 w-1.5 rounded-full ${status.isPeak ? "bg-orange-500" : "bg-green-500"}`}
					/>
					{status.peakChipLabel}
				</span>
			)}
		</div>
	);
}
