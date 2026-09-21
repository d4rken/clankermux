import { RefreshCw } from "lucide-react";
import type { Account } from "../../api";
import { Button } from "../ui/button";

export function AccountAccessNotice({
	account,
	isChecking,
	onRecheck,
}: {
	account: Account;
	isChecking: boolean;
	onRecheck: () => void;
}) {
	if (
		account.provider !== "anthropic" ||
		!account.paused ||
		(account.pauseReason !== "subscription_expired" &&
			account.pauseReason !== "usage_permission_denied")
	) {
		return null;
	}
	const expired = account.pauseReason === "subscription_expired";
	// The recheck reads the same usage endpoint the poller does, so while its
	// retry-after is outstanding there is nothing a click can achieve.
	const rateLimitedUntil =
		account.usageRateLimitedUntil != null &&
		account.usageRateLimitedUntil > Date.now()
			? account.usageRateLimitedUntil
			: null;
	const checkedAt = account.identitySubscriptionCheckedAt;
	const fetchedAt = account.identityProfileFetchedAt;
	const checkUnconfirmed =
		checkedAt != null && (fetchedAt == null || checkedAt > fetchedAt);

	return (
		<div className="rounded-md bg-destructive/10 p-row text-sm space-y-item">
			<p className="font-medium text-destructive-strong">
				{expired ? "Subscription expired · Paused" : "Access denied · Paused"}
			</p>
			<p>
				{expired
					? "Subscription access has ended. Renew your subscription to restore access."
					: "Anthropic denied access to usage data; the cause is unconfirmed. Check subscription access and organization permissions."}{" "}
				The account stays out of rotation until usage access returns.
			</p>
			{checkedAt != null && (
				<p className="text-xs text-muted-foreground">
					Last check attempted:{" "}
					<time dateTime={new Date(checkedAt).toISOString()}>
						{new Date(checkedAt).toLocaleString()}
					</time>
				</p>
			)}
			{checkUnconfirmed && (
				<p className="text-xs text-muted-foreground">
					Latest subscription check has not completed successfully.
					{fetchedAt != null && (
						<>
							{" "}
							Last successful check:{" "}
							<time dateTime={new Date(fetchedAt).toISOString()}>
								{new Date(fetchedAt).toLocaleString()}
							</time>
						</>
					)}
				</p>
			)}
			{rateLimitedUntil != null && (
				<p className="text-xs text-warning-strong">
					Usage endpoint rate limited — retry after{" "}
					{new Date(rateLimitedUntil).toLocaleTimeString(undefined, {
						hour: "2-digit",
						minute: "2-digit",
						hour12: false,
					})}
				</p>
			)}
			<Button
				variant="outline"
				size="sm"
				onClick={onRecheck}
				disabled={isChecking || rateLimitedUntil != null}
			>
				<RefreshCw
					className={`h-3.5 w-3.5 ${isChecking ? "animate-spin" : ""}`}
				/>
				{isChecking ? "Checking access…" : "Recheck access"}
			</Button>
		</div>
	);
}
