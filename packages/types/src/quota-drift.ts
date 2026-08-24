/**
 * Wire types for `GET /api/analytics/quota-drift` — the precomputed answer to
 * "how much of a usage window does 1M tokens of this model consume, and has
 * that number moved".
 *
 * ## The one contract that runs through all of this
 *
 * Every numeric field that can be unidentified is `number | null`, NEVER 0.
 * A concrete 0 reads as "this model is free" or "nothing changed", which is the
 * opposite of "we could not tell". Same rule as `usage-normalizer.ts`.
 *
 * ## What these numbers are not
 *
 * They are the IMPLIED cost of a model against a window, inferred from the
 * proxy's own request records against the provider's reported percentages. They
 * are not the provider's internal quota accounting, and four different things
 * would move them identically: a capacity change, a change in the provider's
 * token-class weighting, off-proxy usage on the same account, and a change on
 * our side of the measurement (token accounting, model-id normalization). The
 * UI has to say so; see the fields below that exist purely to let it.
 */

/** Which usage window a series describes. */
export type QuotaDriftWindow = "five_hour" | "seven_day";

/**
 * A verdict about one model on one window.
 *
 * `stable` means the changepoint test RAN and found nothing.
 * `insufficient-evidence` means it could not run. They are not interchangeable:
 * an underpowered scan reporting `stable` would claim a negative result it
 * never established.
 */
export type QuotaDriftVerdict = "changed" | "stable" | "insufficient-evidence";

/**
 * Why a point or estimate is unidentified, so the UI can explain the gap.
 *
 * `no-exposure` and `low-share` are deliberately separate. A model with ZERO
 * eq-tokens in a fit window was not routed here at all; one just under the
 * share floor ran and is too small to separate. Only the second is a statement
 * about measurement, and the panel must not tell a reader that a model it
 * stopped using is "too little traffic to measure".
 */
export type QuotaDriftUnidentifiedReason =
	| "wide-interval"
	| "no-exposure"
	| "low-share"
	| "few-segments"
	| "collinear"
	| "zero-estimate";

/** Whether a cohort's tier was recorded per sample or inferred from today. */
export type QuotaDriftTierProvenance = "recorded" | "assumed";

/** One point of a model's rolling series. */
export interface QuotaDriftPoint {
	/** Rolling window start, ms since epoch. */
	windowStartMs: number;
	/** Rolling window end, ms since epoch. */
	windowEndMs: number;
	/** Points of window consumed per 1M eq-tokens, or null when unidentified. */
	pointEstimate: number | null;
	ciLow: number | null;
	ciHigh: number | null;
	/** `100 / pointEstimate` — implied full-window capacity in Mtok, or null. */
	impliedCapacityMtok: number | null;
	identified: boolean;
	nSegments: number;
	/**
	 * Why this point has no number, empty when it has one.
	 *
	 * OPTIONAL on the wire because the payload is a cached JSON blob refreshed
	 * every 30 minutes and handed through without schema validation: for up to
	 * one refresh interval after a deploy the newest stored payload predates
	 * this field. The handler normalizes an absent value to `[]`; readers must
	 * still treat it as possibly missing rather than assuming a required field.
	 */
	unidentifiedReasons?: QuotaDriftUnidentifiedReason[];
}

/** A detected step change in one model's implied cost. */
export interface QuotaDriftChange {
	/** Boundary the series is split at, ms since epoch. */
	boundaryMs: number;
	before: number;
	after: number;
	/** `(after - before) / before`. Negative means the model got cheaper. */
	relativeChange: number;
	direction: "cheaper" | "more-expensive";
	/** The Bonferroni-adjusted level the difference cleared. */
	adjustedLevel: number;
	/** Candidate boundaries the scan considered. */
	nCandidates: number;
	nSegmentsBefore: number;
	nSegmentsAfter: number;
}

/** One model's estimates on one window. */
export interface QuotaDriftModel {
	/** Normalized model key (lowercased, trailing release date stripped). */
	key: string;
	/** Rolling series. Unidentified points carry nulls and must render as gaps. */
	points: QuotaDriftPoint[];
	/** Newest identified estimate, or null when the model is not measurable. */
	latest: {
		pointEstimate: number | null;
		ciLow: number | null;
		ciHigh: number | null;
		impliedCapacityMtok: number | null;
		/** Share of the latest window's eq-tokens this model accounts for, 0..1. */
		shareOfWindow: number;
		identified: boolean;
		unidentifiedReasons: QuotaDriftUnidentifiedReason[];
	} | null;
	changes: QuotaDriftChange[];
	verdict: QuotaDriftVerdict;
}

