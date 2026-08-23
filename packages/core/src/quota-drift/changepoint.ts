import {
	CI_COVERAGE,
	fitOnce,
	fitWithIntervals,
	INFERENCE_BOOTSTRAP_B,
	mulberry32,
	seedFromParts,
	selectKeys,
} from "./fit";
import type { DetectedChange, QuotaSegment, QuotaVerdict } from "./types";

/**
 * Detecting a step change in one model's cost against a window.
 *
 * ## Segment-level, not block averaging
 *
 * An earlier design compared non-overlapping 14-day blocks and required four
 * per side. That needs 112 days of history against the ~82 days that exist, so
 * it could never fire — an unfireable test reports "no change" forever and
 * looks exactly like a working one. This scans candidate boundaries on a daily
 * grid over the segments themselves.
 *
 * ## Why the scan has to be paid for
 *
 * Scanning ~70 candidate dates and reporting the best one at a nominal 5% is
 * precisely how a scan manufactures findings. Calibration therefore happens at
 * the argmax ONLY, and the interval must exclude zero at the Bonferroni-adjusted
 * level `0.05 / nCandidates`.
 *
 * ## `viable` is the whole contract
 *
 * `viable: true` means the test RAN — both sides were measured and compared —
 * whatever it concluded. `viable: false` means it could not be evaluated at
 * all. Every return path below is deliberate under that rule, because the two
 * map onto `stable` and `insufficient-evidence`, and reporting "no change
 * detected" about a comparison that never happened is the failure mode this
 * module exists to avoid.
 */

/** Fewest days of segments each side of a boundary must span. */
export const MIN_SIDE_DAYS = 10;

/** Fewest segments each side of a boundary must contain. */
export const MIN_SIDE_SEGMENTS = 50;

/** Smallest relative move that is worth reporting at all. */
export const MIN_RELATIVE_CHANGE = 0.1;

/** Nominal family-wise level, before the Bonferroni division. */
export const NOMINAL_LEVEL = 0.05;

/** Recursion depth of the binary segmentation. */
export const MAX_DEPTH = 2;

/**
 * Smallest bootstrap standard deviation, RELATIVE to the coefficient scale, that
 * counts as measured uncertainty rather than solver noise.
 *
 * `bootstrapStdDev > 0` cannot tell the two apart. A rejection written on the
 * draws catches only resamples that are bit-identical; runs that are merely
 * highly regular rebuild datasets whose fitted coefficients are mathematically
 * identical and differ only in the last few bits of the solve. Measured on the
 * regression that covers this: 16 distinct values across 1000 resamples with a
 * standard deviation of 5.4e-15 against a coefficient scale of 1.8 — strictly
 * positive, entirely numerical, and narrow enough that a difference of 1.2
 * clears the interval by more than ten orders of magnitude.
 *
 * 1e-10 matches the solver's own tolerances (`DUAL_TOLERANCE`,
 * `CHOLESKY_JITTER`) and sits many orders of magnitude below any uncertainty
 * that integer-percentage source data could express, so it cannot suppress a
 * real measurement.
 */
export const MIN_RELATIVE_BOOTSTRAP_SD = 1e-10;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ChangepointOptions {
	/** Bootstrap resamples used for calibration. */
	bootstrapB?: number;
	/** Extra parts folded into the PRNG seed. */
	seedParts?: readonly (string | number)[];
	minSideDays?: number;
	minSideSegments?: number;
	minRelativeChange?: number;
	maxDepth?: number;
}

export interface ChangepointResult {
	/** Detected changes, earliest first. */
	changes: DetectedChange[];
	/**
	 * `changed` when at least one change cleared the adjusted level; `stable`
	 * when the test RAN and found nothing; `insufficient-evidence` when it could
	 * not run at all.
	 *
	 * The last two are not interchangeable. An underpowered scan reporting
	 * `stable` would claim a negative result it never established.
	 */
	verdict: QuotaVerdict;
	/** Candidate boundaries scanned at the top level (0 when none were viable). */
	nCandidates: number;
}

/**
 * Scan for step changes in `key`'s coefficient, recursing to `maxDepth`.
 *
 * Beyond the significance test, a reported change must also clear
 * `minRelativeChange` and have BOTH sides identified, and the comparison is
 * restricted to the accounts present on BOTH sides of the split. That last
 * requirement is substantive: if the cohort gained or lost an account at the
 * boundary, the difference across the full sets is a composition change and is
 * not attributable to the provider. The restriction is applied BEFORE the
 * boundary is chosen — selecting on the unrestricted data and reporting on the
 * restricted data is how a composition change wins the scan and the real step
 * goes unreported.
 */
