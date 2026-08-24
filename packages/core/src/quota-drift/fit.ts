import { OTHER_MODEL_KEY } from "./model-key";
import { nnls, olsSolve } from "./nnls";
import type {
	CoefficientEstimate,
	FitInput,
	FitResult,
	QuotaSegment,
	SeriesPoint,
	TierProvenance,
	UnidentifiedReason,
} from "./types";

/**
 * Fitting `Δpct = Σ w_m · Mtok_m` and deciding which of the resulting numbers
 * are allowed to be shown.
 *
 * The gate matters more than the fit. A coefficient can come back with a narrow
 * interval and a healthy R² and still be meaningless, and this module's job is
 * to refuse to display those.
 */

/** Below this share of a fit window's eq-tokens a model pools into `other`. */
export const MIN_MODEL_SHARE = 0.02;

/** Widest relative interval, `(hi - lo) / point`, that still counts as measured. */
export const MAX_RELATIVE_CI_WIDTH = 0.5;

/** Fewest segments a fit may have and still identify anything. */
export const MIN_SEGMENTS_FOR_FIT = 20;

/**
 * Fewest distinct runs a fit needs before its interval means anything.
 *
 * The bootstrap resamples whole RUNS, so a fit whose segments all come from one
 * run has every resample identical to the original: the interval collapses onto
 * the point estimate, the relative-width criterion passes trivially, and a
 * number derived from a sample containing no independent unit is reported as
 * measured. Not hypothetical — one account with one complete seven-day monotone
 * run yields ~28 segments at 6h anchors and clears the segment floor on its own.
 */
export const MIN_RUNS_FOR_INTERVAL = 2;

/**
 * Lowest tolerance (`1 - R²` of this column regressed on the others) that still
 * counts as separately identified. Equivalently VIF <= 10.
 *
 * This criterion is NOT optional and is the one that is easy to leave out. When
 * two high-volume models always run in a fixed ratio, share, segment count and
 * even the bootstrap interval all look healthy while the individual
 * coefficients are not separately identified at all: resampling preserves the
 * collinearity, so the interval is narrow around an arbitrary split of a sum.
 */
export const MIN_TOLERANCE = 0.1;

/** Bootstrap resamples for the display series. */
export const DISPLAY_BOOTSTRAP_B = 300;

/** Bootstrap resamples for changepoint inference (a tail probability). */
export const INFERENCE_BOOTSTRAP_B = 1000;

/** Rolling display window width. */
export const ROLLING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Rolling display window step. */
export const ROLLING_STEP_MS = 2 * 24 * 60 * 60 * 1000;

/** Interval coverage the bootstrap reports (90%: 5th to 95th percentile). */
export const CI_COVERAGE = 0.9;

/**
 * Seeded PRNG. The panel must not jitter between recomputes of the same data,
 * so every resample stream is derived from the fit's own identity rather than
 * from the clock.
 */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** FNV-1a over the fit's identity, so the same fit always draws the same stream. */
export function seedFromParts(parts: readonly (string | number)[]): number {
	let h = 0x811c9dc5;
	for (const part of parts) {
		const s = String(part);
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 0x01000193);
		}
		h ^= 0x1f;
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/**
 * Choose the fit's column set: every model at or above `MIN_MODEL_SHARE` of the
 * window's total eq-tokens, plus one pooled `other` column for the rest.
 *
 * The pooled column is not cosmetic. Dropping the long tail instead would
 * remove exposure that really did consume the window, and the fit would push
 * that consumption onto whichever kept column happened to co-occur with it.
 */
export function selectKeys(segments: readonly QuotaSegment[]): string[] {
	const totals = new Map<string, number>();
	let grand = 0;
	for (const seg of segments) {
		for (const [key, tokens] of Object.entries(seg.eqTokensByModel)) {
			if (!(tokens > 0)) continue;
			totals.set(key, (totals.get(key) ?? 0) + tokens);
			grand += tokens;
		}
	}
	if (grand <= 0) return [];

	const kept: string[] = [];
	let pooled = 0;
	for (const [key, total] of totals) {
		if (total / grand >= MIN_MODEL_SHARE) kept.push(key);
		else pooled += total;
	}
	kept.sort();
	if (pooled > 0) kept.push(OTHER_MODEL_KEY);
	return kept;
}

