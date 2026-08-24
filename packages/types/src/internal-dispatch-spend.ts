// Internal-dispatch spend types — the per-dispatch token vectors of the
// proxy's OWN upstream traffic (cache-keepalive replays and auto-refresh
// probes). That traffic consumes real quota but is deliberately excluded from
// `requests` by shouldRecordRequest, so without this table the proxy's own
// burn is invisible to every analysis built on the request series.

/**
 * Which internal scheduler produced the dispatch. Only the two trust-gated
 * probe kinds appear here: client traffic is recorded in `requests` instead,
 * and a marker header alone never qualifies (the in-process dispatch flag is
 * required — see isTrustedSyntheticProbe).
 */
export type InternalDispatchSpendSource = "keepalive" | "auto-refresh";

/**
 * One internal dispatch's token vector.
 *
 * Keyed by the dispatch's own request id — the SAME id its
 * `unified_claim_observations` rows carry, so a probe's spend and the claim
 * state its response reported can be joined without a heuristic.
 *
 * Every token field is nullable and null means NO READING (the response
 * carried no usage, or the body never parsed); a reported zero is stored as 0.
 * `completedAt` is null when the response never reached a terminal state.
 */
export interface InternalDispatchSpendRow {
	/** The dispatch's request id (primary key). */
	id: string;
	accountId: string;
	source: InternalDispatchSpendSource;
	/** Provider-reported model, or null when the response never named one. */
	model: string | null;
	httpStatus: number;
	/** Request start, ms since epoch. */
	startedAt: number;
	/** When the body finished being read, ms since epoch; null when unknown. */
	completedAt: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadInputTokens: number | null;
	cacheCreationInputTokens: number | null;
}
