import type { UsagePrediction } from "./usage-prediction";

/**
 * Quota-runway vocabulary: the outcome of the capacity scan, and the wire shape
 * `GET /api/runway` serves it in.
 *
 * These live in `@clankermux/types` rather than next to the scan itself
 * (`@clankermux/core/capacity-runway`) because the wire types reference
 * {@link RunwayOutcome} and this package is a deliberate leaf with NO
 * dependencies — defining them in core would make `types -> core -> types`, and
 * restating the union here would let the two drift. `capacity-runway.ts`
 * re-exports {@link RunwayCause} and {@link RunwayOutcome}, so every existing
 * `@clankermux/core` import site keeps working.
 */

/** The account + window that ran (or runs) out at the reported instant. */
export interface RunwayCause {
	accountId: string;
	windowKind: string;
}

/**
 * Reset credits the scan ASSUMED will be applied for one account — banked
 * OpenAI usage-reset credits the auto-applier is configured to redeem at
 * exhaustion. The outcome depends on those redemptions actually happening, so
 * the display must disclose the assumption instead of presenting the extended
 * runway as pure measurement.
 */
export interface RunwayAssumedCredits {
	accountId: string;
	/** How many credits the scan consumed from this account's modeled bank. */
	count: number;
}

export type RunwayOutcome =
	| { kind: "no-accounts" }
	| {
			kind: "unknown";
			/**
			 * See the doc on `out-now`. On `unknown` a non-empty list says the WHOLE
			 * pool was in that state: insufficient evidence, not infinity.
			 */
			learningAccountIds?: string[];
	  }
	| {
			kind: "out-now";
			causes: RunwayCause[];
			unprojectableAccountIds: string[];
			/**
			 * Present (non-empty) only when some eligible account had a readable
			 * window and at least one of its readable windows was still learning:
			 * inside the one-hour evidence span, at 0% (`no-usage` or a flat
			 * regression), or `unstarted`. Excluded from the survival set exactly
			 * like an unreadable account, and therefore ALSO listed in
			 * `unprojectableAccountIds` (a subset of it). On `unknown` it says the
			 * whole pool was in that state: insufficient evidence, not infinity.
			 */
			learningAccountIds?: string[];
			/** Present (non-empty) only when a credit assumption shaped the scan. */
			assumedResetCredits?: RunwayAssumedCredits[];
	  }
	| {
			kind: "beyond-horizon";
			horizonMs: number;
			unprojectableAccountIds: string[];
			/** See the doc on `out-now`. */
			learningAccountIds?: string[];
			assumedResetCredits?: RunwayAssumedCredits[];
			/**
			 * How fragile this "no run-out" is. The all-out test is binary — a
			 * window projected to fill even slightly slower than its own length
			 * never goes dead in any projected cycle — so a small pace change can
			 * flip the outcome between a finite runway and beyond-horizon (a night
			 * of idle time has done exactly that). When some probed uniform
			 * burn-rate multiplier (whole-percent grid steps up to the probe cap)
			 * makes the scan finite, this carries the smallest such probed
			 * multiplier and the run-out instant the scan reports at it.
			 *
			 * Absent when NO PROBED multiplier flips the scan — a grid claim, not
			 * a continuous one: modeled reset-credit timing can in principle carve
			 * a finite island narrower than a grid step, which the probe would
			 * walk past. Such an island flips back to beyond-horizon a fraction of
			 * a percent higher, so it carries no usable fragility signal either
			 * way.
			 */
			paceMargin?: {
				/** Smallest probed burn-pace multiplier (>1) that turns the scan finite. */
				multiplier: number;
				/** The all-out instant the scan projects AT that multiplier. */
				exhaustsAtMs: number;
			};
	  }
	| {
			kind: "runway";
			exhaustsAtMs: number;
			durationMs: number;
			causes: RunwayCause[];
			unprojectableAccountIds: string[];
			/** See the doc on `out-now`. */
			learningAccountIds?: string[];
			assumedResetCredits?: RunwayAssumedCredits[];
			/**
			 * How much SLOWER the pool would have to burn to stop running out
			 * inside the horizon — the mirror of `paceMargin` on the branch where
			 * the pool is already projected to run out.
			 *
			 * The two exist for one reason between them: a reader deciding whether
			 * to add or shed load needs a signed answer, and `paceMargin` alone
			 * goes absent at exactly the moment the answer stops being "you have
			 * room". Since an outcome is either finite or beyond-horizon and never
			 * both, at most one of the two is ever present, and a scan runs at most
			 * one probe.
			 *
			 * Carries the largest probed multiplier (<1) such that it AND EVERY
			 * PROBED MULTIPLIER BELOW IT clears the horizon — a threshold a reader
			 * can act on, so "cut by at least this much" is a true statement.
			 *
			 * The whole contiguous tail, not the first multiplier that happens to
			 * clear, because safety is NOT monotone in pace: a modelled reset credit
			 * revives a window only when the dead span starts before the credit
			 * expires, and slowing the burn pushes that span later, so a pool can be
			 * safe at 0.71 and unsafe again at 0.60. Publishing the first hit would
			 * hand a reader a sampled point they would then act on as a threshold —
			 * told to cut 29%, they cut 35% and land back in trouble.
			 *
			 * Absent when even the floor still runs out. That is NOT "no deficit":
			 * it means the pool cannot be paced out of trouble within the probe's
			 * range, which is worse than any number here, and a renderer must not
			 * display it as zero.
			 */
			paceDeficit?: {
				/**
				 * Largest burn-pace multiplier (<1) from which every probed slower
				 * pace also clears the horizon.
				 */
				multiplier: number;
			};
	  };