export function detectChanges(
	segments: readonly QuotaSegment[],
	key: string,
	options: ChangepointOptions = {},
): ChangepointResult {
	const top = scanOnce(segments, key, options);
	if (top.change === null) {
		return {
			changes: [],
			verdict: top.viable ? "stable" : "insufficient-evidence",
			nCandidates: top.nCandidates,
		};
	}

	const changes: DetectedChange[] = [top.change];
	const maxDepth = options.maxDepth ?? MAX_DEPTH;
	if (maxDepth > 1) {
		const boundary = top.change.boundaryMs;
		const left = segments.filter((s) => s.t1 <= boundary);
		const right = segments.filter((s) => s.t0 >= boundary);
		for (const side of [left, right]) {
			const nested = detectChanges(side, key, {
				...options,
				maxDepth: maxDepth - 1,
			});
			changes.push(...nested.changes);
		}
	}

	changes.sort((a, b) => a.boundaryMs - b.boundaryMs);
	return { changes, verdict: "changed", nCandidates: top.nCandidates };
}

interface ScanOutcome {
	change: DetectedChange | null;
	/**
	 * Whether the comparison was actually EVALUATED: a boundary was selected,
	 * both restricted sides identified the key, and the difference bootstrap
	 * produced usable draws. False on every path where the scan could not get
	 * that far — those must never surface as `stable`.
	 */
	viable: boolean;
	nCandidates: number;
}

/**
 * One eligible boundary together with the segments the comparison at it is
 * made of.
 *
 * The two sides are stored, not recomputed later: everything downstream — the
 * argmax score, the refits, the difference bootstrap and the reported counts —
 * has to read the SAME restricted arrays the candidate was admitted on. Any
 * path that re-derives a side from `sorted` would reintroduce the unrestricted
 * fit through the back door.
 */
interface Candidate {
	t: number;
	before: QuotaSegment[];
	after: QuotaSegment[];
}

