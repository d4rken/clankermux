// RELATIVE imports, never the "@clankermux/core" barrel — see the note at the
// top of `pool-usage.ts`. A module importing its own package entry is a cycle.

import {
	type RunwayAccountSource,
	scopedWeeklyWindowKind,
	toRunwayAccountInput,
	toScopedFamilyRunwayInput,
} from "./api-key-runway";
import {
	computeCapacityRunway,
	RUNWAY_HORIZON_MS,
	type RunwayAccountInput,
	type RunwayOutcome,
	runwayPaceHeadroom,
} from "./capacity-runway";
import type { ModelFamily } from "./model-mappings";
import { compareServableClasses, servableClassFor } from "./pool-classes";
import { listLiveScopedFamilies } from "./pool-usage";

/**
 * "Can I add another agent of THIS kind of work?", answered per workload rather
 * than for the pool as a whole.
 *
 * The pool-level figure on `/public/v1/runway` answers one question well: can
 * the pool's current aggregate workload grow. It cannot answer the question a
 * person actually asks, which names a workload — another GPT agent, another
 * Fable-heavy agent — because two things it does not model stand in the way.
 * It pools every account together, so a Claude account's headroom silently
 * covers for a Codex one that nothing can cover for; and it reads only
 * account-wide quota windows, so a per-model-family limit that is already spent
 * is invisible to it. On the pool this was written against, Fable sat at 100%
 * on two of five Claude accounts while the pool-level figure reported a 32%
 * margin. Both were correct about different questions.
 *
 * TWO DIMENSIONS, and the difference between them is not cosmetic:
 *
 *  - A CLASS row (Claude, GPT) is an exact threshold. The accounts in a class
 *    can genuinely cover for each other, every window they have is varied
 *    together, and the result means the same thing the pool-level figure means.
 *  - A FAMILY row (Fable) is a BOUND, because the exact answer is not derivable
 *    from recorded data. See {@link familyHeadroomBound} for the argument.
 *
 * Rows carry {@link WorkloadHeadroomRow.basis} so nothing downstream can render
 * the second as though it were the first.
 */

/** Whether a row describes a servable class or a scoped model family. */
export type WorkloadDimensionKind = "class" | "family";

/**
 * Whether the row's headroom is the threshold itself or a bound on it.
 *
 * `exact` still carries the grid semantics the probes document: the figure is
 * the first 1% grid step at which the verdict flips, which can sit up to one
 * step past the continuous threshold. `conservative-bound` adds an unknown on
 * top of that, and errs toward advising restraint.
 */
export type HeadroomBasis = "exact" | "conservative-bound";

/** Why a row states no headroom. Never a stand-in for zero. */
export type HeadroomAbsence =
	/**
	 * The probe walked its whole range without the verdict flipping. Which end
	 * of the scale that is depends on the outcome: on a `beyond-horizon` the
	 * pool is robust past the probe cap, on a `runway` no slowdown in range
	 * clears the horizon.
	 */
	| "beyond-probe-range"
	/** `out-now`, `unknown` or `no-accounts`: no projection to vary. */
	| "not-projected"
	/**
	 * A family row whose pool carries a modelled reset-credit bank. The bound
	 * argument needs faster burn to imply a superset of dead time, and credits
	 * break exactly that: a faster pace moves a dead span's start earlier, which
	 * can pull it inside a credit's expiry and REVIVE the window. Dead sets stop
	 * nesting, so neither end of the share range dominates the other and no
	 * single scan bounds the answer.
	 */
	| "bound-broken-by-credits";

/**
 * How well-evidenced the projection under a row is.
 *
 * `measured` is the account-wide windows' policy: a lifetime estimator selected
 * on held-out backtests, anchored to the reading's observation time, with burn
 * anchors to absorb mid-window gift resets. `structural` is what a scoped family
 * window gets, because none of those exist per family — no prediction, no
 * anchor, and a now-anchored ETA that therefore drifts LATER between scans when
 * the reading is stale. Optimistic drift is the expensive direction, so a row
 * carrying it has to say so.
 */