/** Per-key share of the total eq-tokens across a segment set. */
export function shareByKey(
	segments: readonly QuotaSegment[],
	keys: readonly string[],
): Map<string, number> {
	const kept = new Set(keys);
	const totals = new Map<string, number>();
	let grand = 0;
	for (const seg of segments) {
		for (const [key, tokens] of Object.entries(seg.eqTokensByModel)) {
			if (!(tokens > 0)) continue;
			const column = kept.has(key) ? key : OTHER_MODEL_KEY;
			totals.set(column, (totals.get(column) ?? 0) + tokens);
			grand += tokens;
		}
	}
	const shares = new Map<string, number>();
	for (const key of keys) {
		shares.set(key, grand > 0 ? (totals.get(key) ?? 0) / grand : 0);
	}
	return shares;
}

/** Assemble the design matrix. Exposure is in MILLIONS of eq-tokens. */
export function buildFitInput(
	segments: readonly QuotaSegment[],
	keys: readonly string[],
): FitInput {
	const kept = new Set(keys);
	const hasOther = kept.has(OTHER_MODEL_KEY);
	const X: number[][] = [];
	const y: number[] = [];
	const runIds: string[] = [];
	for (const seg of segments) {
		const row = new Array<number>(keys.length).fill(0);
		for (const [key, tokens] of Object.entries(seg.eqTokensByModel)) {
			if (!(tokens > 0)) continue;
			const column = kept.has(key)
				? keys.indexOf(key)
				: hasOther
					? keys.indexOf(OTHER_MODEL_KEY)
					: -1;
			if (column >= 0) row[column] += tokens / 1e6;
		}
		X.push(row);
		y.push(seg.dpct);
		runIds.push(seg.runId);
	}
	return { keys, X, y, runIds };
}

/** A single non-negative least-squares fit plus its goodness of fit. */
export function fitOnce(
	segments: readonly QuotaSegment[],
	keys: readonly string[],
): {
	coefficients: number[];
	r2: number;
	residuals: number[];
	rankDeficient: boolean;
} {
	const input = buildFitInput(segments, keys);
	const solved = nnls(input.X, input.y);
	const residuals: number[] = [];
	let ssRes = 0;
	let ssTot = 0;
	const meanY =
		input.y.length > 0
			? input.y.reduce((a, b) => a + b, 0) / input.y.length
			: 0;
	for (let i = 0; i < input.y.length; i++) {
		let pred = 0;
		for (let j = 0; j < keys.length; j++)
			pred += input.X[i][j] * solved.coefficients[j];
		const res = input.y[i] - pred;
		residuals.push(res);
		ssRes += res * res;
		ssTot += (input.y[i] - meanY) * (input.y[i] - meanY);
	}
	const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
	return {
		coefficients: solved.coefficients,
		r2,
		residuals,
		rankDeficient: solved.rankDeficient,
	};
}

/**
 * Tolerance of each column: `1 - R²` of regressing that exposure column on the
 * others. 1 means orthogonal to everything else, 0 means fully explained by
 * them (and therefore not separately identified).
 */
export function columnTolerances(input: FitInput): number[] {
	const n = input.keys.length;
	const out = new Array<number>(n).fill(1);
	if (n <= 1 || input.X.length === 0) return out;
	for (let j = 0; j < n; j++) {
		const target = input.X.map((row) => row[j]);
		const others = input.X.map((row) => row.filter((_, k) => k !== j));
		const mean = target.reduce((a, b) => a + b, 0) / target.length;
		let ssTot = 0;
		for (const v of target) ssTot += (v - mean) * (v - mean);
		if (ssTot <= 0) {
			// A constant (typically all-zero) column carries no variance of its own,
			// so nothing about it is identified.
			out[j] = 0;
			continue;
		}
		const beta = olsSolve(others, target);
		if (!beta) {
			out[j] = 0;
			continue;
		}
		let ssRes = 0;
		for (let i = 0; i < others.length; i++) {
			let pred = 0;
			for (let k = 0; k < beta.length; k++) pred += others[i][k] * beta[k];
			const res = target[i] - pred;
			ssRes += res * res;
		}
		out[j] = Math.max(0, Math.min(1, ssRes / ssTot));
	}
	return out;
}

