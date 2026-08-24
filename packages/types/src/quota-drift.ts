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

/**
 * Who a cohort-level window claim actually covers.
 *
 * `all-accounts` means every account still being sampled in this cohort was
 * checked and agreed. The other two both mean the cohort was not unanimous, and
 * they differ in what is known about the accounts the claim does NOT cover:
 *
 *  - `reporting-subset` — every account outside the claim currently reports the
 *    window. The split is fully characterised, so copy may say so;
 *  - `partial-cohort` — at least one account outside the claim neither carries
 *    the window in its newest reading nor has an absence this pass could
 *    establish. Its current state is unknown, and copy must not fill that in.
 *
 * Both sides of a split can carry a claim, and which one does depends on the
 * claim: `flatSince` is established on the accounts that still report the
 * window, `notReportedSince` on the accounts whose readings no longer include
 * it.
 *
 * `partial-cohort` is reachable only for `notReportedSince`. A flat claim is
 * established on the accounts currently reporting the window, and everything
 * outside it is by construction not reporting — there is no third state to
 * distinguish, and the flat copy already names the subset it covers.
 *
 * The distinction is not cosmetic. A cohort-wide claim built from a subset,
 * with the rest silently dropped, is a false statement about provider
 * behaviour — the one class of error this whole analysis exists not to make.
 * Saying the remaining accounts still report the window when nothing checked
 * that they do is the same error one level down.
 */
export type QuotaDriftAccountScope =
	| "all-accounts"
	| "reporting-subset"
	| "partial-cohort";

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
	 * Every field in this block is OPTIONAL for the same reason as
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
	 * What the reading `lastObservedMs` identifies showed, in percent, or null.
	 *
	 * Answers the question a reader has as soon as a window disappears from the
	 * readings: was it near exhaustion when we last saw it? A separate field
	 * from `flatValuePct`, which carries a value only when the flat claim was
	 * made and is therefore null in exactly that case.
	 *
	 * Null when nothing was ever observed, and also when two accounts share that
	 * newest timestamp reporting DIFFERENT percentages: the field states what
	 * one recorded reading contained, so with no single reading to quote there
	 * is nothing to state. It says nothing about any interval, about the cohort
	 * as a whole, or about what the window shows now.
	 */
	lastObservedValuePct?: number | null;
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
	/**
	 * Who `flatSince` covers, or null when there is no flat claim.
	 *
	 * Membership is decided on whether an account is still being SAMPLED, never
	 * on whether this particular window appears in its readings. An account that
	 * is still producing snapshots but whose value for this window has been
	 * absent for a day cannot be dropped from the decision: doing so let the
	 * remaining accounts speak for a cohort that is actually mixed, and the copy
	 * would say "every account" while a member had been silently excluded.
	 */
	flatScope?: QuotaDriftAccountScope | null;
	/**
	 * When our readings stopped including a value for this window at all, ms
	 * since epoch (the first reading without one), or null.
	 *
	 * A DIFFERENT state from `flatSince`, and the only one that can still be
	 * established when nothing reports the window: a window pinned at one value
	 * is still being read, a window absent from the payload is not being read at
	 * all, and no fit exists for either.
	 *
	 * The claim is about OUR readings and nothing else. A null percentage in the
	 * database proves absence from the NORMALIZED reading, never from the
	 * provider's raw payload: a shape the normalizer does not recognise, a
	 * non-finite value and a genuinely dropped field all reduce to the same
	 * null, so a normalizer bug and a provider change are indistinguishable
	 * here. Copy built on this field must say what we observed and must never
	 * say the provider retired, removed or changed anything.
	 *
	 * Set only when a value WAS reported before, the transition itself was
	 * observed (so it can be dated), the absence has held for at least a day,
	 * the sibling window kept reporting throughout (otherwise this is a stalled
	 * sampler, not a dropped window), and the newest reading is recent.
	 */
	notReportedSince?: number | null;
	/**
	 * Who `notReportedSince` covers, or null when there is no such claim.
	 *
	 * `all-accounts` means no still-sampled account in the cohort carries the
	 * window any more. `reporting-subset` means every account this claim does
	 * not cover carries the window in its newest reading — a partial rollout,
	 * which must never be stated as a cohort-wide observation.
	 *
	 * `partial-cohort` means the rest of the cohort is not in that state either:
	 * at least one account has also stopped carrying the window, but its absence
	 * is too young to report or could not be dated. Whether an absence is
	 * ESTABLISHED and whether a window is currently PRESENT are different
	 * properties, and reading the first as the second is what let the partial
	 * wording tell a reader that an account "still reports" a window whose
	 * newest readings were null.
	 */
	notReportedScope?: QuotaDriftAccountScope | null;
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
