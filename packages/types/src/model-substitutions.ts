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
	/**
	 * True when an operator exception covers this pair, so enforcement waives
	 * the failover. The pair is still counted and still rendered; only its claim
	 * on the operator's attention changes.
	 */
	accepted: boolean;
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

/**
 * A substitution the operator has decided is acceptable.
 *
 * Not every swap is a downgrade: a provider answering a `gpt-5.6-luna` request
 * with `gpt-6-luna` hands back a newer model than the one asked for, and
 * failing that attempt over would trade a better answer for a retry.
 *
 * An exception suppresses only the ENFORCEMENT. The pair is still detected,
 * still recorded on the attempt row and still reaches the dashboard, because
 * "this is fine" and "this is not happening" are different claims and only the
 * second one should ever make the data disappear.
 */
export interface ModelSubstitutionException {
	/** The model the proxy sent, or `*` for any. */
	sent: string;
	/** The model the provider answered with, or `*` for any. */
	served: string;
}

/** Separator in the stored form. No model id in any provider's catalogue uses it. */
const EXCEPTION_SEPARATOR = ">";

export const MODEL_SUBSTITUTION_EXCEPTION_WILDCARD = "*";

/**
 * `sent>served`, e.g. `gpt-5.6-luna>gpt-6-luna`.
 *
 * Returns null for anything unparseable so a hand-edited config file degrades
 * to "this line does nothing" rather than to an exception that matches
 * everything.
 */
export function parseModelSubstitutionException(
	raw: string,
): ModelSubstitutionException | null {
	const parts = raw.split(EXCEPTION_SEPARATOR);
	if (parts.length !== 2) return null;
	const sent = parts[0]?.trim().toLowerCase() ?? "";
	const served = parts[1]?.trim().toLowerCase() ?? "";
	if (!sent || !served) return null;
	// `*>*` would silence enforcement for every pair on every account while the
	// mode still reads "enforce". That state already has a name: `observe`.
	if (
		sent === MODEL_SUBSTITUTION_EXCEPTION_WILDCARD &&
		served === MODEL_SUBSTITUTION_EXCEPTION_WILDCARD
	)
		return null;
	return { sent, served };
}

export function formatModelSubstitutionException(
	exception: ModelSubstitutionException,
): string {
	return `${exception.sent}${EXCEPTION_SEPARATOR}${exception.served}`;
}

/** Parse a stored list, dropping entries that do not parse. */
export function parseModelSubstitutionExceptions(
	raw: readonly string[],
): ModelSubstitutionException[] {
	const out: ModelSubstitutionException[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		const parsed = parseModelSubstitutionException(entry);
		if (!parsed) continue;
		const key = formatModelSubstitutionException(parsed);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(parsed);
	}
	return out;
}