/** Group segments by run, preserving order. */
function groupByRun(
	segments: readonly QuotaSegment[],
): Map<string, QuotaSegment[]> {
	const runs = new Map<string, QuotaSegment[]>();
	for (const seg of segments) {
		const list = runs.get(seg.runId);
		if (list) list.push(seg);
		else runs.set(seg.runId, [seg]);
	}
	return runs;
}

/**
 * BLOCK bootstrap over runs: draw whole runs with replacement.
 *
 * Resampling individual segments would understate every interval. Segments
 * within a run share an account, a window instance, the polling lag and the
 * time-correlated integer quantization of the reported percentage, so they are
 * not independent draws — treating them as such shrinks the interval by roughly
 * the square root of the average run length, for free.
 */
export function bootstrapCoefficients(
	segments: readonly QuotaSegment[],
	keys: readonly string[],
	b: number,
	seed: number,
): number[][] {
	const runs = [...groupByRun(segments).values()];
	if (runs.length === 0) return [];
	const rand = mulberry32(seed);
	const draws: number[][] = [];
	for (let iter = 0; iter < b; iter++) {
		const resampled: QuotaSegment[] = [];
		for (let r = 0; r < runs.length; r++) {
			const pick = runs[Math.floor(rand() * runs.length) % runs.length];
			resampled.push(...pick);
		}
		draws.push(fitOnce(resampled, keys).coefficients);
	}
	return draws;
}

/** Percentile of a sorted-on-demand sample. */
export function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = (sorted.length - 1) * p;
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo];
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export interface FitOptions {
	/** Bootstrap resamples. Defaults to the display count. */
	bootstrapB?: number;
	/** Extra parts folded into the PRNG seed, for determinism across recomputes. */
	seedParts?: readonly (string | number)[];
	/** Whether the cohort's tier came from the samples or from today's accounts. */
	tierProvenance?: TierProvenance;
}

/**
 * Fit one segment set and gate every coefficient.
 *
 * A coefficient is `identified` only when ALL FOUR hold: the relative interval
 * width is at most `MAX_RELATIVE_CI_WIDTH`, the model's share is at least
 * `MIN_MODEL_SHARE`, the fit has at least `MIN_SEGMENTS_FOR_FIT` segments, and
 * the column's tolerance is at least `MIN_TOLERANCE`. A point estimate pinned
 * at 0 yields infinite relative width and is unidentified, which is correct: it
 * means the data could not distinguish the model's cost from nothing.
 *
 * The interval itself is only computed when the fit has at least
 * `MIN_RUNS_FOR_INTERVAL` distinct runs — see that constant for why a
 * single-run fit would otherwise report a zero-width interval as a measurement.
 */
