// RELATIVE imports, never the "@clankermux/core" barrel — see the note at the
// top of `pool-usage.ts`. A module importing its own package entry is a cycle.

import {
	type RunwayAccountSource,
	scopedFamilyReadings,
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
	windowEvidence,
} from "./capacity-runway";
import type { ModelFamily } from "./model-mappings";
import { compareServableClasses, servableClassFor } from "./pool-classes";

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
 * How well-evidenced the row's STATED OUTCOME is — a different claim from
 * {@link HeadroomBasis}, which says whether the headroom is exact or a bound.
 *
 * `measured` means every window the outcome rests on carries a full-confidence
 * estimate: the account-wide policy of a lifetime estimator selected on
 * held-out backtests, anchored to the reading's observation time, with burn
 * anchors to absorb mid-window gift resets. `structural` means at least one of
 * them does not — typically a scoped family window, which has no prediction and
 * no anchor and so drifts LATER between scans while a reading is stale, but a
 * class row earns it too when its weekly window has no honest observation time.
 * Optimistic drift is the expensive direction, so a row carrying it says so.
 *
 * Scoped to the windows that actually CONTRIBUTE dead time. A window projected
 * never to fill cannot have moved the outcome, and counting it would mark
 * almost every row weak on evidence the answer does not depend on.
 */
export type ProjectionBasis = "measured" | "structural";

export interface WorkloadHeadroomRow {
	dimensionKind: WorkloadDimensionKind;
	/** Servable class id, or model family id. Stable join key. */
	dimensionId: string;
	/** What the workload is called on screen — the models, not the vendor. */
	label: string;
	/**
	 * The scan at the MEASURED pace.
	 *
	 * Free of the burn-share unknown on every row, family rows included: at pace
	 * 1 no window is scaled, so the share cannot reach it. That is why the
	 * headroom is a bound on a family row and this is not.
	 *
	 * It is still a LOWER BOUND whenever {@link unreadableAccountIds} is
	 * non-empty, for a different reason: an account the scan could not project
	 * from is excluded, and excluding one can only bring the all-out instant
	 * earlier. Read the two fields together.
	 */
	outcome: RunwayOutcome;
	headroom: { pct: number; direction: "margin" | "deficit" } | null;
	basis: HeadroomBasis;
	headroomAbsence: HeadroomAbsence | null;
	projectionBasis: ProjectionBasis;
	/**
	 * Accounts considered for this workload, in input order.
	 *
	 * NOT the same as the accounts the scan projected from: an account with no
	 * readable window is counted here and excluded from the pool, and shows up in
	 * {@link unreadableAccountIds}. Publishing only the first number would let a
	 * row claim five accounts of depth behind a projection built on three.
	 */
	eligibleAccountIds: string[];
	/**
	 * Of those, the ones the scan could not project from — no readable window at
	 * all, or (on a family row) no usable scoped reading for this family.
	 *
	 * Their exclusion can only SHORTEN the runway, so an outcome carrying them is
	 * a lower bound rather than a fabricated number. It is also the reason a
	 * family row's baseline outcome is conservative rather than exact: the burn
	 * share cannot reach a pace-1 scan, but a missing account can.
	 */
	unreadableAccountIds: string[];
	/** Of the eligible ones, those already at or past 100% on any pooled window. */
	spentAccountIds: string[];
}

/** Utilization at or above which a window counts as already spent. */
const SPENT_THRESHOLD_PCT = 100;

/**
 * Accounts that cannot serve this workload right now, over ANY of the windows
 * the row's scan pooled.
 *
 * The union, not one named window: either account-wide window blocks routing,
 * and a family's scoped window blocks it for that family. Testing only the
 * weekly one let an account sitting at 100% of its 5-hour quota be counted as
 * having room — the row's own outcome would read `out-now` beside a spent count
 * of zero.
 */
function spentAccountIds(inputs: readonly RunwayAccountInput[]): string[] {
	return inputs
		.filter((input) =>
			input.windows.some(
				(window) => window.utilizationPct >= SPENT_THRESHOLD_PCT,
			),
		)
		.map((input) => input.accountId);
}

