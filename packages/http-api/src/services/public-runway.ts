import { effectiveRunwayOutcome, summarizeKeyRunways } from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import type { RunwayCause } from "@clankermux/types";
import { computeRunwayScan } from "./runway-scan";

/**
 * The de-identified, POOL-LEVEL projection of the quota-runway scan.
 *
 * SAME SCAN as `GET /api/runway`, not a second one. `computeRunwayScan` resolves
 * every account's usage through the documented freshness tiers, regresses the
 * stored history and runs the capacity model; recomputing any of that here is
 * how a widget comes to disagree with the dashboard about when the quota runs
 * out. The entire difference between the two responses is what each is ALLOWED
 * to say.
 *
 * What this one may not say, and why:
 *
 *  - API KEY IDENTITY. `/api/runway` reports a row per key with its `keyName`
 *    (they look like `"impatience (claude)"`), its routing `pin` and its
 *    `eligibleAccountIds`. All three are management data, this surface is
 *    unauthenticated, and the per-key breakdown is array levels past what the
 *    device's streaming scanner can descend into. Only AGGREGATE COUNTS of keys
 *    survive.
 *  - PER-ACCOUNT EVIDENCE. `/api/runway` carries every account's windows,
 *    utilizations, resets and observation times. That is
 *    `GET /public/v1/accounts`'s job, and serving it twice would put one
 *    measurement in two places for the two to drift apart. A cause that
 *    REFERENCES an account id is a resource reference, which is a different
 *    thing and is kept.
 *
 * QUOTA, not availability: pauses, rate-limit cooldowns, usage throttling and
 * the provider-overload breaker are deliberately not read by the scan. Copy
 * built on this must say "quota", never "available".
 *
 * NO PROVIDER I/O, like every other route on this surface: the scan reads the
 * database and the in-memory usage cache (through the non-evicting `peekWithAge`
 * and a bounded stored-payload lookup) and nothing else.
 */

/**
 * How much of the pool the headline figure actually speaks for.
 *
 * These counts are not decoration. A key whose accounts have no readable window
 * is UNSTATEABLE, and it is excluded from the ranking precisely so one blind key
 * cannot take the whole headline to "unknown". The cost of that exclusion is
 * that the published figure is an UPPER BOUND: the hidden key might be the worst
 * one. A client that renders `worstStatedOutcome` without `unobservedKeyCount`
 * beside it is claiming more than it knows.
 */
export interface PublicRunwayCoverage {
	/**
	 * Active API keys the scan covered. With NO active key, authentication is off
	 * and every request routes over the unpinned pool, which the scan models as
	 * exactly one synthetic row — so this reads 1 rather than 0. That is the pool
	 * being counted once, not a phantom key.
	 */
	activeKeyCount: number;
	/** Those whose outcome could be stated. */
	statedKeyCount: number;
	/** Those whose accounts had no readable window. The two counts sum. */
	unobservedKeyCount: number;
}

/** The worst stateable outcome, stripped to the pool-level facts. */
export interface PublicWorstOutcome {
	/** `RunwayOutcome["kind"]`, internal spelling. Mapped by the DTO layer. */
	kind: string;
	/** Projected all-out instant, or null on every kind that has none. */
	exhaustsAtMs: number | null;
	/** The account + window that runs out at that instant. */
	causes: RunwayCause[];
}

export interface PublicRunwaySnapshot {
	generatedAtMs: number;
	/** The horizon the scan modelled, so no client hardcodes 14 days. */
	horizonMs: number;
	coverage: PublicRunwayCoverage;
	/** Null when nothing anywhere could be stated. */
	worstStatedOutcome: PublicWorstOutcome | null;
}

export function createPublicRunwayReader(dbOps: DatabaseOperations) {
	return async (): Promise<PublicRunwaySnapshot> => {
		const scan = await computeRunwayScan(dbOps);
		const headline = summarizeKeyRunways(scan.keys, scan.generatedAt);

		// The outcome AS IT STANDS at `generatedAt`, not as the scan recorded it.
		// A `runway` whose projected instant has already passed is not a runway of
		// zero and is not still counting down — its own answer is that there is no
		// quota — so it reads as `out-now`. `summarizeKeyRunways` RANKS by this
		// same effective view, and publishing the raw outcome instead would let
		// the served kind contradict the ranking that chose it.
		const outcome = headline.worst
			? effectiveRunwayOutcome(headline.worst.outcome, scan.generatedAt)
			: null;

		return {
			generatedAtMs: scan.generatedAt,
			horizonMs: scan.horizonMs,
			coverage: {
				activeKeyCount: headline.activeKeyCount,
				statedKeyCount: headline.statedKeyCount,
				unobservedKeyCount: headline.unobservedKeyCount,
			},
			worstStatedOutcome: outcome
				? {
						kind: outcome.kind,
						exhaustsAtMs:
							outcome.kind === "runway" ? outcome.exhaustsAtMs : null,
						// Named explicitly rather than spread: `beyond-horizon` carries
						// `unprojectableAccountIds` and `runway` carries a `durationMs`
						// that is already implied by the instant, and neither belongs on
						// this surface.
						causes:
							outcome.kind === "runway" || outcome.kind === "out-now"
								? outcome.causes
								: [],
					}
				: null,
		};
	};
}

export type PublicRunwayReader = ReturnType<typeof createPublicRunwayReader>;
