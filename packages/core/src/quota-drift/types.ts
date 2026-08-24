/**
 * Shared shapes for the quota-drift estimator.
 *
 * The whole module is pure and DB-free: it consumes already-assembled segments
 * and produces coefficient estimates, so every claim it makes can be checked
 * against synthetic data with known ground truth.
 *
 * ## The model
 *
 * For one account and one usage window, between two snapshots inside a single
 * monotonically-increasing run of the reported percentage:
 *
 *     Δpct = Σ_m  w_m · eqTokens_m / 1e6
 *
 * `w_m` is model *m*'s cost against that window, in percentage points per
 * million equivalent tokens. `100 / w_m` is the implied full-window capacity if
 * the whole window were spent on that one model. A provider changing what the
 * subscription buys moves `w_m`.
 */

/** Which usage window a segment/fit describes. */
export type QuotaWindowKind = "five_hour" | "seven_day";

/**
 * One observation: the reported percentage moved by `dpct` while the requests
 * in `[t0, t1)` were charged against the window.
 *
 * `runId` groups segments that came from the same monotone run of one account's
 * window. Segments within a run share an account, a window instance, the
 * polling lag and the time-correlated integer quantization of the reported
 * percentage, so they are NOT independent draws — the bootstrap resamples whole
 * runs for exactly that reason.
 */
export interface QuotaSegment {
	/** Run this segment belongs to (bootstrap resampling unit). */
	runId: string;
	/** Account the window belongs to. */
	accountId: string;
	/** Segment start, ms since epoch (inclusive). */
	t0: number;
	/** Segment end, ms since epoch (exclusive). */
	t1: number;
	/** Change in reported window utilization across the segment, in points. */
	dpct: number;
	/**
	 * Equivalent tokens charged in `[t0, t1)`, keyed by normalized model key.
	 * Absent keys are zero. Models absent from every segment do not exist as far
	 * as a fit is concerned.
	 */
	eqTokensByModel: Readonly<Record<string, number>>;
}

/** The four token classes a request is charged for. */
export interface TokenCounts {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
}

/** A design matrix plus response vector, ready for the solver. */
export interface FitInput {
	/** Column order — one coefficient per entry. */
	keys: readonly string[];
	/** Row-major design matrix: `X[i][j]` = model `keys[j]`'s Mtok in segment i. */
	X: readonly (readonly number[])[];
	/** Response vector: `y[i]` = segment i's `dpct`. */
	y: readonly number[];
	/** Run id per row, for the block bootstrap. */
	runIds: readonly string[];
}

/**
 * One model's estimated cost against a window, with the evidence needed to
 * decide whether the number means anything.
 *
 * Every numeric field that can be unidentified is `number | null`, never 0 — a
 * concrete 0 reads as "this model is free", which is the opposite of "we cannot
 * tell". `identified === false` means the point must render as a gap.
 */
export interface CoefficientEstimate {
	/** Normalized model key (see `normalizeModelKey`). */
	key: string;
	/** Percentage points of the window consumed per 1M equivalent tokens. */
	pointEstimate: number | null;
	/** Bootstrap interval lower bound, or null when unidentified. */
	ciLow: number | null;
	/** Bootstrap interval upper bound, or null when unidentified. */
	ciHigh: number | null;
	/** Implied full-window capacity in Mtok (`100 / w`), or null. */
	impliedCapacityMtok: number | null;
	/** This model's share of the fit window's total eq-tokens, 0..1. */
	shareOfWindow: number;
	/**
	 * `1 - R²` of regressing this model's exposure column on the others. Low
	 * tolerance means the column is nearly a linear combination of the rest, so
	 * the split between them is arbitrary however narrow the interval looks.
	 */
	tolerance: number;
	/** Whether all four identifiability criteria are met. */
	identified: boolean;
	/** Which criteria failed, for the UI to explain a gap. */
	unidentifiedReasons: readonly UnidentifiedReason[];
}

