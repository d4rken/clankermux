/**
 * Shapes for the standing claim-series audit.
 *
 * The audit answers "what is actually in the `unified_claim_observations`
 * series, and how much of it can be trusted" — the questions that have to be
 * answered before anything is FITTED to that series. It is deliberately
 * descriptive: every output is a count, a share of a stated denominator, or a
 * quantile, and nothing here concludes anything about the provider.
 *
 * ## The one contract that runs through all of this
 *
 * Every output with no denominator is `null`, NEVER 0. A share of zero rows is
 * not "0%", it is "there was nothing to divide"; a median of no increments is
 * not 0, it is absent. Same rule as the quota-drift wire types.
 */

/**
 * One `unified_claim_observations` row, as the audit consumes it.
 *
 * A structural copy of the stored row rather than an import of the database
 * type: this module is pure and DB-free, and depending on the storage shape
 * would make it impossible to run against synthetic rows with known answers.
 */
export interface ClaimObservationInput {
	accountId: string;
	/** Claim token: `5h`, `7d`, or a scoped window such as `7d_oi`. */
	claim: string;
	requestId: string;
	/** Headers-arrival time, ms since epoch. */
	observedAt: number;
	/** Request start, ms since epoch. */
	requestStartedAt: number;
	httpStatus: number;
	/** Which dispatch produced the response (`client`/`keepalive`/…). */
	source: string;
	/** The claim's status value verbatim. */
	status: string;
	/** Reported utilization; null = no reading (0 is a reading). */
	utilization: number | null;
	/** Claim reset time, ms since epoch; null when unknown. */
	resetAt: number | null;
}

/** The span the audit covers. Stated explicitly so a reader can date it. */
export interface ClaimAuditRange {
	fromMs: number;
	toMs: number;
}

/** One value and how often it occurred. */
export interface ClaimValueCount {
	value: number;
	count: number;
}

/** One label and how often it occurred. */
export interface ClaimLabelCount {
	label: string;
	count: number;
}

/**
 * How the captured rows break down by dispatch source, claim status and HTTP
 * status.
 *
 * COMPOSITION, deliberately not "coverage". These counts describe the rows that
 * WERE captured and say nothing whatsoever about the responses that were not:
 * a series that is 98% `client` may be missing every keepalive replay, and the
 * same numbers would result. Any reading of these as a completeness figure is
 * the error the name exists to block.
 */
export interface ClaimComposition {
	bySource: ClaimLabelCount[];
	byStatus: ClaimLabelCount[];
	byHttpStatus: ClaimLabelCount[];
}

/**
 * Everything the audit establishes about ONE claim token, pooled across the
 * accounts that reported it.
 *
 * Pooled for REPORTING only. Every transition statistic below is derived within
 * a single (account, claim) series and merely summed here — comparing one
 * account's reading against another's would manufacture transitions that never
 * happened.
 */
export interface ClaimSeriesAudit {
	claim: string;
	/** Distinct (account, claim) series that contributed. */
	nSeries: number;
	nAccounts: number;
	/** Rows captured for this claim in the range. */
	rows: number;
	/** Earliest/latest `observedAt` seen, or null when no rows. */
	firstObservedAt: number | null;
	lastObservedAt: number | null;
	/**
	 * Rows per day over the OBSERVED span (last minus first), not over the audit
	 * range: a claim first seen yesterday has not been quiet for 90 days, it has
	 * existed for one. Null when the span is zero or a single row.
	 */
	rowsPerDay: number | null;

	/* ── What the readings look like ─────────────────────────────────────── */

	/** Rows whose utilization was absent or non-finite. */
	nullUtilizationRows: number;
	/** `nullUtilizationRows / rows`, or null when there were no rows. */
	nullUtilizationShare: number | null;
	/**
	 * Distinct finite utilization values seen.
	 *
	 * A LOWER BOUND when `distinctValuesExact` is false: the tracker is capped
	 * (see MAX_TRACKED_VALUES) so a pathological series cannot turn the audit
	 * into an unbounded set. The cap is what keeps this an audit rather than a
	 * second copy of the table.
	 */
	distinctValues: number;
	distinctValuesExact: boolean;
	/** The most frequent values, most frequent first. Bounded by TOP_VALUES_K. */
	topValues: ClaimValueCount[];
	/** Finite readings that land on the 0.01 grid within tolerance. */
	onGrid01: number;
	/** Finite readings that land on the 0.001 grid within tolerance. */
	onGrid001: number;
	/** `onGrid01 / finite readings`, or null when there were none. */
	gridShare01: number | null;
	/** `onGrid001 / finite readings`, or null when there were none. */
	gridShare001: number | null;

	/* ── How the readings move ───────────────────────────────────────────── */

	/**
	 * Consecutive COMPARABLE pairs within a series: both readings finite. A row
	 * with no reading does not end a series, it is skipped — the next finite
	 * reading is compared against the last finite one.
	 */
	transitions: number;
	positiveIncrements: number;
	/** Smallest strictly positive increment seen, or null when there were none. */
	minPositiveIncrement: number | null;
	/**
	 * Median strictly positive increment, or null when there were none — and
	 * also null when the increment tracker overflowed its cap, since a median
	 * cannot be computed from a truncated distribution and a guess would be
	 * indistinguishable from a measurement.
	 */
	medianPositiveIncrement: number | null;

	/* ── Drops, and which of them are explainable ────────────────────────── */

	/**
	 * Transitions where BOTH readings carried a reset and the two agree within
	 * the jitter tolerance — i.e. the same window instance on both sides.
	 *
	 * The denominator for every negative statistic below. Two NULL resets do not
	 * qualify: absence of evidence that the window rolled over is not evidence
	 * that it did not, and counting those pairs as stable is what would turn a
	 * missed reset into a phantom "the provider gave tokens back".
	 */
	stableResetTransitions: number;
	/** Negative increments among the stable-reset transitions. */
	stableResetNegatives: number;
	/** Drops of at least GIFT_DROP_THRESHOLD among the stable-reset transitions. */
	giftDrops: number;
	/**
	 * Gift-sized drops where the two requests' START order is inverted relative
	 * to their observation order AND the requests overlapped in time.
	 *
	 * Both conditions are required. Inverted starts alone are ordinary under
	 * concurrency; overlapping alone says nothing about which reading is older.
	 * Together they mean the later-observed row may carry the OLDER reading, and
	 * a "drop" between them can be an artefact of arrival order rather than
	 * anything the provider did.
	 */
	giftDropsOrderingSuspect: number;
	/** Gift-sized drops the ordering explanation does NOT cover. */
	giftDropsUnexplained: number;

	/** Composition of the captured rows — see {@link ClaimComposition}. */
	composition: ClaimComposition;
}

/** The whole audit: one entry per claim token, plus the span it covers. */
export interface ClaimAuditReport {
	fromMs: number;
	toMs: number;
	/** Claims in ascending token order, so two passes are comparable by eye. */
	claims: ClaimSeriesAudit[];
}