export function fitWithIntervals(
	segments: readonly QuotaSegment[],
	options: FitOptions = {},
): FitResult {
	const keys = selectKeys(segments);
	const b = options.bootstrapB ?? DISPLAY_BOOTSTRAP_B;
	const accountIds = [...new Set(segments.map((s) => s.accountId))].sort();

	if (keys.length === 0 || segments.length === 0) {
		return {
			nSegments: segments.length,
			r2: 0,
			zeroObservedTokenDeltaShare: zeroTokenDeltaShare(segments),
			contributingAccountIds: accountIds,
			tierProvenance: options.tierProvenance ?? "assumed",
			coefficients: [],
		};
	}

	const input = buildFitInput(segments, keys);
	const point = fitOnce(segments, keys);
	const tolerances = columnTolerances(input);
	const shares = shareByKey(segments, keys);
	const seed = seedFromParts([
		...(options.seedParts ?? []),
		keys.join(","),
		segments.length,
	]);
	// Below the run floor there is nothing to resample: every draw would be the
	// original sample again. Leaving the interval inputs empty makes both bounds
	// NaN, so every coefficient with a positive estimate falls to
	// `wide-interval` (the rest are already `zero-estimate`) and none can be
	// identified — a stated absence rather than a zero-width interval.
	const draws =
		groupByRun(segments).size >= MIN_RUNS_FOR_INTERVAL
			? bootstrapCoefficients(segments, keys, b, seed)
			: [];

	const tail = (1 - CI_COVERAGE) / 2;
	const coefficients: CoefficientEstimate[] = keys.map((key, j) => {
		const column = draws.map((d) => d[j]);
		const ciLow = column.length > 0 ? percentile(column, tail) : Number.NaN;
		const ciHigh =
			column.length > 0 ? percentile(column, 1 - tail) : Number.NaN;
		const estimate = point.coefficients[j];
		const share = shares.get(key) ?? 0;
		const tolerance = tolerances[j];

		const reasons: UnidentifiedReason[] = [];
		if (!(estimate > 0)) reasons.push("zero-estimate");
		if (segments.length < MIN_SEGMENTS_FOR_FIT) reasons.push("few-segments");
		// Zero exposure and sub-floor exposure fail the SAME criterion but are
		// different facts, and only the second one is about measurement. A model
		// that was not routed at all in this window gets `no-exposure`, never
		// `low-share` as well.
		if (!(share > 0)) reasons.push("no-exposure");
		else if (share < MIN_MODEL_SHARE) reasons.push("low-share");
		if (tolerance < MIN_TOLERANCE) reasons.push("collinear");
		if (
			estimate > 0 &&
			(!Number.isFinite(ciLow) ||
				!Number.isFinite(ciHigh) ||
				(ciHigh - ciLow) / estimate > MAX_RELATIVE_CI_WIDTH)
		) {
			reasons.push("wide-interval");
		}
		if (point.rankDeficient && !reasons.includes("collinear")) {
			reasons.push("collinear");
		}

		const identified = reasons.length === 0;
		return {
			key,
			pointEstimate: identified ? estimate : null,
			ciLow: identified ? ciLow : null,
			ciHigh: identified ? ciHigh : null,
			impliedCapacityMtok: identified && estimate > 0 ? 100 / estimate : null,
			shareOfWindow: share,
			tolerance,
			identified,
			unidentifiedReasons: reasons,
		};
	});

	return {
		nSegments: segments.length,
		r2: point.r2,
		zeroObservedTokenDeltaShare: zeroTokenDeltaShare(segments),
		contributingAccountIds: accountIds,
		tierProvenance: options.tierProvenance ?? "assumed",
		coefficients,
	};
}

/**
 * Share of total observed Δpct that landed in segments with NO observed tokens.
 *
 * A LOWER BOUND on off-proxy usage, never a coverage figure. It can only catch
 * hidden usage in segments containing no proxy traffic at all; hidden usage
 * concurrent with proxy traffic is silently attributed to whichever models were
 * running. See the field docs on `FitResult`.
 */
export function zeroTokenDeltaShare(segments: readonly QuotaSegment[]): number {
	let total = 0;
	let zeroToken = 0;
	for (const seg of segments) {
		if (!(seg.dpct > 0)) continue;
		total += seg.dpct;
		let tokens = 0;
		for (const v of Object.values(seg.eqTokensByModel)) tokens += v;
		if (tokens <= 0) zeroToken += seg.dpct;
	}
	return total > 0 ? zeroToken / total : 0;
}

export interface RollingOptions extends FitOptions {
	windowMs?: number;
	stepMs?: number;
	/** Clamp the series to this range; defaults to the segments' own span. */
	fromMs?: number;
	toMs?: number;
}

/**
 * Every model key that appears with positive exposure anywhere in `segments`.
 *
 * Sorted, and NEVER including the pooled `other` column: that column is a
 * nuisance regressor which absorbs the sub-share tail so the kept columns do
 * not, and a coefficient for a changing mixture of unrelated models is not a
 * quantity anything may be claimed about.
 */
export function actualModelKeys(segments: readonly QuotaSegment[]): string[] {
	const keys = new Set<string>();
	for (const seg of segments) {
		for (const [key, tokens] of Object.entries(seg.eqTokensByModel)) {
			if (tokens > 0 && key !== OTHER_MODEL_KEY) keys.add(key);
		}
	}
	return [...keys].sort();
}

