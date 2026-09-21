/**
 * Where a provider answered with a different model than the one it was sent.
 *
 * The proxy has always recorded both halves — `routing_attempts.outgoing_model`
 * and `.reported_model` — and nothing ever compared them. 7,760 substitutions
 * accumulated unseen before a pricing banner about an unrelated model exposed
 * them, and the only place the pair was visible was one request at a time in
 * the routing-attempts panel.
 *
 * Aggregated from `routing_attempts`, never from `requests`: the substituting
 * attempt is usually NOT the one that produced the request's final row, because
 * the point of the feature is that a sibling serves it afterwards.
 */

/** One (account, sent model, served model) triple over the queried window. */
export interface ModelSubstitutionPair {
	accountId: string;
	accountName: string;
	provider: string;
	/** What the proxy put on the wire. */
	outgoingModel: string;
	/** What the provider said it served instead. */
	reportedModel: string;
	/** Attempts in the window whose served model differed. */
	substituted: number;
	/**
	 * Attempts in the window that sent `outgoingModel` on this account AND
	 * reported some model back.
	 *
	 * The denominator deliberately excludes attempts with no reported model:
	 * those are "could not tell", and counting them as clean would understate
	 * the rate by however often the provider stayed silent.
	 */
	comparable: number;
	firstAtMs: number;
	lastAtMs: number;
}

/**
 * An account currently serving something other than what it is asked for.
 *
 * "Currently" is a decision, not an observation: the underlying rows are a
 * history, so a threshold has to say when a past substitution stops describing
 * the present. See `MODEL_SUBSTITUTION_ACTIVE_WINDOW_MS`.
 */
export interface DegradedAccount {
	accountId: string;
	accountName: string;
	provider: string;
	/** Worst offender first, by share of comparable attempts. */
	pairs: ModelSubstitutionPair[];
}

export interface ModelSubstitutionsResponse {
	/** Every pair in the requested range, newest activity first. */
	pairs: ModelSubstitutionPair[];
	/** The subset still substituting inside the active window. */
	degraded: DegradedAccount[];
	/** Buckets for the history chart, aligned to the range's grid. */
	series: ModelSubstitutionPoint[];
	/** End of the window the server actually measured, for stable rendering. */
	generatedAtMs: number;
}

export interface ModelSubstitutionPoint {
	bucketMs: number;
	substituted: number;
	comparable: number;
}

/**
 * How recently an account must have substituted to count as degraded now.
 *
 * Longer than the five-minute routing suppression on purpose. The suppression
 * moves traffic away from the account, so a shorter window would clear the chip
 * precisely because the mitigation is working and then re-raise it on the next
 * probe, flapping once per suppression cycle.
 */
export const MODEL_SUBSTITUTION_ACTIVE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Share of comparable attempts that must have been substituted for an account
 * to read as degraded, guarding against a single stray attempt pinning a chip.
 */
export const MODEL_SUBSTITUTION_ACTIVE_MIN_SHARE = 0.1;

/** Below this many comparable attempts the share is too noisy to act on. */
export const MODEL_SUBSTITUTION_ACTIVE_MIN_ATTEMPTS = 3;

/** Convenience for both the chip tooltip and the analytics card. */
export function substitutionShare(pair: ModelSubstitutionPair): number {
	return pair.comparable > 0 ? pair.substituted / pair.comparable : 0;
}
