import { makePrng } from "./prediction-backtest";

/**
 * Does the recorded request ledger line up with the quota readings at all?
 *
 * THE GATE, NOT THE ESTIMATOR. Nothing here produces a capacity number, no
 * coefficient it fits is used to predict anything anywhere, and no server code
 * imports it. It answers one question, declared before it was ever run: does
 * attaching each interval's OWN requests to it explain the reported utilization
 * change better than attaching deliberately wrong requests? A no closes the
 * capacity-estimation programme; a yes is permission to start it, and nothing
 * more.
 *
 * WHY IT IS NOT THE 2026-08 STUDY. `ledger-feasibility.ts` asked a related
 * question of the two-minute POLLED snapshot series and answered NOT FEASIBLE.
 * Two things changed: `requests.usage_finalized_at` records when a persistable
 * token vector became known, and `unified_claim_observations` records the
 * rate-limit claim header on EVERY request. The header sits on the same 1 %
 * grid as the snapshots, so it adds no resolution — what it adds is one
 * reading per request instead of one per two minutes. The old study's binning,
 * era stratification and capability matrix are not reused; the observation unit
 * and the timing model are different, and stapling this onto that module would
 * make one file answer two questions with two meanings of a bin.
 *
 * WHAT THE TIMESTAMPS ACTUALLY MEAN, because the design turns on it:
 *
 *  - `observed_at` is when the response HEADERS ARRIVED. It is not when the
 *    provider charged anything.
 *  - `usage_finalized_at` is when the first persistable token vector became
 *    known to us. A later revision of that vector keeps the first timestamp.
 *  - Requests run CONCURRENTLY and provider accounting is delayed and may
 *    reorder, so a header whose utilization has changed identifies the first
 *    change we OBSERVED, never the request that caused it.
 *
 * That last point is why this study does not try to attribute a crossing to a
 * request. It asks the weaker, answerable question about fixed intervals, and
 * every "alignment" below is a rule for choosing WHICH requests an interval is
 * scored against.
 *
 * WHY INTERVALS AND NOT THE GAPS BETWEEN CROSSINGS. An earlier design scored
 * the blocks between consecutive 1 % crossings. It is circular: the blocks are
 * selected by the outcome, so each holds ~1 % of consumption by construction,
 * the dependent variable has almost no variance left, and shifting whole blocks
 * merely permutes their token vectors — a control that a physically correct
 * model could fail and a wrong one could pass. Fixed wall-clock intervals
 * chosen without reference to where the crossings fall, KEEPING the intervals
 * that did not move, is what puts the variance back.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// Declared constants — every number this study judges anything by
// ---------------------------------------------------------------------------

/** Width of a scored interval. Declared before the run; never swept. */
export const INTERVAL_MS = 10 * MINUTE_MS;

/**
 * Half-width of the truth band around a reported step.
 *
 * The provider reports utilization on a 1 % grid, so an interval whose readings
 * differ by `d` points is consistent with any true consumption within a point
 * of `d`. A prediction inside that band is as right as this data can show.
 */
export const QUANTIZATION_BAND_PCT = 1;

/** An interval needs at least this many readings to state a change at all. */
export const MIN_READINGS_PER_UNIT = 2;

/** Below this many evaluation units a cohort states nothing, and says so. */
export const MIN_EVALUATION_UNITS = 100;

/** Bootstrap resamples for the paired median difference. */
export const BOOTSTRAP_ITERATIONS = 1000;

/** Seed for every resample. Fixed, so two runs of one dataset agree exactly. */
export const DEFAULT_SEED = 20260908;

/**
 * Prices the synthetic POSITIVE fixture generates its percentages from, chosen
 * so a busy interval moves about two points — the scale the real readings move
 * at, and enough to survive the 1 % reporting grid. Fixture parameters only:
 * no criterion reads them, and they are not an estimate of anything.
 */
export const SYNTHETIC_INPUT_PRICE = 1.5e-5;
export const SYNTHETIC_OUTPUT_PRICE = 5e-5;

/** Iterations the non-negative fit may take before it gives up. */
export const MAX_FIT_ITERATIONS = 200_000;

/**
 * KKT residual below which the fit is called converged, on the column-scaled
 * problem where every feature is at most 1 and the target is in points.
 */
export const FIT_CONVERGENCE_TOLERANCE = 1e-9;

/** Below this many independent clusters the bootstrap states no interval. */
export const MIN_BOOTSTRAP_CLUSTERS = 5;

/** Shifted-source controls, in whole intervals either side. */
export const SHIFT_SLOTS: readonly number[] = [1, 3];

/** Token classes the fit weighs, in column order. */
export const TOKEN_CLASSES = [
	"input",
	"output",
	"cache_read",
	"cache_creation",
] as const;
export type TokenClass = (typeof TOKEN_CLASSES)[number];

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One claim-header reading, as `unified_claim_observations` records it. */
export interface AlignmentObservation {
	accountId: string;
	/** `5h`, `7d`, `7d_oi`; one study run scores ONE claim. */
	claim: string;
	/** Header-arrival instant. */
	observedAt: number;
	/** Fraction in [0, 1] on a 0.01 grid, as recorded. */
	utilization: number;
	/** The window instance this reading belongs to; null readings are dropped. */
	resetAt: number | null;
}

/** One request's token vector, placed at the instant its usage became known. */
export interface AlignmentRequest {
	accountId: string;
	/** `usage_finalized_at`; see the module doc for what it does and does not mean. */
	finalizedAt: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
}

/**
 * One scored interval.
 *
 * `deltaPct` is the change between the FIRST and LAST reading inside it, which
 * is what the interval can state; readings between them are not used, because
 * a finer step would be below the reporting grid.
 */
export interface AlignmentUnit {
	accountId: string;
	/**
	 * The window instance this interval sits in.
	 *
	 * Part of the unit's IDENTITY, not decoration: a reset inside a slot puts two
	 * scorable intervals on the same account at the same wall clock, and keying
	 * them by account and start alone collapses them — one overwrites the
	 * other's error while both are still counted, and the permutation can hand a
	 * unit back to itself.
	 */
	resetAt: number;
	fromMs: number;
	toMs: number;
	deltaPct: number;
	readings: number;
	/** Highest utilization seen in the interval, for the saturation cohort. */
	peakUtilization: number;
}

/** What a fit produced, and whether it actually finished. */
export interface FitResult {
	weights: number[];
	/** False when the iteration budget ran out with the KKT residual still above tolerance. */
	converged: boolean;
	iterations: number;
}

