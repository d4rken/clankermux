// Unified claim observation types — the REQUEST-ALIGNED time-series of the
// per-claim rate-limit readings Anthropic returns on a response, as opposed to
// the sampler-driven `usage_snapshots` series which is aligned to a polling
// tick and quantised to whole percent.

/**
 * Which dispatch produced the response an observation was read from.
 *
 * Kept per row because the three kinds have different meaning for analysis:
 * `client` traffic is user demand, while `keepalive` and `auto-refresh` are
 * internal probes that consume real quota but are deliberately absent from
 * Request History. Derived from the unspoofable in-process dispatch flag plus
 * the probe marker header, never from the header alone.
 */
export type UnifiedClaimObservationSource =
	| "client"
	| "keepalive"
	| "auto-refresh";

/**
 * One claim's reading on one response.
 *
 * A single response yields as many rows as it carried claim lines (`5h`, `7d`,
 * and any scoped window such as `7d_oi`), all sharing `requestId`.
 *
 * `utilization`/`resetAt` are nullable and null means NO READING — a reported
 * utilization of zero is stored as `0`. `observedAt` is when the headers
 * arrived; `requestStartedAt` is when the request began, recorded separately
 * because the request row's own timestamp is written at persistence time and
 * neither substitutes for the other when aligning a series.
 */
export interface UnifiedClaimObservationRow {
	requestId: string;
	accountId: string;
	source: UnifiedClaimObservationSource;
	/** Request start, ms since epoch. */
	requestStartedAt: number;
	/** Headers-arrival time, ms since epoch. */
	observedAt: number;
	/** HTTP status of the response the reading came from. */
	httpStatus: number;
	/** Claim token: `5h`, `7d`, or a scoped window such as `7d_oi`. */
	claim: string;
	/** The claim's status value verbatim. */
	status: string;
	/** Reported utilization, or null when absent/unparseable (`0` is a reading). */
	utilization: number | null;
	/** Claim reset time, ms since epoch, or null when unknown. */
	resetAt: number | null;
	/**
	 * The claim's `-surpassed-threshold` reading — the utilization level the
	 * provider says this claim has crossed. Null when absent/unparseable; `0` is
	 * a reading. Recorded rather than interpreted: it is the only header that
	 * says anything about where the provider's own warning bands sit.
	 */
	surpassedThreshold: number | null;
}
