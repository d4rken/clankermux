import type { Account } from "@clankermux/types";

/**
 * Whether a cooldown rules an account out as the alternative that lets a
 * weekly-exhausted account keep its banked reset. Ordinary cooldowns do not: a
 * 60s burst 429 must not spend a reset while the account still has quota, so
 * usage decides. These two block while usage can still show headroom:
 * `out_of_credits` until its deadline, `org_permission_denied` until an admin
 * restores access, whatever the deadline says.
 */
export function cooldownRulesOutAlternative(
	account: Pick<Account, "rate_limited_reason" | "rate_limited_until">,
	now: number,
): boolean {
	if (account.rate_limited_reason === "org_permission_denied") return true;
	return (
		account.rate_limited_reason === "out_of_credits" &&
		account.rate_limited_until != null &&
		account.rate_limited_until > now
	);
}