export interface BuildUnitsResult {
	units: AlignmentUnit[];
	/** Intervals whose readings straddled a drop — a refund, credit or missed reset. */
	droppedNegative: number;
	/** Intervals with a single reading, which can state no change. */
	droppedSingleReading: number;
	/** Readings with no `resetAt`, which cannot be placed in a window instance. */
	droppedUnplaceable: number;
	/**
	 * Intervals dropped because their slot held readings from two window
	 * instances. Both would have read the same ten minutes of requests, and the
	 * slot cannot be divided between them without knowing where the reset fell.
	 */
	droppedStraddlingReset: number;
}

/**
 * Split readings into fixed intervals, one interval per (account, window
 * instance, slot).
 *
 * Grouping by `resetAt` is what keeps an interval inside one window instance:
 * an interval spanning a reset would report a fall to zero as consumption.
 * Recorded resets are stable per instance rather than jittering per reading, so
 * an exact grouping is right here and no tolerance is needed.
 */
export function buildUnits(
	observations: readonly AlignmentObservation[],
	claim: string,
): BuildUnitsResult {
	const byKey = new Map<string, AlignmentObservation[]>();
	let droppedUnplaceable = 0;
	for (const observation of observations) {
		if (observation.claim !== claim) continue;
		if (!Number.isFinite(observation.utilization)) continue;
		if (observation.resetAt == null) {
			droppedUnplaceable++;
			continue;
		}
		const slot = Math.floor(observation.observedAt / INTERVAL_MS);
		const key = `${observation.accountId}::${observation.resetAt}::${slot}`;
		const bucket = byKey.get(key) ?? [];
		byKey.set(key, bucket);
		bucket.push(observation);
	}
	// A slot that holds readings from two window instances would produce two
	// units at one wall clock, and BOTH would read the same ten minutes of
	// requests — the source interval is the slot, and it cannot be divided
	// between them without knowing where in the slot the reset fell. Distinct
	// identities are not enough: the two would answer with identical features,
	// and the permutation could hand one to the other. They are dropped.
	const slotsWithSeveralWindows = new Set<string>();
	const windowsPerSlot = new Map<string, Set<number>>();
	for (const key of byKey.keys()) {
		const [accountId, resetAt, slot] = key.split("::");
		const slotKey = `${accountId}::${slot}`;
		const seen = windowsPerSlot.get(slotKey) ?? new Set<number>();
		windowsPerSlot.set(slotKey, seen);
		seen.add(Number(resetAt));
		if (seen.size > 1) slotsWithSeveralWindows.add(slotKey);
	}
	const units: AlignmentUnit[] = [];
	let droppedNegative = 0;
	let droppedSingleReading = 0;
	let droppedStraddlingReset = 0;
	for (const [key, bucket] of byKey) {
		const [keyAccountId, , keySlot] = key.split("::");
		if (slotsWithSeveralWindows.has(`${keyAccountId}::${keySlot}`)) {
			droppedStraddlingReset++;
			continue;
		}
		if (bucket.length < MIN_READINGS_PER_UNIT) {
			droppedSingleReading++;
			continue;
		}
		bucket.sort((a, b) => a.observedAt - b.observedAt);
		const first = bucket[0];
		const last = bucket[bucket.length - 1];
		const deltaPct = (last.utilization - first.utilization) * 100;
		// A fall is a refund, an applied credit, or a reset this grouping did not
		// see. None of them is consumption, and modelling them is not this gate's
		// question — they are counted rather than silently absorbed.
		if (deltaPct < 0) {
			droppedNegative++;
			continue;
		}
		const slot = Math.floor(first.observedAt / INTERVAL_MS);
		units.push({
			accountId: first.accountId,
			resetAt: first.resetAt as number,
			fromMs: slot * INTERVAL_MS,
			toMs: (slot + 1) * INTERVAL_MS,
			deltaPct,
			readings: bucket.length,
			peakUtilization: bucket.reduce(
				(max, o) => Math.max(max, o.utilization),
				0,
			),
		});
	}
	units.sort(
		(a, b) =>
			a.fromMs - b.fromMs ||
			a.accountId.localeCompare(b.accountId) ||
			a.resetAt - b.resetAt,
	);
	return {
		units,
		droppedNegative,
		droppedSingleReading,
		droppedUnplaceable,
		droppedStraddlingReset,
	};
}

// ---------------------------------------------------------------------------
// Request lookup
// ---------------------------------------------------------------------------

/** Summed token vector plus the request count over one source interval. */
export interface SourceSpend {
	tokens: number[];
	requests: number;
}

const EMPTY_SPEND: SourceSpend = { tokens: [0, 0, 0, 0], requests: 0 };

/** Requests indexed per account and ascending in time, for interval sums. */
export class RequestIndex {
	private readonly byAccount = new Map<string, AlignmentRequest[]>();

	constructor(requests: readonly AlignmentRequest[]) {
		for (const request of requests) {
			const list = this.byAccount.get(request.accountId) ?? [];
			this.byAccount.set(request.accountId, list);
			list.push(request);
		}
		for (const list of this.byAccount.values()) {
			list.sort((a, b) => a.finalizedAt - b.finalizedAt);
		}
	}

	accounts(): string[] {
		return [...this.byAccount.keys()].sort();
	}

	/** Half-open `[fromMs, toMs)`; binary search, so the scan stays linear overall. */
	sum(accountId: string, fromMs: number, toMs: number): SourceSpend {
		const list = this.byAccount.get(accountId);
		if (!list) return EMPTY_SPEND;
		let lo = 0;
		let hi = list.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (list[mid].finalizedAt < fromMs) lo = mid + 1;
			else hi = mid;
		}
		const tokens = [0, 0, 0, 0];
		let requests = 0;
		for (let i = lo; i < list.length && list[i].finalizedAt < toMs; i++) {
			const r = list[i];
			tokens[0] += r.inputTokens;
			tokens[1] += r.outputTokens;
			tokens[2] += r.cacheReadInputTokens;
			tokens[3] += r.cacheCreationInputTokens;
			requests++;
		}
		return { tokens, requests };
	}
}

// ---------------------------------------------------------------------------
// Alignments
// ---------------------------------------------------------------------------

/**
 * A rule for choosing which requests an interval is scored against, and what
 * to make of them.
 *
 * Every alignment answers the same units with the same fit, so the only thing
 * that differs between two rows of the report is the rule itself.
 */