/** One window's worth of models plus the diagnostics that qualify them. */
export interface QuotaDriftWindowResult {
	window: QuotaDriftWindow;
	/** Segments the latest fit consumed. */
	nSegments: number;
	/** Coefficient of determination of the latest fit. */
	r2: number;
	/**
	 * Share of observed window movement that occurred in segments with NO
	 * observed proxy tokens.
	 *
	 * A LOWER BOUND on off-proxy usage, never a coverage figure: it can only
	 * catch hidden usage in segments containing no proxy traffic at all. Usage
	 * concurrent with proxy traffic is silently attributed to whatever was
	 * running. The UI must label it as a lower bound and must never cite it in
	 * support of a verdict.
	 */
	zeroObservedTokenDeltaShare: number;
	models: QuotaDriftModel[];

	/* ── Whether the window moved at all ──────────────────────────────────
	 *
	 * A window can be reported continuously and still never change. The Codex
	 * 5-hour window has been at the same value since 2026-07-12 while it was
	 * still being sampled every few minutes, and no fit over it can produce
	 * anything, because the response variable is constant.
	 *
	 * All four fields are OPTIONAL for the same reason as
	 * `QuotaDriftPoint.unidentifiedReasons`: the payload is a cached blob and
	 * the newest one can predate them by up to a refresh interval. The handler
	 * normalizes each absent value to null.
	 */

	/**
	 * When the reported percentage last CHANGED, ms since epoch, or null when it
	 * never changed within the observed span.
	 *
	 * Compared between consecutive samples of ONE account: two accounts reading
	 * different values is not movement.
	 */
	lastMovementMs?: number | null;
	/**
	 * The most recent non-null sample of this window, ms since epoch, or null
	 * when nothing was ever reported.
	 *
	 * Present so a reader can tell a FROZEN window from a STALLED SAMPLER. A
	 * window that has not moved because nobody has looked at it for a month is
	 * not a statement about the provider, and the two are indistinguishable
	 * without this.
	 */
	lastObservedMs?: number | null;
	/**
	 * The constant value the window has been reporting, in percent, or null when
	 * the cohort's accounts are constant at DIFFERENT values (each is flat, so
	 * the cohort is flat, but there is no single number to name).
	 */
	flatValuePct?: number | null;
	/**
	 * When the current unbroken flat stretch began, ms since epoch, or null.
	 *
	 * Set only when ALL of these hold, and the last one is the point of the
	 * field: no movement for longer than this window's threshold; the observed
	 * span extends beyond that threshold; observation was CONTINUOUS through it;
	 * and material proxy traffic was charged against the window in that period.
	 *
	 * A window that did not move because we sent nothing is not a provider fact,
	 * and must not be reported as one.
	 */
	flatSince?: number | null;
}

/** One cohort of accounts fitted together. */
export interface QuotaDriftCohort {
	/** Stable key: `provider|planTier|rateLimitTier`. */
	key: string;
	provider: string;
	/** Plan tier, or null when never captured. */
	planTier: string | null;
	/** Rate-limit tier, or null when never captured (Codex reports none). */
	rateLimitTier: string | null;
	/** Accounts that contributed at least one segment. */
	accountIds: string[];
	/**
	 * `recorded` when the tier came from the samples themselves; `assumed` when
	 * it was inferred from the account's present-day values because the samples
	 * predate the per-sample columns. The UI has to disclose `assumed`: a tier
	 * change refiles history and reads exactly like quota drift.
	 */
	tierProvenance: QuotaDriftTierProvenance;
	windows: QuotaDriftWindowResult[];
}

/**
 * Response from `GET /api/analytics/quota-drift`.
 *
 * `status: "computing"` is returned when no precompute pass has completed yet,
 * so the panel can say so rather than rendering an empty chart that looks like
 * "no drift".
 */
export interface QuotaDriftResponse {
	status: "ready" | "computing";
	/** When the payload was computed, ms since epoch; null while computing. */
	computedAt: number | null;
	/** Wall-clock the precompute pass took, ms; null while computing. */
	computeMs: number | null;
	cohorts: QuotaDriftCohort[];
}