function scanOnce(
	segments: readonly QuotaSegment[],
	key: string,
	options: ChangepointOptions,
): ScanOutcome {
	const minSideDays = options.minSideDays ?? MIN_SIDE_DAYS;
	const minSideSegments = options.minSideSegments ?? MIN_SIDE_SEGMENTS;
	const minRelative = options.minRelativeChange ?? MIN_RELATIVE_CHANGE;
	const b = options.bootstrapB ?? INFERENCE_BOOTSTRAP_B;

	if (segments.length < 2 * minSideSegments) {
		return { change: null, viable: false, nCandidates: 0 };
	}

	const sorted = [...segments].sort((a, b2) => a.t0 - b2.t0);
	const first = sorted[0].t0;
	const last = sorted[sorted.length - 1].t1;

	// --- Candidates, ALREADY restricted to the shared accounts ---------------
	//
	// The confound is real — a cohort that gained or lost an account at the
	// boundary shows a composition change that is not the provider's doing — but
	// requiring the two account sets to be IDENTICAL closes the test along with
	// it. On the live pool two accounts joined mid-history, so all 62 candidate
	// splits differ and no model can ever reach a verdict. Intersecting and
	// restricting BOTH sides to the shared accounts keeps the comparison
	// like-for-like while leaving the detector able to fire.
	//
	// The restriction happens HERE, before eligibility and before the argmax,
	// because a scan that selects on one dataset and measures on another selects
	// composition change and then reports whatever the restricted data happens to
	// say at that date. One transient account is enough: its arrival shifts the
	// unrestricted coefficient sharply, wins the argmax, and the refit at that
	// date — over accounts that never changed — then reports "no change" and
	// buries the real step. The floors are applied to the restricted sides for
	// the same reason: they are what the reported counts have to clear.
	const candidates: Candidate[] = [];
	const gridStart = Math.ceil(first / DAY_MS) * DAY_MS;
	for (let t = gridStart; t < last; t += DAY_MS) {
		const rawBefore = sorted.filter((s) => s.t1 <= t);
		const rawAfter = sorted.filter((s) => s.t0 >= t);
		const afterAccounts = new Set(rawAfter.map((s) => s.accountId));
		const shared = new Set(
			rawBefore.map((s) => s.accountId).filter((id) => afterAccounts.has(id)),
		);
		if (shared.size === 0) continue;
		const before = rawBefore.filter((s) => shared.has(s.accountId));
		const after = rawAfter.filter((s) => shared.has(s.accountId));
		if (before.length < minSideSegments || after.length < minSideSegments) {
			continue;
		}
		if (spanDays(before) < minSideDays || spanDays(after) < minSideDays) {
			continue;
		}
		candidates.push({ t, before, after });
	}
	if (candidates.length === 0) {
		return { change: null, viable: false, nCandidates: 0 };
	}

	// --- Argmax over candidates on the standardised difference --------------
	//
	// `bestScore` starts below every attainable score so an exactly flat series
	// still SELECTS a boundary. A series that is measurable everywhere and moves
	// nowhere is a completed test that found nothing; only a series with no
	// scorable candidate at all is unevaluable, and `scorable` is what tells
	// those two apart.
	let best: Candidate | null = null;
	let bestScore = Number.NEGATIVE_INFINITY;
	let scorable = 0;
	for (const candidate of candidates) {
		const wBefore = coefficientFor(candidate.before, key);
		const wAfter = coefficientFor(candidate.after, key);
		if (wBefore === null || wAfter === null) continue;
		// Standardise by the pooled scale so a boundary between two big
		// coefficients is not automatically preferred over one between two small.
		const scale = (Math.abs(wBefore) + Math.abs(wAfter)) / 2;
		if (!(scale > 0)) continue;
		scorable += 1;
		const score = Math.abs(wAfter - wBefore) / scale;
		if (score > bestScore) {
			bestScore = score;
			best = candidate;
		}
	}
	if (scorable === 0 || best === null) {
		// No candidate yielded a comparable coefficient on both sides, so nothing
		// was ever compared. NOT `stable`.
		return { change: null, viable: false, nCandidates: candidates.length };
	}
	const bestT = best.t;
	const beforeSegments = best.before;
	const afterSegments = best.after;

	// --- Both restricted sides must be independently identified -------------
	const beforeFit = fitWithIntervals(beforeSegments, {
		bootstrapB: b,
		seedParts: [...(options.seedParts ?? []), "before", bestT],
	});
	const afterFit = fitWithIntervals(afterSegments, {
		bootstrapB: b,
		seedParts: [...(options.seedParts ?? []), "after", bestT],
	});
	const beforeCoef = beforeFit.coefficients.find((c) => c.key === key);
	const afterCoef = afterFit.coefficients.find((c) => c.key === key);
	if (
		!beforeCoef?.identified ||
		!afterCoef?.identified ||
		beforeCoef.pointEstimate === null ||
		afterCoef.pointEstimate === null
	) {
		// One side carries no usable estimate, so there was nothing to compare.
		return { change: null, viable: false, nCandidates: candidates.length };
	}

	const before = beforeCoef.pointEstimate;
	const after = afterCoef.pointEstimate;
	const relativeChange = (after - before) / before;
	if (Math.abs(relativeChange) < minRelative) {
		// A COMPLETED test: both sides measured, the move is too small to report.
		return { change: null, viable: true, nCandidates: candidates.length };
	}

	// --- Calibrate at the argmax only, at the adjusted level -----------------
	const adjustedLevel = NOMINAL_LEVEL / candidates.length;
	const diffs = bootstrapDifference(
		beforeSegments,
		afterSegments,
		key,
		b,
		seedFromParts([...(options.seedParts ?? []), "diff", bestT]),
	);
	// A bootstrap-NORMAL interval, not an empirical percentile. Retained history
	// yields ~61 candidates, putting the adjusted two-sided tail at
	// 0.05 / 61 / 2 ~= 4.1e-4; at B = 1000 draws that percentile is index 0.409,
	// an interpolation between the two smallest draws. Claiming a Bonferroni
	// correction off a tail the sample cannot resolve is claiming a stringency
	// the test does not have. The run-block resampling still supplies the
	// uncertainty; only the tail comes from the normal approximation, where the
	// exact level costs nothing.
	//
	// The degenerate cases are rejected on the DRAWS, before any spread is
	// computed, because the spread cannot see them. Recovering a mean by summing
	// a thousand identical values and dividing does not return that value: the
	// accumulated rounding leaves it a few ulps off, so the second pass squares a
	// difference that is pure arithmetic error and reports it as variance.
	// Measured: 1000 identical draws of -0.173 yield 1.39e-15 rather than 0, which
	// clears a `> 0` test and hands back a zero-width interval that excludes zero
	// for free.
	if (diffs.length < 2 || new Set(diffs).size < 2) {
		// No usable resamples, or every resample identical: the difference has no
		// measured uncertainty at all.
		return { change: null, viable: false, nCandidates: candidates.length };
	}
	const bootstrapStdDev = sampleStdDev(diffs);
	if (!Number.isFinite(bootstrapStdDev) || bootstrapStdDev <= 0) {
		// Covers +Infinity and NaN as well as a spread that still came out at zero;
		// a non-finite half-width is not a measurement either.
		return { change: null, viable: false, nCandidates: candidates.length };
	}
	// Near-degenerate is the same failure as degenerate, and neither an
	// exact-equality check on the draws nor a `> 0` check on the spread can see
	// it: highly regular runs resample into datasets whose fits agree to within
	// solver noise, leaving a spread that is positive but purely numerical.
	// Judging a difference against that spread is judging it against nothing.
	const coefficientScale = (Math.abs(before) + Math.abs(after)) / 2;
	if (bootstrapStdDev <= coefficientScale * MIN_RELATIVE_BOOTSTRAP_SD) {
		return { change: null, viable: false, nCandidates: candidates.length };
	}
	const halfWidth = normalQuantile(1 - adjustedLevel / 2) * bootstrapStdDev;
	const difference = after - before;
	const lo = difference - halfWidth;
	const hi = difference + halfWidth;
	const excludesZero = lo > 0 || hi < 0;
	if (!excludesZero) {
		return { change: null, viable: true, nCandidates: candidates.length };
	}

	return {
		change: {
			boundaryMs: bestT,
			before,
			after,
			relativeChange,
			direction: after > before ? "more-expensive" : "cheaper",
			adjustedLevel,
			nCandidates: candidates.length,
			// The RESTRICTED counts: what the reported difference was measured on.
			nSegmentsBefore: beforeSegments.length,
			nSegmentsAfter: afterSegments.length,
		},
		viable: true,
		nCandidates: candidates.length,
	};
}