export interface Alignment {
	name: string;
	/** Prose the report prints beside the row. */
	description: string;
	/** Which source interval this rule reads, per unit. */
	source: (
		unit: AlignmentUnit,
		units: readonly AlignmentUnit[],
	) => {
		accountId: string;
		fromMs: number;
		toMs: number;
	} | null;
	/** Turn the source spend into features. Default: the four token sums. */
	features?: (spend: SourceSpend) => number[];
	/** True for the controls a verdict is measured against. */
	control: boolean;
	/** True for the ONE control the rule makes mandatory. */
	mandatory?: boolean;
}

const tokenFeatures = (spend: SourceSpend): number[] => spend.tokens;

/** The alignment under test: an interval's own requests. */
export const REAL_ALIGNMENT = "real";

/** The control the verdict turns on. See {@link ALIGNMENT_RULE}. */
export const MANDATORY_CONTROL = "permuted-within-account";

/** The baseline that asks whether token composition beats counting requests. */
export const COUNT_ONLY_CONTROL = "count-only";

/**
 * Every alignment scored EXCEPT the mandatory permutation, in report order.
 *
 * The permutation is not here because it cannot be built until the cohort is
 * known: it has to draw from the units the cohort actually keeps, and within
 * one half of the split. {@link scoreCohort} owns it for that reason.
 */
export function alignments(): Alignment[] {
	const own = (unit: AlignmentUnit) => ({
		accountId: unit.accountId,
		fromMs: unit.fromMs,
		toMs: unit.toMs,
	});
	const list: Alignment[] = [
		{
			name: REAL_ALIGNMENT,
			description: "the interval's own requests",
			source: own,
			control: false,
		},
		{
			name: COUNT_ONLY_CONTROL,
			description:
				"the interval's own requests, counted rather than weighed by token class",
			source: own,
			features: (spend) => [spend.requests],
			control: true,
		},
	];
	for (const slots of SHIFT_SLOTS) {
		const offset = slots * INTERVAL_MS;
		list.push({
			name: `earlier-${slots}`,
			description: `the same account ${(offset / MINUTE_MS).toFixed(0)} min earlier`,
			source: (unit) => ({
				accountId: unit.accountId,
				fromMs: unit.fromMs - offset,
				toMs: unit.toMs - offset,
			}),
			control: true,
		});
		list.push({
			name: `later-${slots}`,
			description: `the same account ${(offset / MINUTE_MS).toFixed(0)} min later`,
			source: (unit) => ({
				accountId: unit.accountId,
				fromMs: unit.fromMs + offset,
				toMs: unit.toMs + offset,
			}),
			control: true,
		});
	}
	return list;
}

/** The permutation control, over one half's own eligible units. */
export function permutationAlignment(
	permutation: ReadonlyMap<string, AlignmentUnit>,
): Alignment {
	return {
		name: MANDATORY_CONTROL,
		description:
			"another interval of the SAME account and the SAME half of the split, drawn from the units this cohort kept; same account, same slot length, same eligibility, only the pairing is wrong",
		source: (unit) => {
			const other = permutation.get(unitKey(unit));
			return other == null
				? null
				: {
						accountId: other.accountId,
						fromMs: other.fromMs,
						toMs: other.toMs,
					};
		},
		control: true,
		mandatory: true,
	};
}

/** Stable identity of a unit: account, window instance and slot. */
export function unitKey(unit: AlignmentUnit): string {
	return `${unit.accountId}::${unit.resetAt}::${unit.fromMs}`;
}

/**
 * A deterministic derangement of each account's units, WITHIN one stratum.
 *
 * Two properties this has to have, and an earlier version had neither:
 *
 *  - IT MUST NOT CROSS THE TRAIN/EVALUATE BOUNDARY. Rotating across an
 *    account's whole history pairs first-half intervals with second-half ones,
 *    so any change in workload BETWEEN the halves shows up as the control
 *    losing — and the control losing is what the verdict reads as alignment. A
 *    fixture whose tokens and outcomes merely differ between two eras passed
 *    that way, with no within-era signal at all. Callers pass one half at a
 *    time.
 *  - IT MUST DRAW FROM THE SAME POPULATION THE REAL ALIGNMENT IS SCORED ON.
 *    Permuting over all units while the cohort keeps only some of them lets a
 *    retained interval be paired with a discarded one, and the discarded ones
 *    are systematically quieter — the control then loses on traffic volume
 *    rather than on pairing. Callers pass the ELIGIBLE units only.
 *
 * The rotation is by an offset coprime-ish with the list (half its length, at
 * least one), so no unit keeps its own requests. A workload that repeats with
 * exactly that period would pair each unit with an identical twin and the
 * control would tie rather than lose, which is a conservative failure.
 */
