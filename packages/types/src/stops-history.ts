/**
 * The retrospective "how often was I actually stopped, and why" surface.
 *
 * Every other quota surface in the dashboard is a FORECAST. A forecast can
 * always be wrong, so it can never settle the question it is asked; a measured
 * base rate can. This is the only surface that reports what already happened.
 *
 * It exists because the forecasts and the failures were measuring different
 * things. Over one 45-day production window, 584 of 459,894 requests were
 * blocked (0.13%) — and of the 304 filed under `all_accounts_failed`, 300 were
 * a single retired model that no account could serve, while the account behind
 * them sat at 11% of its weekly limit. The pool tiles were green and correct
 * the entire time.
 */

/**
 * Why a request was refused, as a CLOSED set.
 *
 * `requests.error_message` cannot be read as an enum: it holds terminal labels
 * written by the give-up path (`all_accounts_failed`), per-attempt
 * `RateLimitReason` strings (`family_weekly_exhausted_429`), and free-form
 * `"<status> <upstream text>"` built from whatever the provider returned. So
 * the raw string is classified into this set server-side and travels only as a
 * truncated sample afterwards — never as a key a client groups on.
 *
 * `other` is mandatory and load-bearing: a proxy that grows a new terminal
 * tomorrow must land somewhere honest rather than silently vanishing from a
 * total that is supposed to account for every blocked request.
 */
export type StopCause =
	/** The pool genuinely had no account with capacity left. */
	| "pool_quota_exhausted"
	/** One model family's weekly quota was spent while the account was otherwise fine. */
	| "family_weekly_exhausted"
	/** No account could serve the requested model. Not a capacity event. */
	| "model_not_served"
	/** Every OAuth account's refresh token was past its maximum age. */
	| "oauth_tokens_expired"
	/** The request was pinned to a target that could not serve it; pinning forbids failover. */
	| "pinned_target_unavailable"
	/** The upstream provider was returning overload errors pool-wide. */
	| "provider_overloaded"
	/** The proxy's own pacing or burst-retry budget refused the request. */
	| "usage_throttled"
	/** The request was larger than any eligible account's context window. */
	| "context_window_exceeded"
	/** A non-2xx forwarded from upstream that is none of the above. */
	| "upstream_error"
	| "other";

export const STOP_CAUSES: readonly StopCause[] = [
	"pool_quota_exhausted",
	"family_weekly_exhausted",
	"model_not_served",
	"oauth_tokens_expired",
	"pinned_target_unavailable",
	"provider_overloaded",
	"usage_throttled",
	"context_window_exceeded",
	"upstream_error",
	"other",
];

/**
 * Exact `error_message` values, by cause.
 *
 * Kept as an explicit table rather than prefix matching so that adding a
 * terminal to the proxy without classifying it here shows up as an `other`
 * bucket climbing — a visible gap — instead of being absorbed into a
 * neighbouring cause by a loose prefix rule.
 */
const EXACT_LABELS: Readonly<Record<string, StopCause>> = {
	all_accounts_failed: "pool_quota_exhausted",
	pool_exhausted: "pool_quota_exhausted",
	weekly_exhausted_429: "pool_quota_exhausted",
	session_exhausted_429: "pool_quota_exhausted",
	anthropic_excluded_no_account: "pool_quota_exhausted",
	family_weekly_exhausted: "family_weekly_exhausted",
	family_weekly_exhausted_429: "family_weekly_exhausted",
	model_not_served: "model_not_served",
	oauth_tokens_expired: "oauth_tokens_expired",
	pinned_target_unavailable: "pinned_target_unavailable",
	pinned_no_available_account: "pinned_target_unavailable",
	provider_overloaded: "provider_overloaded",
	burst_retry_exhausted: "usage_throttled",
	usage_throttled: "usage_throttled",
	context_window_exceeded: "context_window_exceeded",
};

/**
 * Classify one `requests.error_message` into a {@link StopCause}.
 *
 * Pure, so it can be unit-tested without a database and shared unchanged by the
 * dashboard read and the public widget read — two surfaces that must never
 * disagree about what a row means.
 *
 * @param errorMessage the raw stored string, or null
 * @param statusCode the recorded response status, used only to separate a
 *   forwarded upstream failure from an unrecognised proxy label
 */
export function classifyStopCause(
	errorMessage: string | null | undefined,
	statusCode: number | null | undefined,
): StopCause {
	// Emptiness is judged AFTER trimming: a whitespace-only message is no
	// evidence at all, and treating it as a present-but-unrecognised label would
	// let the status-code fallback below classify a blank row as an upstream
	// failure it has nothing to say about.
	const trimmed = errorMessage?.trim() ?? "";
	if (trimmed === "") return "other";
	const exact = EXACT_LABELS[trimmed];
	if (exact) return exact;

	// Free-form upstream text is recorded as "<status> <provider message>", so a
	// leading status code is the tell that this is a forwarded failure rather
	// than a proxy verdict. Matching the shape, not the wording: the message
	// half is provider-authored and changes without notice.
	if (/^\d{3}\s/.test(trimmed)) return "upstream_error";

	// A recorded HTTP failure with an unrecognised message is still an upstream
	// failure; only a row with no usable status is genuinely unclassifiable.
	if (typeof statusCode === "number" && statusCode >= 400) {
		return "upstream_error";
	}
	return "other";
}

/** One bucket of the per-cause time series. */
export interface StopsHistoryPoint {
	/** Bucket start, ms since epoch. */
	ts: number;
	count: number;
}

export interface StopsHistoryCause {
	cause: StopCause;
	count: number;
	firstSeenMs: number;
	lastSeenMs: number;
	/**
	 * The model most often requested under this cause, and how many of the
	 * cause's blocks it accounts for.
	 *
	 * Present on EVERY cause row, not only suspicious ones. A cause that is
	 * dominated by one model is usually not the story its label tells — the
	 * production case that motivated this surface reads
	 * "pool quota exhausted - gpt-5.2-codex x300", which is self-evidently a
	 * model problem even though the label says quota, and rows written before
	 * the proxy learned to distinguish the two keep the old label forever.
	 */
	topRequestedModel: string | null;
	topRequestedModelCount: number;
	/** Truncated raw `error_message`. Provenance for a human, never a key. */
	sampleErrorMessage: string | null;
	series: StopsHistoryPoint[];
}

/**
 * How much redundancy the pool actually had, per request.
 *
 * `request_routing.candidates_count` is the number of accounts eligible to
 * serve each request. It is the leading indicator the forecasts cannot see: a
 * pool that never drops below two candidates has margin no projection can take
 * away, and one that spends most of its time at one candidate is a single
 * failure from a stop regardless of how much quota it shows.
 */
export interface StopsHistoryCandidates {
	observedRequests: number;
	zeroCandidateRequests: number;
	distribution: Array<{ candidatesCount: number; requests: number }>;
}

export interface StopsHistoryResponse {
	range: string;
	bucketMs: number;
	windowStartsAt: number;
	windowEndsAt: number;
	/** The denominator. A blocked count without it is not a rate. */
	totalRequests: number;
	blockedRequests: number;
	causes: StopsHistoryCause[];
	candidates: StopsHistoryCandidates;
}