/**
 * Point coefficient for one key over a segment set, or null when the key does
 * not survive the column selection there (too small a share to be its own
 * column). Used only for the argmax scan, where an interval is not yet needed.
 */
function coefficientFor(
	segments: readonly QuotaSegment[],
	key: string,
): number | null {
	const keys = selectKeys(segments);
	const idx = keys.indexOf(key);
	if (idx < 0) return null;
	const fit = fitOnce(segments, keys);
	const value = fit.coefficients[idx];
	return Number.isFinite(value) ? value : null;
}

/**
 * Run-block bootstrap of the before/after DIFFERENCE. Each resample redraws
 * whole runs on each side independently and refits both, so the interval
 * carries the same within-run correlation the point estimates do.
 */
function bootstrapDifference(
	before: readonly QuotaSegment[],
	after: readonly QuotaSegment[],
	key: string,
	b: number,
	seed: number,
): number[] {
	const beforeRuns = groupRuns(before);
	const afterRuns = groupRuns(after);
	if (beforeRuns.length === 0 || afterRuns.length === 0) return [];
	const beforeKeys = selectKeys(before);
	const afterKeys = selectKeys(after);
	const beforeIdx = beforeKeys.indexOf(key);
	const afterIdx = afterKeys.indexOf(key);
	if (beforeIdx < 0 || afterIdx < 0) return [];

	const rand = mulberry32(seed);
	const diffs: number[] = [];
	for (let iter = 0; iter < b; iter++) {
		const bs: QuotaSegment[] = [];
		for (let i = 0; i < beforeRuns.length; i++) {
			bs.push(
				...beforeRuns[
					Math.floor(rand() * beforeRuns.length) % beforeRuns.length
				],
			);
		}
		const as: QuotaSegment[] = [];
		for (let i = 0; i < afterRuns.length; i++) {
			as.push(
				...afterRuns[Math.floor(rand() * afterRuns.length) % afterRuns.length],
			);
		}
		const wb = fitOnce(bs, beforeKeys).coefficients[beforeIdx];
		const wa = fitOnce(as, afterKeys).coefficients[afterIdx];
		if (Number.isFinite(wa) && Number.isFinite(wb)) diffs.push(wa - wb);
	}
	return diffs;
}