export function buildPermutation(
	units: readonly AlignmentUnit[],
): Map<string, AlignmentUnit> {
	const byAccount = new Map<string, AlignmentUnit[]>();
	for (const unit of units) {
		const list = byAccount.get(unit.accountId) ?? [];
		byAccount.set(unit.accountId, list);
		list.push(unit);
	}
	const out = new Map<string, AlignmentUnit>();
	for (const list of byAccount.values()) {
		const sorted = [...list].sort(
			(a, b) => a.fromMs - b.fromMs || a.resetAt - b.resetAt,
		);
		if (sorted.length < 2) continue;
		const shift = Math.max(1, Math.floor(sorted.length / 2));
		for (let i = 0; i < sorted.length; i++) {
			out.set(unitKey(sorted[i]), sorted[(i + shift) % sorted.length]);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Fit
// ---------------------------------------------------------------------------

/**
 * Non-negative least squares by projected gradient descent.
 *
 * Non-negative because a token cannot refund quota, and the study would rather
 * report a class as weightless than fit it a negative price. Deterministic:
 * fixed iteration count, fixed step, no randomness, column-scaled so one token
 * class cannot dominate the step purely by magnitude.
 */
export function fitNonNegative(
	rows: readonly (readonly number[])[],
	targets: readonly number[],
	iterations = MAX_FIT_ITERATIONS,
): FitResult {
	const width = rows[0]?.length ?? 0;
	if (width === 0 || rows.length === 0) {
		return { weights: [], converged: false, iterations: 0 };
	}
	const scale = new Array<number>(width).fill(0);
	for (let j = 0; j < width; j++) {
		let max = 0;
		for (const row of rows) max = Math.max(max, Math.abs(row[j]));
		scale[j] = max > 0 ? max : 1;
	}
	const scaled = rows.map((row) => row.map((v, j) => v / scale[j]));
	// A step of 1/L with L the largest curvature of the quadratic is the
	// standard safe choice, and the squared Frobenius norm bounds L from above.
	// A step picked from the ROW COUNT instead is a guess: it can crawl on a
	// well-conditioned problem and diverge on a badly conditioned one, and how
	// badly conditioned a problem is differs between alignments.
	let frobenius = 0;
	for (const row of scaled) for (const value of row) frobenius += value * value;
	const step = frobenius > 0 ? 1 / frobenius : 0;
	let weights = new Array<number>(width).fill(0);
	let used = iterations;
	let converged = false;
	for (let iteration = 0; iteration < iterations; iteration++) {
		const gradient = new Array<number>(width).fill(0);
		for (let i = 0; i < scaled.length; i++) {
			let predicted = 0;
			for (let j = 0; j < width; j++) predicted += weights[j] * scaled[i][j];
			const error = predicted - targets[i];
			for (let j = 0; j < width; j++) gradient[j] += error * scaled[i][j];
		}
		// The KKT residual of the non-negative problem, evaluated AT the iterate
		// the gradient belongs to: a coordinate is optimal when its gradient is
		// zero, or when it sits at the bound with the gradient pushing it further
		// out. Testing this gradient against the NEXT weights instead — which an
		// earlier version did — reports convergence for a step that has not been
		// judged at all: an all-ones design returned zero weights and "converged"
		// after two iterations. Stopping on "the weights barely moved" is no
		// better: how slow the crawl is depends on how collinear the columns are,
		// which differs between alignments and would tilt the comparison this
		// study exists to make.
		let residual = 0;
		for (let j = 0; j < width; j++) {
			residual = Math.max(
				residual,
				weights[j] > 0 ? Math.abs(gradient[j]) : Math.max(0, -gradient[j]),
			);
		}
		if (residual <= FIT_CONVERGENCE_TOLERANCE) {
			converged = true;
			used = iteration;
			break;
		}
		weights = weights.map((w, j) => Math.max(0, w - step * gradient[j]));
	}
	return {
		weights: weights.map((w, j) => w / scale[j]),
		converged,
		iterations: used,
	};
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface AlignmentScore {
	name: string;
	description: string;
	control: boolean;
	mandatory: boolean;
	/** Units the cohort scored this alignment on. */
	units: number;
	/** Median absolute error in percentage points, or null on an empty cohort. */
	medianAbsErrorPct: number | null;
	/** Share of units predicted inside the quantization band. */
	inBandShare: number | null;
	/** The same, over units whose reading actually moved. */
	medianAbsErrorMovedPct: number | null;
	/** Fitted weights, in {@link TOKEN_CLASSES} order (one entry for count-only). */
	weights: number[];
	/** False when the fit ran out of iterations. A comparison cannot stand on one. */
	converged: boolean;
	fitIterations: number;
	/** Per-unit absolute errors on the evaluation half, keyed for pairing. */
	errorsByUnit: Map<string, number>;
}

export interface CohortScores {
	label: string;
	/** Why this cohort exists and what it excludes. */
	description: string;
	trainingUnits: number;
	evaluationUnits: number;
	scores: AlignmentScore[];
}

const median = (values: readonly number[]): number | null => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) / 2)];
};

/**
 * Score every alignment on one cohort.
 *
 * Order matters and is the substance of two corrections:
 *
 *  1. ELIGIBILITY FIRST. A unit enters only when every non-permutation
 *     alignment's source carries traffic. Traffic arrives in bursts, so without
 *     this the shifted controls are handed idle stretches and beating them
 *     would test whether anyone was working.
 *  2. PERMUTATION SECOND, PER HALF. The mandatory control is then built from
 *     the units that survived (1), separately for the training and evaluation
 *     halves. Permuting first would pair a kept interval with a discarded —
 *     systematically quieter — one, so the control would lose on volume; and
 *     permuting across the halves would turn any workload change BETWEEN them
 *     into the control losing, which the verdict reads as alignment.
 *
 * The fit is the same procedure for every alignment, on the training half
 * alone, and whether it converged travels with the score: an unconverged fit
 * is not a weaker result, it is a number the comparison cannot stand on.
 */
export function scoreCohort(
	label: string,
	description: string,
	units: readonly AlignmentUnit[],
	index: RequestIndex,
	splitAtMs: number,
): CohortScores {
	const base = alignments();
	const eligible = units.filter((unit) =>
		base.every((alignment) => {
			const source = alignment.source(unit, units);
			return (
				source != null &&
				index.sum(source.accountId, source.fromMs, source.toMs).requests > 0
			);
		}),
	);
	const training = eligible.filter((unit) => unit.toMs <= splitAtMs);
	const evaluation = eligible.filter((unit) => unit.fromMs >= splitAtMs);
	const permutation = new Map([
		...buildPermutation(training),
		...buildPermutation(evaluation),
	]);
	const scored = [...base, permutationAlignment(permutation)];
	// A unit the permutation could not pair (an account with one unit in a half)
	// would answer that control with nothing while every other row answered it,
	// so it leaves the cohort rather than the row.
	const paired = (list: readonly AlignmentUnit[]) =>
		list.filter((unit) => permutation.has(unitKey(unit)));
	const trainingPaired = paired(training);
	const evaluationPaired = paired(evaluation);
	const scores: AlignmentScore[] = [];
	for (const alignment of scored) {
		const featurize = alignment.features ?? tokenFeatures;
		const rowsOf = (list: readonly AlignmentUnit[]) =>
			list.map((unit) => {
				const source = alignment.source(unit, units);
				return source == null
					? featurize(EMPTY_SPEND)
					: featurize(index.sum(source.accountId, source.fromMs, source.toMs));
			});
		const fit = fitNonNegative(
			rowsOf(trainingPaired),
			trainingPaired.map((unit) => unit.deltaPct),
		);
		const errorsByUnit = new Map<string, number>();
		const errors: number[] = [];
		const movedErrors: number[] = [];
		let inBand = 0;
		const evaluationRows = rowsOf(evaluationPaired);
		for (let i = 0; i < evaluationPaired.length; i++) {
			const unit = evaluationPaired[i];
			const row = evaluationRows[i];
			let predicted = 0;
			for (let j = 0; j < row.length; j++) predicted += fit.weights[j] * row[j];
			if (!Number.isFinite(predicted)) continue;
			const error = Math.abs(predicted - unit.deltaPct);
			errors.push(error);
			errorsByUnit.set(unitKey(unit), error);
			if (error <= QUANTIZATION_BAND_PCT) inBand++;
			if (unit.deltaPct > 0) movedErrors.push(error);
		}
		scores.push({
			name: alignment.name,
			description: alignment.description,
			control: alignment.control,
			mandatory: alignment.mandatory === true,
			units: errors.length,
			medianAbsErrorPct: median(errors),
			inBandShare: errors.length === 0 ? null : inBand / errors.length,
			medianAbsErrorMovedPct: median(movedErrors),
			weights: fit.weights,
			converged: fit.converged,
			fitIterations: fit.iterations,
			errorsByUnit,
		});
	}
	return {
		label,
		description,
		trainingUnits: trainingPaired.length,
		evaluationUnits: evaluationPaired.length,
		scores,
	};
}