/**
 * How much of the run-out instant is quantisation noise.
 *
 * Providers report utilization as a WHOLE PERCENT, so a reading of "20%" is
 * really anywhere in [19.5, 20.5) — and the lifetime-average projection divides
 * by that number, so the error it carries is proportional to the runway itself.
 * At 20% one day in, half a percent of reading error is about six hours of
 * run-out; deep into a window it is minutes. A single instant states a precision
 * the input never had.
 *
 * An end is `null` when the scan at that perturbation found no run-out inside
 * the horizon — the band is open on that side, not zero-width.
 */
export interface RunwayBand {
	earliestExhaustsAtMs: number | null;
	latestExhaustsAtMs: number | null;
	/** How far each probe moved a whole-percent reading, in percentage points. */
	halfWidthPct: number;
}

/** The account-wide quota windows the runway scan models. */
export type RunwayWindowKind = "five_hour" | "seven_day";

/**
 * One API key's runway row.
 *
 * `@clankermux/core` exports this same shape as `KeyRunway`, the return type of
 * `computeApiKeyRunways` — one declaration, two names, so the computed row and
 * the served row cannot diverge.
 */
export interface RunwayKeyEntry {
	/** null for the synthetic row standing in for the unauthenticated pool. */
	keyId: string | null;
	keyName: string;
	isActive: boolean;
	/** The key's routing pin. Both fields null / empty means unpinned. */
	pin: { accountId: string | null; providers: string[] | null };
	/**
	 * The accounts this key may route to. Ids rather than a count: a consumer
	 * that wants the count can take `.length`, but the ids cannot be recovered
	 * from a number.
	 */
	eligibleAccountIds: string[];
	outcome: RunwayOutcome;
	/**
	 * The quantisation band around THIS key's run-out, or `null`/absent when no
	 * band is stated (see {@link RunwayBand}).
	 *
	 * Per key rather than per response: the dashboard headline picks the worst
	 * STATEABLE key client-side, so a response-level band could bracket a
	 * different key than the one the headline names. `RunwayOutcome` is
	 * deliberately not widened — the band is a claim ABOUT the outcome, not part
	 * of it, and every existing consumer of the union keeps working untouched.
	 */
	band?: RunwayBand | null;
}

export interface RunwayWindowSummary {
	kind: RunwayWindowKind;
	/**
	 * Percent of the window consumed, or `null` when there is no reading. NEVER
	 * 0 on an absent or failed read — 0 means "measured, nothing used".
	 */
	utilizationPct: number | null;
	resetsAtMs: number | null;
	/**
	 * The server regression for this window, or `null` when the estimator has no
	 * established trend (`insufficient_data`, whose `slopePerHour` is a
	 * placeholder 0 that must never be served as a measured slope).
	 */
	prediction: UsagePrediction | null;
	/**
	 * True when the window has not started: it reads 0% and its structural start
	 * coincides with the observation, because the provider slides
	 * `resets_at = now + duration` on every poll until the first request pins it.
	 * `resetsAtMs` is then a sliding placeholder and NEVER a deadline. Omitted
	 * otherwise.
	 */
	unstarted?: boolean;
}

export interface RunwayAccountSummary {
	id: string;
	name: string;
	provider: string;
	/**
	 * False when the provider exposes no account-wide quota window at all
	 * (ollama, pay-as-you-go). Disambiguates an empty `windows` from "metered but
	 * currently unreadable".
	 */
	metered: boolean;
	/**
	 * When the reading behind `windows` was sampled, or `null` when no window
	 * carries a utilization — an "as of" for a value that was never reported
	 * would dress an absent read up as a resolved one.
	 */
	usageAsOfMs: number | null;
	/**
	 * Every window this provider supports, values nullable. An ABSENT window
	 * therefore means "this provider has no such window", never "we could not
	 * read it".
	 */
	windows: RunwayWindowSummary[];
}

export interface RunwayResponse {
	generatedAt: number;
	/** The horizon the scan modelled, so no client hardcodes 14 days. */
	horizonMs: number;
	/**
	 * The key whose runway is worst across ACTIVE keys. Null when the worst row
	 * is the synthetic unauthenticated-pool row, or no key is active.
	 */
	worstKeyId: string | null;
	keys: RunwayKeyEntry[];
	/**
	 * Every account, whether or not any key can reach it. `outcome.causes` and
	 * `unprojectableAccountIds` carry ids only; names resolve through here rather
	 * than being duplicated per cause.
	 */
	accounts: RunwayAccountSummary[];
}
