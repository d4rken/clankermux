import type { AccountResponse } from "@clankermux/types";
import {
	HARD_RATE_LIMIT_CAUSES,
	NON_LIMITED_RATE_LIMIT_CAUSES,
} from "@clankermux/types";
import { AlertCircle } from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";

interface RateLimitInfoProps {
	accounts: AccountResponse[];
	/** Injectable clock (tests). */
	now?: number;
}

/** Is this account limited right now? Prefers the API's structured cause. */
function isLimited(account: AccountResponse): boolean {
	if (account.rateLimitCause) {
		return !NON_LIMITED_RATE_LIMIT_CAUSES.has(account.rateLimitCause);
	}
	const status = account.rateLimitStatus.toLowerCase();
	return (
		status !== "ok" && status !== "paused" && !status.startsWith("allowed")
	);
}

/** Blocked account-wide (red) vs merely warning/queueing (amber). */
function isHardLimited(account: AccountResponse): boolean {
	if (account.rateLimitCause) {
		return HARD_RATE_LIMIT_CAUSES.has(account.rateLimitCause);
	}
	const status = account.rateLimitStatus.toLowerCase();
	return (
		status.includes("hard") ||
		(status.includes("limit") && !status.includes("warning"))
	);
}

export function RateLimitInfo({
	accounts,
	now = Date.now(),
}: RateLimitInfoProps) {
	// Paused accounts are excluded: they are out of rotation for an unrelated
	// reason and their stored rate-limit state is frozen, not live.
	const rateLimitedAccounts = accounts.filter(
		(acc) => !acc.paused && isLimited(acc),
	);

	if (rateLimitedAccounts.length === 0) {
		return null;
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Rate Limit Info</CardTitle>
				<CardDescription>Rate limit information about accounts</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-3">
					{rateLimitedAccounts.map((account) => {
						// The cause's own reset is authoritative — `rateLimitReset` is the
						// raw provider header and can disagree with the countdown baked
						// into the status string (e.g. when weekly exhaustion outranks a
						// shorter cooldown lock).
						const resetMs =
							account.rateLimitCauseResetMs ??
							(account.rateLimitReset
								? new Date(account.rateLimitReset).getTime()
								: null);
						const resetTime = resetMs !== null ? new Date(resetMs) : null;
						const minutesLeft =
							resetMs !== null && resetMs > now
								? Math.ceil((resetMs - now) / 60000)
								: null;

						const hardLimited = isHardLimited(account);
						const bgClass = hardLimited ? "bg-destructive/10" : "bg-warning/10";
						const iconColor = hardLimited ? "text-destructive" : "text-warning";

						return (
							<div
								key={account.id}
								className={`flex items-center justify-between p-4 rounded-lg ${bgClass}`}
							>
								<div className="flex items-center gap-3">
									<AlertCircle className={`h-5 w-5 ${iconColor}`} />
									<div>
										<p className="font-medium">{account.name}</p>
										<p className="text-sm text-muted-foreground">
											{account.rateLimitStatus}
											{account.rateLimitRemaining !== null &&
												` • ${account.rateLimitRemaining} requests remaining`}
										</p>
									</div>
								</div>
								<div className="text-right">
									{resetTime && (
										<>
											<p className="text-sm font-medium">
												Resets in {minutesLeft ?? 0}m
											</p>
											<p className="text-xs text-muted-foreground">
												{resetTime.toLocaleTimeString(undefined, {
													hour: "2-digit",
													minute: "2-digit",
													second: "2-digit",
												})}{" "}
												(local)
											</p>
										</>
									)}
								</div>
							</div>
						);
					})}
				</div>
			</CardContent>
		</Card>
	);
}