// ---------------------------------------------------------------------------
// Paired difference, clustered
// ---------------------------------------------------------------------------

export interface PairedDifference {
	control: string;
	/** Units both alignments scored. */
	n: number;
	/** Median of (real error − control error), in points. Negative favours real. */
	medianDeltaPct: number | null;
	p2_5: number | null;
	p97_5: number | null;
	/** Clusters the resample drew from. */
	clusters: number;
}

const percentile = (sorted: readonly number[], q: number): number | null => {
	if (sorted.length === 0) return null;
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.round(q * (sorted.length - 1))),
	);
	return sorted[index];
};

/**
 * Paired median difference between the real alignment and one control, with a
 * cluster bootstrap.
 *
 * Clusters are (account, calendar day): units inside one account's working day
 * share a workload, a cache state and a model mix, so resampling units
 * independently would state an interval far narrower than the evidence.
 */
export function pairedDifference(
	cohort: CohortScores,
	controlName: string,
	units: readonly AlignmentUnit[],
	seed = DEFAULT_SEED,
): PairedDifference {
	const real = cohort.scores.find((s) => s.name === REAL_ALIGNMENT);
	const control = cohort.scores.find((s) => s.name === controlName);
	if (real == null || control == null) {
		return {
			control: controlName,
			n: 0,
			medianDeltaPct: null,
			p2_5: null,
			p97_5: null,
			clusters: 0,
		};
	}
	const byCluster = new Map<string, number[]>();
	const paired: number[] = [];
	for (const unit of units) {
		const key = unitKey(unit);
		const a = real.errorsByUnit.get(key);
		const b = control.errorsByUnit.get(key);
		if (a == null || b == null) continue;
		const delta = a - b;
		paired.push(delta);
		const cluster = `${unit.accountId}::${Math.floor(unit.fromMs / DAY_MS)}`;
		const list = byCluster.get(cluster) ?? [];
		byCluster.set(cluster, list);
		list.push(delta);
	}
	const clusters = [...byCluster.values()];
	// One account-day resamples to itself every time, so the interval it prints
	// would be a point — decisive-looking and carrying no independent evidence.
	// Below the floor the difference is still reported and the interval is not.
	if (paired.length === 0 || clusters.length < MIN_BOOTSTRAP_CLUSTERS) {
		return {
			control: controlName,
			n: paired.length,
			medianDeltaPct: median(paired),
			p2_5: null,
			p97_5: null,
			clusters: clusters.length,
		};
	}
	const random = makePrng(seed);
	const samples: number[] = [];
	for (let iteration = 0; iteration < BOOTSTRAP_ITERATIONS; iteration++) {
		const drawn: number[] = [];
		for (let c = 0; c < clusters.length; c++) {
			const pick = clusters[Math.floor(random() * clusters.length)];
			for (const value of pick) drawn.push(value);
		}
		const m = median(drawn);
		if (m != null) samples.push(m);
	}
	samples.sort((a, b) => a - b);
	return {
		control: controlName,
		n: paired.length,
		medianDeltaPct: median(paired),
		p2_5: percentile(samples, 0.025),
		p97_5: percentile(samples, 0.975),
		clusters: clusters.length,
	};
}

// ---------------------------------------------------------------------------
// Synthetic validation
// ---------------------------------------------------------------------------

export interface SyntheticCheck {
	label: string;
	/** What the check proves when it holds. */
	expectation: string;
	/** Real minus mandatory control, in points; sign is what matters. */
	medianDeltaPct: number | null;
	detected: boolean;
	passed: boolean;
}

export const SYNTHETIC_POSITIVE_LABEL = "synthetic positive";
export const SYNTHETIC_NULL_LABEL = "synthetic null";

/**
 * Two synthetic datasets the statistic must get right before any real number
 * from it is worth reading.
 *
 * POSITIVE: percentages generated FROM the tokens. The statistic must find the
 * alignment. If it cannot, it cannot detect one that is there, and a real
 * failure would say nothing.
 *
 * NULL: percentages generated independently of the tokens. The statistic must
 * NOT find an alignment. If it does, the whole design manufactures signal —
 * from the interval construction, the fit, or the split — and a real pass would
 * say nothing either.
 */