/**
 * Why a coefficient failed the identifiability gate.
 *
 * `no-exposure` and `low-share` are NOT interchangeable, and conflating them
 * was the original defect: a model with ZERO eq-tokens in the fit window was
 * reported with the same "too little traffic to measure" wording as one sitting
 * just under the share floor. Only the second is a statement about
 * measurement — the first says the model simply was not routed here. It
 * therefore takes precedence wherever both would apply.
 */
export type UnidentifiedReason =
	| "wide-interval"
	| "no-exposure"
	| "low-share"
	| "few-segments"
	| "collinear"
	| "zero-estimate";

/** Whether a fit's cohort tier came from the samples or from today's accounts. */
export type TierProvenance = "recorded" | "assumed";

/** One fit over one set of segments. */
export interface FitResult {
	/** Segments the fit consumed. */
	nSegments: number;
	/** Coefficient of determination of the fitted Δpct against the observed. */
	r2: number;
	/**
	 * Share of total observed Δpct that occurred in segments with ZERO observed
	 * tokens.
	 *
	 * This is a LOWER BOUND on traffic the proxy cannot see, never a coverage
	 * figure. It only catches hidden usage in segments containing no proxy
	 * traffic at all; hidden usage concurrent with proxy traffic is silently
	 * attributed to whichever models were running and inflates their
	 * coefficients invisibly. It must never be cited as support for a verdict.
	 */
	zeroObservedTokenDeltaShare: number;
	/** Accounts that contributed at least one segment. */
	contributingAccountIds: readonly string[];
	/** Whether the cohort's tier was recorded per sample or inferred from today. */
	tierProvenance: TierProvenance;
	/** Per-model estimates, in the fit's column order. */
	coefficients: readonly CoefficientEstimate[];
}

/** One point of the rolling display series for one model. */
export interface SeriesPoint {
	/** Window start, ms since epoch. */
	windowStartMs: number;
	/** Window end, ms since epoch (exclusive). */
	windowEndMs: number;
	/** Points of window per 1M eq-tokens, or null when unidentified. */
	pointEstimate: number | null;
	ciLow: number | null;
	ciHigh: number | null;
	/** `100 / pointEstimate`, or null when unidentified. */
	impliedCapacityMtok: number | null;
	identified: boolean;
	nSegments: number;
	/**
	 * Why this point has no number, empty when it has one.
	 *
	 * Carried PER POINT rather than only on the latest fit because the gap in
	 * the chart is what a reader actually asks about, and the answer differs
	 * along the series: the same model can be pooled out early, separable in the
	 * middle, and absent from the traffic entirely at the end.
	 */
	unidentifiedReasons: readonly UnidentifiedReason[];
}

/** A detected step change in one model's coefficient. */
export interface DetectedChange {
	/** Boundary timestamp, ms since epoch: segments before/after are split here. */
	boundaryMs: number;
	/** Coefficient estimate before the boundary. */
	before: number;
	/** Coefficient estimate after the boundary. */
	after: number;
	/** `(after - before) / before`. Negative = the model got cheaper. */
	relativeChange: number;
	/** Direction of the move in COST terms. */
	direction: "cheaper" | "more-expensive";
	/**
	 * The Bonferroni-adjusted level the difference cleared
	 * (`0.05 / nCandidates`). Reported so a reader can see the scan was paid for.
	 */
	adjustedLevel: number;
	/** Number of candidate boundaries scanned. */
	nCandidates: number;
	/** Segments on each side of the boundary. */
	nSegmentsBefore: number;
	nSegmentsAfter: number;
}

/**
 * A verdict about one model on one window.
 *
 * `insufficient-evidence` and `no-change-detected` are NOT interchangeable:
 * `no-change-detected` means the test ran and found nothing,
 * `insufficient-evidence` means it could not run. An underpowered scan must
 * never report `no-change-detected`.
 *
 * Named for what it establishes rather than for what a reader might infer.
 * "Stable" is a claim about the provider; "no change detected" is a statement
 * about this test, which is all a non-significant result on ~80 days of
 * indirect evidence can support. The semantics are unchanged — only the word
 * stopped overselling them.
 */
export type QuotaVerdict =
	| "changed"
	| "no-change-detected"
	| "insufficient-evidence";
