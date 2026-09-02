/**
 * The single definition of which pause reasons the load balancer is allowed to
 * clear on its own. Both strategies used to carry their own copy of this
 * allowlist, which is how they drifted apart.
 *
 * Self-healing reasons are the ones the proxy itself sets when an account runs
 * out of usage window (`overage`, `rate_limit_window`) plus the absent value.
 * Everything else (`manual`, `failure_threshold`, `oauth_invalid_grant`,
 * `subscription_expired`, and any reason we do not recognise) is durable and
 * needs a human or a re-auth to clear.
 *
 * The empty string counts as absent: the DB reader coerces `""` to `null`
 * (`packages/types/src/account.ts`), and `SessionStrategy` already treated it
 * that way through a falsy check, so accepting it here keeps every caller on
 * the same answer.
 */
export function isSelfHealingPauseReason(
	reason: string | null | undefined,
): boolean {
	return (
		reason == null ||
		reason === "" ||
		reason === "overage" ||
		reason === "rate_limit_window"
	);
}