/** Total eq-tokens per model key across a segment set, unpooled. */
function exposureByKey(segments: readonly QuotaSegment[]): Map<string, number> {
	const totals = new Map<string, number>();
	for (const seg of segments) {
		for (const [key, tokens] of Object.entries(seg.eqTokensByModel)) {
			if (!(tokens > 0)) continue;
			totals.set(key, (totals.get(key) ?? 0) + tokens);
		}
	}
	return totals;
}

/**
 * Why a model has no number in a window whose fit gave it NO COLUMN at all.
 *
 * `selectKeys` only admits models at or above the share floor, so a model can
 * be missing from a fit for two unrelated reasons, and the panel has to be able
 * to tell a reader which one it was:
 *
 *  - zero eq-tokens in the window — the model was not routed here at all;
 *  - positive but sub-floor exposure — it ran, and there is too little of it to
 *    separate from everything else.
 *
 * Before this the point simply carried no reason, and both cases rendered as
 * the same unexplained break in the line.
 */
function reasonsWithoutColumn(
	exposure: number,
	nSegments: number,
): UnidentifiedReason[] {
	const reasons: UnidentifiedReason[] = [
		exposure > 0 ? "low-share" : "no-exposure",
	];
	if (nSegments < MIN_SEGMENTS_FOR_FIT) reasons.push("few-segments");
	return reasons;
}

/**
 * Rolling fits over a sliding window — the display series.
 *
 * Each window is fitted independently, so a model that only becomes
 * identifiable partway through the history simply starts having identified
 * points there.
 *
 * EVERY grid window emits one point per model, including windows the model was
 * pooled out of, windows with no proxy traffic at all, and windows falling in
 * an inactivity gap. The panel draws an unidentified point as a GAP; omitting
 * the point instead lets the line join straight across a stretch where nothing
 * was measured, which is the one thing the series must never do. It also keeps
 * the LAST point on the last grid window, so a caller reading "latest" off the
 * series gets the current window rather than the newest one that happened to
 * produce a fit.
 */
export function fitRolling(
	segments: readonly QuotaSegment[],
	options: RollingOptions = {},
): Map<string, SeriesPoint[]> {
	const windowMs = options.windowMs ?? ROLLING_WINDOW_MS;
	const stepMs = options.stepMs ?? ROLLING_STEP_MS;
	const series = new Map<string, SeriesPoint[]>();
	if (segments.length === 0) return series;

	const sorted = [...segments].sort((a, b) => a.t0 - b.t0);
	const from = options.fromMs ?? sorted[0].t0;
	const to = options.toMs ?? sorted[sorted.length - 1].t1;
	if (!(to > from)) return series;

	const modelKeys = actualModelKeys(sorted);
	if (modelKeys.length === 0) return series;

	for (
		let start = from;
		start + windowMs <= Math.max(to, from + windowMs);
		start += stepMs
	) {
		const end = start + windowMs;
		const inWindow = sorted.filter((s) => s.t0 >= start && s.t1 <= end);
		const result =
			inWindow.length > 0
				? fitWithIntervals(inWindow, {
						...options,
						seedParts: [...(options.seedParts ?? []), start],
					})
				: null;
		const exposure = exposureByKey(inWindow);
		for (const key of modelKeys) {
			const coef = result?.coefficients.find((c) => c.key === key) ?? null;
			const list = series.get(key) ?? [];
			list.push({
				windowStartMs: start,
				windowEndMs: end,
				pointEstimate: coef?.pointEstimate ?? null,
				ciLow: coef?.ciLow ?? null,
				ciHigh: coef?.ciHigh ?? null,
				impliedCapacityMtok: coef?.impliedCapacityMtok ?? null,
				identified: coef?.identified ?? false,
				nSegments: inWindow.length,
				unidentifiedReasons: coef
					? coef.unidentifiedReasons
					: reasonsWithoutColumn(exposure.get(key) ?? 0, inWindow.length),
			});
			series.set(key, list);
		}
		if (end >= to) break;
	}
	return series;
}