export type ProjectionBasis = "measured" | "structural";

export interface WorkloadHeadroomRow {
	dimensionKind: WorkloadDimensionKind;
	/** Servable class id, or model family id. Stable join key. */
	dimensionId: string;
	/** What the workload is called on screen — the models, not the vendor. */
	label: string;
	/**
	 * The scan at the MEASURED pace. Exact on every row, family rows included:
	 * at pace 1 no window is scaled, so the unknown burn share cannot reach it.
	 * Only the headroom below is ever a bound.
	 */
	outcome: RunwayOutcome;
	headroom: { pct: number; direction: "margin" | "deficit" } | null;
	basis: HeadroomBasis;
	headroomAbsence: HeadroomAbsence | null;
	projectionBasis: ProjectionBasis;
	/** Accounts the scan actually pooled, in input order. */
	eligibleAccountIds: string[];
	/** Of those, the ones whose binding window is already at or past 100%. */
	spentAccountIds: string[];
}

/** Utilization at or above which a window counts as already spent. */
const SPENT_THRESHOLD_PCT = 100;

function spentAccountIds(
	inputs: readonly RunwayAccountInput[],
	windowKind: string,
): string[] {
	return inputs
		.filter((input) =>
			input.windows.some(
				(window) =>
					window.windowKind === windowKind &&
					window.utilizationPct >= SPENT_THRESHOLD_PCT,
			),
		)
		.map((input) => input.accountId);
}

function absenceFor(outcome: RunwayOutcome): HeadroomAbsence {
	return outcome.kind === "beyond-horizon" || outcome.kind === "runway"
		? "beyond-probe-range"
		: "not-projected";
}

/**
 * The headroom bound for one model family, and the argument for why each side
 * uses a different scan.
 *
 * The question is marginal: if only THIS family's load changes by a factor m,
 * how does the pool fare. That needs f, the family's share of the account-wide
 * burn — the scoped window scales by m, but the account-wide windows scale by
 * only `1 + f(m - 1)`. f is not derivable from what this proxy records:
 * `docs/ledger-burn-feasibility.md` measured the token-to-percent relation as
 * indistinguishable from a future-token placebo, and the entry requirement it
 * failed on (resolution finer than the provider's 1% grid) is still unmet.
 *
 * f is nonetheless bounded in [0, 1], and the PESSIMISTIC end differs by side:
 *
 *  - MARGIN (m > 1, "can I run more"): `1 + f(m - 1) <= m`, so assuming f = 1
 *    and scaling every window together burns the account-wide windows at least
 *    as fast as reality. Faster burn moves every dead span's start earlier and
 *    leaves its reset end fixed, so the dead set is a superset, and the first
 *    all-accounts-dead instant cannot move later. The margin found is therefore
 *    no larger than the true one.
 *  - DEFICIT (m < 1, "how much must I cut"): the inequality flips. Scaling
 *    everything would relieve the account-wide windows more than a
 *    family-only cut does, and would report a SMALLER required cut than the
 *    truth — optimistic, the expensive direction. The pessimistic end here is
 *    f = 0: pace the scoped window alone and hold account-wide burn where it
 *    is. Cutting the family then relieves nothing else, and the cut reported is
 *    no smaller than the true one.
 *
 * With several unknown shares (weekly and 5-hour) the ordering is
 * coordinatewise, so the joint pessimistic corner is still all-ones on the
 * margin side and all-zeros on the deficit side.
 *
 * The superset step is what reset credits break, which is why a pool carrying a
 * modelled bank gets no bound at all rather than a quietly wrong one.
 */
