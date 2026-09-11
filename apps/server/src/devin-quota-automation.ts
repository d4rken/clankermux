import type { Account, DevinUsageData } from "@clankermux/types";

export type DevinQuotaAction = "pause" | "resume" | null;

/** Calendar quotas are evidence only while their reported reset is still current. */
function hasIncludedCapacity(usage: DevinUsageData, now: number): boolean {
	const windows = [usage.daily, usage.weekly].filter(
		(window) => window != null,
	);
	if (
		windows.some(
			(window) =>
				!Number.isFinite(window.utilization) ||
				window.utilization < 0 ||
				window.utilization >= 100 ||
				(window.resetAt !== null &&
					(!Number.isFinite(window.resetAt) || window.resetAt <= now)),
		)
	)
		return false;
	return (
		windows.length > 0 ||
		(typeof usage.includedCreditsRemaining === "number" &&
			Number.isFinite(usage.includedCreditsRemaining) &&
			usage.includedCreditsRemaining > 0)
	);
}

/** Opt-in covers BOTH proactive pause and recovery; existing defaults remain unchanged. */
export function decideDevinQuotaAction(
	account: Account,
	usage: DevinUsageData,
	now = Date.now(),
): DevinQuotaAction {
	if (
		account.provider !== "devin" ||
		!account.auto_fallback_enabled ||
		usage.canUseCli === false
	)
		return null;
	if (
		account.paused &&
		account.pause_reason !== "overage" &&
		account.pause_reason !== "rate_limit_window"
	)
		return null;
	if (!hasIncludedCapacity(usage, now))
		return !account.paused && account.auto_pause_on_overage_enabled !== false
			? "pause"
			: null;
	if (
		account.paused &&
		!(account.rate_limited_until != null && account.rate_limited_until >= now)
	)
		return "resume";
	return null;
}

/** Compare credentials and operator controls again atomically at the metadata write. */
export async function applyDevinQuotaAutomation(
	db: { run(sql: string, params?: unknown[]): Promise<void> },
	account: Account,
	usage: DevinUsageData,
	isCurrent: () => boolean,
	now = Date.now(),
): Promise<void> {
	const action = decideDevinQuotaAction(account, usage, now);
	if (!action || !account.api_key || !isCurrent()) return;
	const credentialGuard =
		"id = ? AND provider = 'devin' AND api_key = ? AND custom_endpoint IS ? AND auto_fallback_enabled = 1";
	const params = [account.id, account.api_key, account.custom_endpoint ?? null];
	if (action === "pause") {
		await db.run(
			`UPDATE accounts SET paused = 1, pause_reason = 'overage' WHERE ${credentialGuard} AND COALESCE(paused, 0) = 0 AND COALESCE(auto_pause_on_overage_enabled, 1) = 1`,
			params,
		);
	} else {
		await db.run(
			`UPDATE accounts SET paused = 0, pause_reason = NULL WHERE ${credentialGuard} AND paused = 1 AND pause_reason IN ('overage', 'rate_limit_window') AND (rate_limited_until IS NULL OR rate_limited_until < ?)`,
			[...params, now],
		);
	}
}