/**
 * How well-evidenced a row's projection is, DERIVED from the estimates rather
 * than assumed from the row's kind.
 *
 * A class row is not automatically `measured`: a weekly window with no honest
 * observation time falls back to the amber-capped now-anchored estimate, and a
 * 5-hour window with no usable regression lands on the same low-confidence
 * path. Hardcoding `measured` there claimed evidence the scan did not have. A
 * family row still comes out `structural` on its own merits, because a scoped
 * window has neither a prediction nor an anchor to reach full confidence with.
 *
 * The extra estimator pass is cheap next to the probe it sits beside: one
 * estimate per window, against up to 50 pool rebuilds.
 */
function projectionBasisFor(
	inputs: readonly RunwayAccountInput[],
	now: number,
	horizonMs: number,
): ProjectionBasis {
	for (const input of inputs) {
		for (const window of input.windows) {
			const evidence = windowEvidence(window, now, horizonMs);
			// A window that contributes no dead time did not move this outcome, so
			// the confidence of its estimate is not this row's problem. Counting it
			// would mark almost every row weak on the strength of a 5-hour window
			// projected never to fill.
			if (!evidence.contributes) continue;
			if (evidence.lowConfidence) return "structural";
		}
	}
	return "measured";
}

/** The accounts a scan could not project from, on the kinds that report them. */
function unprojectableOf(outcome: RunwayOutcome): string[] {
	return "unprojectableAccountIds" in outcome
		? outcome.unprojectableAccountIds
		: [];
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
			projectionBasis: projectionBasisFor(inputs, now, horizonMs),
			eligibleAccountIds: inputs.map((input) => input.accountId),
			unreadableAccountIds: unprojectableOf(outcome),
			spentAccountIds: spentAccountIds(inputs),
		});
	}

	// Family DISCOVERY reads exactly the source family WINDOW BUILDING reads.
	// They were split once — discovery looked only at `usageData`, which the
	// server's scan deliberately leaves null — and the whole family dimension
	// came out empty in production while every test passed.
	const familyLabels = new Map<ModelFamily, string>();
	for (const account of accounts) {
		for (const limit of scopedFamilyReadings(account, now) ?? []) {
			if (!familyLabels.has(limit.family)) {
				familyLabels.set(limit.family, limit.displayName);
			}
		}
	}

	for (const [family, displayName] of familyLabels) {
		const inputs: RunwayAccountInput[] = [];
		const unreadable: string[] = [];
		for (const account of accounts) {
			const input = toScopedFamilyRunwayInput(account, family, now);
			if (input) inputs.push(input);
			// Only an account that could otherwise have served this family counts as
			// unreadable. A Codex account has no Claude family window to be missing.
			else if (scopedFamilyReadings(account, now) !== null) {
				unreadable.push(account.id);
			}
		}

		// The family is live — some account reported it — but nothing about it can
		// be projected. That is `unknown`, and it is reported. Skipping the row
		// instead would make a family whose readings were all rejected silently
		// vanish, which reads as "no such limit".
		const bound =
			inputs.length === 0
				? {
						outcome: { kind: "unknown" } as RunwayOutcome,
						headroom: null,
						absence: "not-projected" as HeadroomAbsence,
					}
				: familyHeadroomBound(inputs, family, now, horizonMs);

		rows.push({
			dimensionKind: "family",
			dimensionId: family,
			label: displayName,
			outcome: bound.outcome,
			headroom: bound.headroom,
			basis: "conservative-bound",
			headroomAbsence: bound.absence,
			projectionBasis: projectionBasisFor(inputs, now, horizonMs),
			eligibleAccountIds: inputs.map((input) => input.accountId),
			unreadableAccountIds: [...unreadable, ...unprojectableOf(bound.outcome)],
			spentAccountIds: spentAccountIds(inputs),
		});
	}

	return rows;
}