function familyHeadroomBound(
	inputs: RunwayAccountInput[],
	family: ModelFamily,
	now: number,
	horizonMs: number,
): {
	outcome: RunwayOutcome;
	headroom: { pct: number; direction: "margin" | "deficit" } | null;
	absence: HeadroomAbsence | null;
} {
	// Pace 1 everywhere, so this is exact whatever the true share is. Probes off:
	// which probe is even the right one is not known until the kind is.
	const baseline = computeCapacityRunway(inputs, now, horizonMs, {
		probePaceMargin: false,
	});

	if (
		inputs.some((input) => (input.codexResetCredits?.credits.length ?? 0) > 0)
	) {
		return {
			outcome: baseline,
			headroom: null,
			absence: "bound-broken-by-credits",
		};
	}

	// The margin side varies everything (f = 1); the deficit side varies only
	// this family's own window (f = 0).
	const pacedWindowKinds =
		baseline.kind === "runway"
			? new Set([scopedWeeklyWindowKind(family)])
			: null;
	const probed =
		baseline.kind === "beyond-horizon" || baseline.kind === "runway"
			? computeCapacityRunway(inputs, now, horizonMs, { pacedWindowKinds })
			: baseline;

	const headroom = runwayPaceHeadroom(probed);
	return {
		// The BASELINE outcome, never the probed one: a probe's `exhaustsAtMs` is
		// an instant under a hypothetical the true shares may not produce.
		outcome: baseline,
		headroom,
		absence: headroom === null ? absenceFor(baseline) : null,
	};
}

/**
 * Per-workload headroom rows: one per servable class, one per live scoped model
 * family.
 *
 * Cost is close to one extra pool-level scan in total, not one per row: a probe
 * is bounded at 50 pool rebuilds and a rebuild is linear in accounts, so
 * summing over a partition of the accounts costs about what a single scan over
 * all of them costs. Family rows add one more pass over the accounts that
 * report a scoped window.
 */
export function computeWorkloadHeadroom(
	accounts: readonly RunwayAccountSource[],
	now: number,
	horizonMs: number = RUNWAY_HORIZON_MS,
): WorkloadHeadroomRow[] {
	const rows: WorkloadHeadroomRow[] = [];

	const byClass = new Map<
		string,
		{ label: string; accounts: RunwayAccountSource[] }
	>();
	for (const account of accounts) {
		const servable = servableClassFor(account.provider);
		const bucket = byClass.get(servable.classId);
		if (bucket) bucket.accounts.push(account);
		else
			byClass.set(servable.classId, {
				label: servable.label,
				accounts: [account],
			});
	}

	const classIds = [...byClass.keys()].sort(compareServableClasses);
	for (const classId of classIds) {
		const bucket = byClass.get(classId);
		if (!bucket) continue;
		const inputs = bucket.accounts.map(toRunwayAccountInput);
		const outcome = computeCapacityRunway(inputs, now, horizonMs);
		const headroom = runwayPaceHeadroom(outcome);
		rows.push({
			dimensionKind: "class",
			dimensionId: classId,
			label: bucket.label,
			outcome,
			headroom,
			basis: "exact",
			headroomAbsence: headroom === null ? absenceFor(outcome) : null,
			projectionBasis: "measured",
			eligibleAccountIds: inputs.map((input) => input.accountId),
			spentAccountIds: spentAccountIds(inputs, "seven_day"),
		});
	}

	for (const live of listLiveScopedFamilies(accounts, now)) {
		const inputs: RunwayAccountInput[] = [];
		for (const account of accounts) {
			const input = toScopedFamilyRunwayInput(account, live.family, now);
			if (input) inputs.push(input);
		}
		// No account states this family's window, so there is nothing to say about
		// it — not a row claiming unknown capacity.
		if (inputs.length === 0) continue;

		const bound = familyHeadroomBound(inputs, live.family, now, horizonMs);
		rows.push({
			dimensionKind: "family",
			dimensionId: live.family,
			label: live.displayName,
			outcome: bound.outcome,
			headroom: bound.headroom,
			basis: "conservative-bound",
			headroomAbsence: bound.absence,
			projectionBasis: "structural",
			eligibleAccountIds: inputs.map((input) => input.accountId),
			spentAccountIds: spentAccountIds(
				inputs,
				scopedWeeklyWindowKind(live.family),
			),
		});
	}

	return rows;
}
