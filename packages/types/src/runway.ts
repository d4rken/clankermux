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

export type RunwayOutcome =
	| { kind: "no-accounts" }
	| { kind: "unknown" }
	| {
			kind: "out-now";
			causes: RunwayCause[];
			unprojectableAccountIds: string[];
	  }
	| {
			kind: "beyond-horizon";
			horizonMs: number;
			unprojectableAccountIds: string[];
	  }
	| {
			kind: "runway";
			exhaustsAtMs: number;
			durationMs: number;
			causes: RunwayCause[];
			unprojectableAccountIds: string[];
	  };

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