function groupRuns(segments: readonly QuotaSegment[]): QuotaSegment[][] {
	const runs = new Map<string, QuotaSegment[]>();
	for (const seg of segments) {
		const list = runs.get(seg.runId);
		if (list) list.push(seg);
		else runs.set(seg.runId, [seg]);
	}
	return [...runs.values()];
}

function spanDays(segments: readonly QuotaSegment[]): number {
	if (segments.length === 0) return 0;
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const s of segments) {
		if (s.t0 < min) min = s.t0;
		if (s.t1 > max) max = s.t1;
	}
	return (max - min) / DAY_MS;
}

/**
 * Sample standard deviation (n - 1 denominator), by Welford's online update.
 *
 * NaN for fewer than two values: one draw carries no spread, and returning 0
 * there would read as "measured, and exactly zero".
 *
 * The two-pass form this replaced recovered the mean by summing every value and
 * dividing, which on a degenerate sample lands a few ulps away from the value
 * itself and turns that rounding into "variance". Welford never forms the total:
 * each update takes the deviation from the running mean, so an unvarying sample
 * leaves `m2` at exactly zero.
 */
function sampleStdDev(values: readonly number[]): number {
	if (values.length < 2) return Number.NaN;
	let n = 0;
	let mean = 0;
	let m2 = 0;
	for (const v of values) {
		n += 1;
		const delta = v - mean;
		mean += delta / n;
		m2 += delta * (v - mean);
	}
	return Math.sqrt(m2 / (n - 1));
}

// Acklam's rational approximation to the inverse standard-normal CDF.
const ACKLAM_A = [
	-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
	1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
] as const;
const ACKLAM_B = [
	-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
	6.680131188771972e1, -1.328068155288572e1,
] as const;
const ACKLAM_C = [
	-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
	-2.549732539343734, 4.374664141464968, 2.938163982698783,
] as const;
const ACKLAM_D = [
	7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
	3.754408661907416,
] as const;
const ACKLAM_P_LOW = 0.02425;

/**
 * Inverse standard-normal CDF: the `z` with `P(Z <= z) = p`.
 *
 * Deterministic, dependency-free and accurate to about 1.15e-9 across the whole
 * open interval (Acklam's rational approximation), which is what lets the scan
 * state a Bonferroni-adjusted level as fine as 4e-4. An empirical bootstrap
 * tail cannot resolve that level at any resample count this pass can afford:
 * 1000 draws put the 4.1e-4 percentile between the two smallest of them.
 *
 * Returns NaN outside `(0, 1)` — an undefined quantile is not a number, and a
 * silent +/-Infinity would turn into an interval that excludes zero for free.
 */
export function normalQuantile(p: number): number {
	if (!Number.isFinite(p) || p <= 0 || p >= 1) return Number.NaN;
	if (p < ACKLAM_P_LOW) return -tailQuantile(p);
	if (p > 1 - ACKLAM_P_LOW) return tailQuantile(1 - p);
	const q = p - 0.5;
	const r = q * q;
	const num =
		((((ACKLAM_A[0] * r + ACKLAM_A[1]) * r + ACKLAM_A[2]) * r + ACKLAM_A[3]) *
			r +
			ACKLAM_A[4]) *
			r +
		ACKLAM_A[5];
	const den =
		((((ACKLAM_B[0] * r + ACKLAM_B[1]) * r + ACKLAM_B[2]) * r + ACKLAM_B[3]) *
			r +
			ACKLAM_B[4]) *
			r +
		1;
	return (num * q) / den;
}

/** The tail branch of {@link normalQuantile}, for `0 < p < ACKLAM_P_LOW`. */
function tailQuantile(p: number): number {
	const q = Math.sqrt(-2 * Math.log(p));
	const num =
		((((ACKLAM_C[0] * q + ACKLAM_C[1]) * q + ACKLAM_C[2]) * q + ACKLAM_C[3]) *
			q +
			ACKLAM_C[4]) *
			q +
		ACKLAM_C[5];
	const den =
		(((ACKLAM_D[0] * q + ACKLAM_D[1]) * q + ACKLAM_D[2]) * q + ACKLAM_D[3]) *
			q +
		1;
	return -(num / den);
}

/** Re-exported so callers do not have to import the coverage constant twice. */
export { CI_COVERAGE };