export function syntheticChecks(seed = DEFAULT_SEED): SyntheticCheck[] {
	// Built as OBSERVATIONS and run through `buildUnits` and `scoreCohort`, not
	// as units handed straight to the scorer: the interval construction, the
	// eligibility filter and the per-half permutation are exactly the machinery
	// that could manufacture a signal, so a fixture that skipped them would
	// validate the arithmetic and not the study.
	const build = (
		driven: boolean,
	): { observations: AlignmentObservation[]; requests: AlignmentRequest[] } => {
		const random = makePrng(seed + (driven ? 1 : 2));
		const observations: AlignmentObservation[] = [];
		const requests: AlignmentRequest[] = [];
		const base = Date.UTC(2026, 0, 1);
		// Three accounts of 150 intervals: enough for a permutation per half and
		// for several account-day clusters, small enough that the two fixtures run
		// the WHOLE pipeline in seconds. The check is about whether the statistic
		// can discriminate, not about sample size.
		for (let account = 0; account < 3; account++) {
			const accountId = `synthetic-${account}`;
			// One long window instance, so no interval is dropped at a reset.
			const resetAt = base + 200 * INTERVAL_MS;
			// Both fixtures are generated the same way and differ in ONE thing: the
			// null shuffles the finished steps across this account's intervals. The
			// marginal distribution of steps is then identical by construction and
			// only the pairing is gone, which is what "null" has to mean. Scaling a
			// step by the interval's own tokens — an earlier attempt — leaves the
			// step correlated with them and is not a null at all.
			const slotTokens: Array<{ input: number; output: number }> = [];
			for (let slot = 0; slot < 150; slot++) {
				const fromMs = base + slot * INTERVAL_MS;
				// A busy interval and a quiet one, so token mass varies by an order
				// of magnitude the way real bursts do. Every slot carries traffic, so
				// the shifted controls are eligible throughout.
				// One slot in twelve is IDLE, so eligibility actually removes units
				// here the way it does on real data — a fixture where every slot
				// carries traffic never exercises the filter it is meant to validate.
				const idle = random() < 1 / 12;
				const heavy = random() < 0.5;
				const count = idle
					? 0
					: heavy
						? 20 + Math.floor(random() * 40)
						: 1 + Math.floor(random() * 5);
				let input = 0;
				let output = 0;
				for (let i = 0; i < count; i++) {
					const inputTokens = Math.floor(500 + random() * 4000);
					const outputTokens = Math.floor(50 + random() * 800);
					input += inputTokens;
					output += outputTokens;
					requests.push({
						accountId,
						finalizedAt: fromMs + Math.floor(random() * INTERVAL_MS),
						inputTokens,
						outputTokens,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
					});
				}
				slotTokens.push({ input, output });
			}
			const steps = slotTokens.map(({ input, output }) =>
				Math.max(
					0,
					Math.round(
						input * SYNTHETIC_INPUT_PRICE + output * SYNTHETIC_OUTPUT_PRICE,
					),
				),
			);
			if (!driven) {
				// Fisher-Yates over the account's own steps, seeded.
				for (let i = steps.length - 1; i > 0; i--) {
					const j = Math.floor(random() * (i + 1));
					const swap = steps[i];
					steps[i] = steps[j];
					steps[j] = swap;
				}
			}
			let utilization = 0;
			for (let slot = 0; slot < steps.length; slot++) {
				const fromMs = base + slot * INTERVAL_MS;
				observations.push({
					accountId,
					claim: "synthetic",
					observedAt: fromMs + 1,
					utilization: utilization / 100,
					resetAt,
				});
				utilization += steps[slot];
				observations.push({
					accountId,
					claim: "synthetic",
					observedAt: fromMs + INTERVAL_MS - 1,
					utilization: utilization / 100,
					resetAt,
				});
			}
		}
		return { observations, requests };
	};
	const run = (driven: boolean): number | null => {
		const { observations, requests } = build(driven);
		const units = buildUnits(observations, "synthetic").units;
		if (units.length === 0) return null;
		const index = new RequestIndex(requests);
		const splitAtMs =
			units[0].fromMs + (units[units.length - 1].toMs - units[0].fromMs) / 2;
		const cohort = scoreCohort(
			"synthetic",
			"synthetic",
			units,
			index,
			splitAtMs,
		);
		// A number from a fit that did not converge is not a check on the
		// statistic, so the fixture reports NOTHING rather than a value the
		// verdict would then read as evidence either way.
		const real = cohort.scores.find((s) => s.name === REAL_ALIGNMENT);
		const permuted = cohort.scores.find((s) => s.name === MANDATORY_CONTROL);
		if (real?.converged !== true || permuted?.converged !== true) return null;
		return pairedDifference(
			cohort,
			MANDATORY_CONTROL,
			units.filter((unit) => unit.fromMs >= splitAtMs),
			seed,
		).medianDeltaPct;
	};
	// "Detected" is the real alignment landing measurably closer than the
	// permutation: a negative paired median beyond a tenth of a point, which is
	// a tenth of the reporting grid.
	const detectionThreshold = -0.1;
	const positive = run(true);
	const negative = run(false);
	return [
		{
			label: SYNTHETIC_POSITIVE_LABEL,
			expectation:
				"percentages generated FROM the tokens: the statistic must find the alignment",
			medianDeltaPct: positive,
			detected: positive != null && positive <= detectionThreshold,
			passed: positive != null && positive <= detectionThreshold,
		},
		{
			label: SYNTHETIC_NULL_LABEL,
			expectation:
				"percentages drawn from the same distribution but a different interval: the statistic must NOT find one",
			medianDeltaPct: negative,
			detected: negative != null && negative <= detectionThreshold,
			passed: !(negative != null && negative <= detectionThreshold),
		},
	];
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/** The rule, printed verbatim in the report and applied by {@link evaluateAlignment}. */
export const ALIGNMENT_RULE = [
	"REQUEST-LAG ALIGNMENT GATE. Declared 2026-09-08, before the run.",
	"",
	"UNIT. A fixed 10-minute wall-clock interval inside one (account, claim,",
	"   window instance), chosen without reference to where the 1 % crossings",
	"   fall, and KEPT when the reading did not move. The target is the change",
	"   between the interval's first and last reading, in percentage points.",
	"",
	"FEATURES, frozen. The summed input / output / cache-read / cache-creation",
	"   tokens of the requests whose `usage_finalized_at` falls in the source",
	"   interval. Weights are fitted non-negative on the FIRST chronological",
	"   half and every number below is scored on the second.",
	"",
	"COHORT. Every alignment answers the SAME units: a unit enters only when",
	"   every scored alignment's source interval carries at least one request.",
	"   Without that the shifted and donor controls are handed idle stretches —",
	"   traffic arrives in bursts — and beating them would test whether anyone",
	"   was working rather than which requests belong to which interval.",
	"",
	"1. ALIGNMENT. Real must beat `permuted-within-account` — the same account's",
	"   own intervals, deterministically re-paired — on BOTH median absolute",
	"   error and in-band share, and the paired median difference must have its",
	"   95 % cluster-bootstrap interval entirely below zero. Clusters are",
	"   (account, calendar day).",
	"2. COMPOSITION. Real must beat `count-only` on both statistics: token",
	"   composition has to add something over merely counting requests.",
	"3. VALID. The synthetic positive must be detected and the synthetic null",
	"   must not. A statistic that cannot find an alignment that is there, or",
	"   finds one that is not, invalidates the experiment whatever it says",
	"   about the real data.",
	"",
	"REPORTED, NOT GATED. The shifted-source controls, the saturation cohort,",
	"   coverage by token mass, and the donor-account control wherever it is",
	"   measurable at all.",
	"",
	"DECISION. 1, 2 and 3 hold: `pass` — alignment is identifiable, which is",
	"   permission to build a capacity estimator and nothing more. A measured",
	"   failure of 1 or 2: `fail`. 3 failing: `invalid`. Too few evaluation",
	"   units, or a statistic that cannot be computed: `insufficient-evidence`.",
	"",
	"WHAT A PASS IS NOT. It does not validate the fitted token prices, it does",
	"   not establish a capacity number, and it does not survive the timestamp",
	"   caveats: `observed_at` is header arrival, `usage_finalized_at` is when",
	"   a token vector first became known, and concurrent requests mean neither",
	"   identifies a causal instant.",
].join("\n");

export type AlignmentVerdictWord =
	| "pass"
	| "fail"
	| "invalid"
	| "insufficient-evidence";

export interface AlignmentCriterion {
	id: "1" | "2" | "3";
	label: string;
	/** `null` = could not be measured. */
	passed: boolean | null;
	detail: string;
}

export interface AlignmentVerdict {
	verdict: AlignmentVerdictWord;
	criteria: AlignmentCriterion[];
}

const finite = (value: number | null | undefined): value is number =>
	value != null && Number.isFinite(value);

/**
 * Did the real alignment beat this control on both statistics?
 *
 * `null` — never `false` — whenever either side is missing or not a finite
 * number. An empty training half produces empty weights and NaN predictions,
 * and reading that as a loss would report "the real alignment is worse" for a
 * cohort that was never scored at all. It also requires BOTH fits to have
 * converged: two numbers from solvers that stopped at different distances from
 * their optima are not a comparison.
 */
const beats = (
	real: AlignmentScore | undefined,
	control: AlignmentScore | undefined,
): boolean | null => {
	if (
		!finite(real?.medianAbsErrorPct) ||
		!finite(control?.medianAbsErrorPct) ||
		!finite(real?.inBandShare) ||
		!finite(control?.inBandShare) ||
		real?.converged !== true ||
		control?.converged !== true
	) {
		return null;
	}
	return (
		real.medianAbsErrorPct < control.medianAbsErrorPct &&
		real.inBandShare > control.inBandShare
	);
};

/** Apply {@link ALIGNMENT_RULE}. Nothing here reads a number the report does not print. */
export function evaluateAlignment(
	cohort: CohortScores,
	mandatoryDifference: PairedDifference,
	synthetic: readonly SyntheticCheck[],
): AlignmentVerdict {
	const real = cohort.scores.find((s) => s.name === REAL_ALIGNMENT);
	const permuted = cohort.scores.find((s) => s.name === MANDATORY_CONTROL);
	const counted = cohort.scores.find((s) => s.name === COUNT_ONLY_CONTROL);
	const beatsPermuted = beats(real, permuted);
	const intervalBelowZero = finite(mandatoryDifference.p97_5)
		? mandatoryDifference.p97_5 < 0
		: null;
	const criterionOne =
		beatsPermuted == null || intervalBelowZero == null
			? null
			: beatsPermuted && intervalBelowZero;
	const criterionTwo = beats(real, counted);
	// BOTH named checks, present and passing. `.every()` on an empty list is
	// true, and a run that supplied no synthetic validation would then satisfy
	// the criterion that exists to prove the statistic works at all.
	const positive = synthetic.find((c) => c.label === SYNTHETIC_POSITIVE_LABEL);
	const negative = synthetic.find((c) => c.label === SYNTHETIC_NULL_LABEL);
	// Both checks present, both with a statistic that could actually be
	// computed, and both as required. A check that produced no number is not a
	// check that held: `passed` is true for the NULL fixture whenever nothing
	// was detected, and nothing is detected when nothing was measured either.
	const syntheticRan =
		positive != null &&
		negative != null &&
		finite(positive.medianDeltaPct) &&
		finite(negative.medianDeltaPct);
	const syntheticPassed =
		syntheticRan && positive.passed === true && negative.passed === true;
	const criteria: AlignmentCriterion[] = [
		{
			id: "1",
			label: "ALIGNMENT — real beats the within-account permutation",
			passed: criterionOne,
			detail: `median |err| ${fmt(real?.medianAbsErrorPct)} vs ${fmt(permuted?.medianAbsErrorPct)} pp; in band ${fmtPct(real?.inBandShare)} vs ${fmtPct(permuted?.inBandShare)}; paired median ${fmt(mandatoryDifference.medianDeltaPct)} pp, 95 % CI [${fmt(mandatoryDifference.p2_5)}, ${fmt(mandatoryDifference.p97_5)}] over ${mandatoryDifference.clusters} account-day clusters`,
		},
		{
			id: "2",
			label: "COMPOSITION — real beats counting requests",
			passed: criterionTwo,
			detail: `median |err| ${fmt(real?.medianAbsErrorPct)} vs ${fmt(counted?.medianAbsErrorPct)} pp; in band ${fmtPct(real?.inBandShare)} vs ${fmtPct(counted?.inBandShare)}`,
		},
		{
			id: "3",
			label:
				"VALID — the statistic finds a planted alignment and no absent one",
			passed: syntheticRan ? syntheticPassed : null,
			detail: synthetic
				.map(
					(check) =>
						`${check.label}: paired median ${fmt(check.medianDeltaPct)} pp, ${check.passed ? "as required" : "NOT as required"}`,
				)
				.join("; "),
		},
	];
	let verdict: AlignmentVerdictWord;
	if (criteria[2].passed === false) verdict = "invalid";
	else if (!syntheticRan) verdict = "insufficient-evidence";
	else if (cohort.evaluationUnits < MIN_EVALUATION_UNITS)
		verdict = "insufficient-evidence";
	else if (criterionOne === false || criterionTwo === false) verdict = "fail";
	else if (criterionOne === true && criterionTwo === true && syntheticPassed)
		verdict = "pass";
	else verdict = "insufficient-evidence";
	return { verdict, criteria };
}

const EM_DASH = "—";
const fmt = (value: number | null | undefined, digits = 3): string =>
	value == null || !Number.isFinite(value) ? EM_DASH : value.toFixed(digits);
const fmtPct = (value: number | null | undefined): string =>
	value == null || !Number.isFinite(value)
		? EM_DASH
		: `${(value * 100).toFixed(1)}%`;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface AlignmentDatasetSummary {
	claim: string;
	observations: number;
	requests: number;
	accounts: number;
	firstObservationIso: string;
	lastObservationIso: string;
	splitAtIso: string;
	/** Share of the window's requests carrying a finalized-usage instant. */
	finalizedCoverage: number | null;
	/** Share of TOKEN MASS carried by those requests — the coverage that matters. */
	finalizedTokenCoverage: number | null;
}

export interface AlignmentReportInput {
	title: string;
	generatedAtIso: string;
	command: string;
	dataset: AlignmentDatasetSummary;
	build: BuildUnitsResult;
	cohorts: readonly CohortScores[];
	differences: readonly PairedDifference[];
	synthetic: readonly SyntheticCheck[];
	verdict: AlignmentVerdict;
	/** Controls that could not be measured at all, with the reason. */
	unmeasurable: readonly { name: string; reason: string }[];
	notes: readonly string[];
}

export function formatAlignmentReport(input: AlignmentReportInput): string {
	const out: string[] = [];
	const { dataset, build } = input;
	out.push(`# ${input.title}`);
	out.push("");
	out.push(`Generated: ${input.generatedAtIso}`);
	out.push("");
	out.push("Reproduce with:");
	out.push("");
	out.push("```");
	out.push(input.command);
	out.push("```");
	out.push("");
	out.push(
		"This is the GATE, not an estimator. It answers whether the recorded requests line up with the quota readings well enough to be worth building a capacity model on. No number here is a capacity, no fitted weight is used anywhere, and no server code imports the module.",
	);
	out.push("");
	out.push("## Dataset");
	out.push("");
	out.push("| field | value |");
	out.push("|---|---|");
	out.push(`| claim | \`${dataset.claim}\` |`);
	out.push(`| claim observations | ${dataset.observations} |`);
	out.push(`| requests with a finalized token vector | ${dataset.requests} |`);
	out.push(`| accounts | ${dataset.accounts} |`);
	out.push(
		`| observation range | ${dataset.firstObservationIso} .. ${dataset.lastObservationIso} |`,
	);
	out.push(`| train / evaluate split | ${dataset.splitAtIso} |`);
	out.push(
		`| requests carrying \`usage_finalized_at\` | ${fmtPct(dataset.finalizedCoverage)} of rows, ${fmtPct(dataset.finalizedTokenCoverage)} of token mass |`,
	);
	out.push(`| intervals | ${INTERVAL_MS / MINUTE_MS} min |`);
	out.push("");
	out.push(
		`Units built: ${build.units.length}. Dropped: ${build.droppedSingleReading} with a single reading (no change to state), ${build.droppedNegative} whose reading fell (a refund, an applied credit, or a reset this grouping did not see — none of them is consumption), ${build.droppedStraddlingReset} whose slot held two window instances (both would have read the same ten minutes of requests), ${build.droppedUnplaceable} readings with no window instance.`,
	);
	out.push("");
	out.push("## The rule");
	out.push("");
	out.push("```");
	out.push(ALIGNMENT_RULE);
	out.push("```");
	out.push("");
	for (const cohort of input.cohorts) {
		out.push(`## ${cohort.label}`);
		out.push("");
		out.push(cohort.description);
		out.push("");
		out.push(
			`${cohort.trainingUnits} training units, ${cohort.evaluationUnits} evaluation units.`,
		);
		out.push("");
		// Below the floor the numbers are noise, and a table of them reads as
		// evidence. Say what the cohort holds and print nothing else.
		if (cohort.evaluationUnits < MIN_EVALUATION_UNITS) {
			out.push(
				`Fewer than ${MIN_EVALUATION_UNITS} evaluation units, so this cohort states nothing and its scores are not printed. It is reported so the gap is visible rather than absent.`,
			);
			out.push("");
			continue;
		}
		out.push(
			"| alignment | what it reads | units | median &#124;err&#124; (pp) | in band | median &#124;err&#124;, moved only | fit converged (iterations) | weights |",
		);
		out.push("|---|---|---:|---:|---:|---:|---:|---|");
		for (const score of cohort.scores) {
			const weights =
				score.name === COUNT_ONLY_CONTROL
					? `per request ${fmt(score.weights[0], 4)}`
					: score.weights
							.map((w, i) => `${TOKEN_CLASSES[i]} ${w.toExponential(2)}`)
							.join(", ");
			out.push(
				`| \`${score.name}\`${score.mandatory ? " (mandatory control)" : ""} | ${score.description} | ${score.units} | ${fmt(score.medianAbsErrorPct)} | ${fmtPct(score.inBandShare)} | ${fmt(score.medianAbsErrorMovedPct)} | ${score.converged ? `${score.fitIterations}` : `NO (${score.fitIterations})`} | ${weights} |`,
			);
		}
		out.push("");
	}
	out.push("## Paired differences against the real alignment");
	out.push("");
	out.push(
		`Negative favours the real alignment. An interval is stated only above ${MIN_BOOTSTRAP_CLUSTERS} clusters: fewer than that resample to nearly the same draw every time and would print a decisive-looking interval carrying no independent evidence. The interval is a cluster bootstrap over (account, calendar day): units inside one account's working day share a workload, a cache state and a model mix, so resampling them independently would state an interval far narrower than the evidence. Its coverage still rests on account-days being independent of each other, which this study assumes rather than establishes.`,
	);
	out.push("");
	out.push(
		"| control | paired units | clusters | median difference (pp) | 2.5 % | 97.5 % |",
	);
	out.push("|---|---:|---:|---:|---:|---:|");
	for (const difference of input.differences) {
		out.push(
			`| \`${difference.control}\` | ${difference.n} | ${difference.clusters} | ${fmt(difference.medianDeltaPct)} | ${fmt(difference.p2_5)} | ${fmt(difference.p97_5)} |`,
		);
	}
	out.push("");
	out.push("## Synthetic validation");
	out.push("");
	out.push(
		"Before any real number is worth reading, the statistic has to find an alignment that was planted and fail to find one that was not.",
	);
	out.push("");
	out.push("| check | expectation | paired median (pp) | result |");
	out.push("|---|---|---:|---|");
	for (const check of input.synthetic) {
		out.push(
			`| ${check.label} | ${check.expectation} | ${fmt(check.medianDeltaPct)} | ${check.passed ? "as required" : "NOT as required"} |`,
		);
	}
	out.push("");
	if (input.unmeasurable.length > 0) {
		out.push("## Controls that could not be measured");
		out.push("");
		for (const entry of input.unmeasurable) {
			out.push(`- \`${entry.name}\`: ${entry.reason}`);
		}
		out.push("");
	}
	out.push("## Verdict");
	out.push("");
	for (const criterion of input.verdict.criteria) {
		const mark =
			criterion.passed == null
				? "not decidable"
				: criterion.passed
					? "PASS"
					: "FAIL";
		out.push(`- ${criterion.id}. ${criterion.label}: ${mark}`);
		out.push(`  - ${criterion.detail}`);
	}
	out.push("");
	out.push(`**Verdict: \`${input.verdict.verdict}\`**`);
	out.push("");
	out.push("## Notes");
	out.push("");
	for (const note of input.notes) out.push(`- ${note}`);
	out.push("");
	return out.join("\n");
}
