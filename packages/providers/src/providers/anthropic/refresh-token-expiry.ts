/**
 * Anthropic reports how long the *refresh* token it just handed us stays valid,
 * as `refresh_token_expires_in` (seconds) on both the authorization-code
 * exchange and every refresh. It is the only provider that does: a Codex token
 * response carries `access_token, token_type, expires_in, scope, id_token,
 * earliest_refresh_at, refresh_token, oai_is` and nothing about the refresh
 * token's own lifetime.
 *
 * The value counts down toward a fixed date rather than resetting on each
 * rotation, so an account refreshed every 7.5 hours for weeks still reaches it
 * and then fails `invalid_grant` at whatever moment its next refresh happens to
 * land on. Recording it is what turns that into a date on a dashboard instead
 * of an account dropping out of rotation unannounced.
 */

/** The token-response fields this module reads. Everything else is ignored. */
export interface RefreshTokenExpiryFields {
	refresh_token_expires_in?: unknown;
}

/**
 * Resolve `refresh_token_expires_in` into an absolute epoch-ms deadline.
 *
 * Returns `null` when the field is absent or not a usable duration. Null means
 * "this provider did not tell us", which callers must keep distinct from a
 * distant deadline — a null deadline can never raise a re-auth warning, so a
 * malformed value degrades to silence rather than to a wrong date.
 *
 * Non-positive durations are rejected rather than turned into a past deadline:
 * a token that the provider just issued and simultaneously declared expired is
 * a response we do not understand, and guessing would surface a permanent
 * "re-auth overdue" warning on a working account.
 */
export function resolveRefreshTokenExpiresAt(
	json: RefreshTokenExpiryFields,
	now: number = Date.now(),
): number | null {
	const seconds = json.refresh_token_expires_in;
	if (
		typeof seconds !== "number" ||
		!Number.isFinite(seconds) ||
		seconds <= 0
	) {
		return null;
	}
	return now + seconds * 1000;
}
