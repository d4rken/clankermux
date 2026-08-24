import type { PredictionPoint } from "@clankermux/types";
import { getModelFamily } from "./model-mappings";
import {
	MAX_DELTA_GAP_MS,
	makePrng,
	withinWindowDeltas,
} from "./prediction-backtest";
import { isResetBoundary, splitSeries } from "./usage-prediction";

/**
 * Data-FEASIBILITY analyses for a request-ledger burn model (handover item 2).
 *
 * This module answers one question: **could** the recorded request ledger and
 * the polled utilization series support a per-(family, token-class)
 * percent-per-token model at all? It is a diagnostic. Nothing here estimates
 * anything for production, and no coefficient produced here is meant to be
 * used as a prediction — the fitted slopes exist so that a ratio can be
 * compared with another ratio (era stability), and the R-squared values exist
 * so that "there is no usable signal" can be said with a number attached.
 *
 * PURE: no DB, no clock, no `Math.random`. Arrays in, metrics out, exactly like
 * `prediction-backtest.ts`. The I/O lives in `scripts/ledger-feasibility.ts`.
 * Deliberately NOT re-exported from the package barrel, so nothing in the
 * running service can reach it.
 */

const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

export type LedgerWindowKind = "five_hour" | "seven_day";

/**
 * Where in a request's life its tokens are charged against the clock.
 *
 * `terminal` stamps the request at its recorded `timestamp` (when the response
 * completed); `start` stamps it at `timestamp - response_time_ms`. Which one
 * the provider's meter uses is unknown, so both are measured and the
 * difference between them is itself a stability check.
 */
export type BinAnchor = "terminal" | "start";

export const BIN_ANCHORS: readonly BinAnchor[] = ["terminal", "start"];

/**
 * Token classes kept SEPARATE on purpose: cache reads and cache writes are
 * priced differently from fresh input, so folding them together would fit one
 * coefficient to three different prices.
 */
export const TOKEN_CLASSES = [
	"input",
	"output",
	"cache_read",
	"cache_creation",
] as const;
export type TokenClass = (typeof TOKEN_CLASSES)[number];

/**
 * Model-family buckets for the design matrix.
 *
 * `getModelFamily` resolves Claude families only — every Codex/OpenAI slug, and
 * anything else a non-Anthropic provider serves, lands in `unresolved`. That
 * limitation is a STUDY SUBJECT, not an implementation detail to hide: the
 * `familyResolution` capability entry measures how much token mass falls into
 * this bucket, and a group whose mass is mostly unresolved cannot support a
 * per-family model no matter how good the aggregate correlation looks.
 */
export const FAMILY_KEYS = [
	"fable",
	"opus",
	"sonnet",
	"haiku",
	"unresolved",
] as const;
export type FamilyKey = (typeof FAMILY_KEYS)[number];

export const COLUMN_COUNT = FAMILY_KEYS.length * TOKEN_CLASSES.length;

/** Column index of one (family, token-class) cell of the design matrix. */
export function columnIndex(family: FamilyKey, tokenClass: TokenClass): number {
	return (
		FAMILY_KEYS.indexOf(family) * TOKEN_CLASSES.length +
		TOKEN_CLASSES.indexOf(tokenClass)
	);
}

/** Human-readable label of a design-matrix column. */
export function columnLabel(index: number): string {
	const family = FAMILY_KEYS[Math.floor(index / TOKEN_CLASSES.length)];
	const tokenClass = TOKEN_CLASSES[index % TOKEN_CLASSES.length];
	return `${family}/${tokenClass}`;
}

/** The family bucket a recorded `model` string falls into. */
export function familyKeyOf(model: string | null): FamilyKey {
	if (model == null) return "unresolved";
	return getModelFamily(model) ?? "unresolved";
}

/** One recorded request, reduced to what a burn model could read. */
export interface LedgerRequest {
	timestamp: number;
	accountId: string;
	model: string | null;
	/** Null means the duration was never recorded; `start` falls back to terminal. */
	responseTimeMs: number | null;
	billingType: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
}

/** A half-open `[fromMs, toMs)` stretch of wall-clock time. */
export interface TimeInterval {
	fromMs: number;
	toMs: number;
}

// ---------------------------------------------------------------------------
// Constants — every threshold this study judges anything by
// ---------------------------------------------------------------------------

/** Minimum observed fraction of a bin's width before the bin means anything. */
export const MIN_BIN_COVERAGE = 0.5;

/** Bins below this leave every primary metric `null`, never 0. */
export const MIN_USABLE_BINS = 50;

/** Bins with BOTH tokens and a rise; below this there is nothing to correlate. */
export const MIN_POSITIVE_SIGNAL_BINS = 20;

/** R-squared a cell must reach on the evaluation block to be called a signal. */
export const R2_PASS_THRESHOLD = 0.5;

/** Largest tolerated gap between the two anchors' evaluation R-squared. */
export const ANCHOR_STABILITY_MAX_GAP = 0.1;

/** Adjacent lags that must also clear the threshold at the selected width. */
export const MIN_ADJACENT_LAGS = 2;

/** How far a real cell must beat every control before the signal counts. */
export const CONTROL_MARGIN = 0.15;

/** Condition number above which the family x class design is not identifiable. */
export const IDENTIFIABILITY_MAX_CONDITION = 1e4;

/** Relative singular-value tolerance for the numerical rank. */
export const RANK_TOLERANCE = 1e-8;

/** Inverse-HHI account count below which one account is carrying the fit. */
export const EFFECTIVE_ACCOUNTS_MIN = 2.0;

/** Token-mass share above which a single account dominates the fit. */
export const MAX_ACCOUNT_SHARE = 0.6;

/** Pure bins a stratum needs on EACH side of an era boundary. */
export const MIN_ERA_STRATUM_BINS = 30;

/** Relative ratio change that counts as a material era shift. */
export const ERA_MATERIAL_SHIFT_FRACTION = 0.3;

/** Token mass that must resolve to a real family before per-family is possible. */
export const FAMILY_RESOLUTION_MIN_SHARE = 0.9;

/** Positive-delta mass allowed to have NO matching tokens at all. */
export const MAX_UNMATCHED_POSITIVE_DELTA_SHARE = 0.1;

/** Bin width the group-eligibility exposure floor is expressed in. */
export const GROUP_EQUIVALENT_BIN_MS = 2 * MINUTE_MS;

/** Equivalent 2-minute bins a group needs before it is evaluated at all. */
export const MIN_GROUP_EQUIVALENT_BINS = 1000;

/** Bootstrap resamples for the era-stability intervals. */
export const ERA_BOOTSTRAP_ITERATIONS = 1000;

/**
 * Groups that are excluded from the study outright, with the reason.
 *
 * Codex's five-hour window was retired by OpenAI on 2026-07-12. The committed
 * prediction backtest baseline (`docs/prediction-backtest-baseline.md`) records
 * what the column does now: `five_hour_reset` moves forward on every poll while
 * the percent stays 0, so each poll forms its own one-sample window. There is
 * no quota being consumed to correlate tokens against.
 */
export const EXCLUDED_GROUPS: readonly {
	provider: string;
	windowKind: LedgerWindowKind;
	reason: string;
}[] = [
	{
		provider: "codex",
		windowKind: "five_hour",
		reason:
			"OpenAI retired the Codex 5-hour window on 2026-07-12; the stored `five_hour_reset` advances on every poll while the percent stays 0, so each poll forms its own one-sample window (data-quality note, docs/prediction-backtest-baseline.md). There is no consumed quota to correlate tokens against.",
	},
];

export function excludedGroupReason(
	provider: string,
	windowKind: LedgerWindowKind,
): string | null {
	for (const g of EXCLUDED_GROUPS) {
		if (g.provider === provider && g.windowKind === windowKind) return g.reason;
	}
	return null;
}

/** Every capability answer is one of these. `null` statistics never pass. */
export type Verdict = "pass" | "fail" | "insufficient-evidence";

// ---------------------------------------------------------------------------
// Bins
// ---------------------------------------------------------------------------

/**
 * One time bin of one account's window.
 *
 * The bin spans the HALF-OPEN interval `(startMs, endMs]`, matching the
 * `(fromMs, toMs]` convention of an observed snapshot delta. That alignment is
 * load-bearing: a request stamped exactly on a delta's closing endpoint must
 * land in the same bin the delta's percent mass landed in, or the bin's token
 * mass and its percent mass would come from different intervals.
 */
export interface LedgerBin {
	accountId: string;
	/** EXCLUSIVE lower edge. */
	startMs: number;
	/** INCLUSIVE upper edge. */
	endMs: number;
	widthMs: number;
	/** Milliseconds of the bin covered by ACCEPTED snapshot deltas. */
	observedMs: number;
	/** `observedMs / widthMs`. */
	coverage: number;
	/** Signed percent change over the observed sub-intervals, pro-rated. */
	dPct: number;
	/** Per-(family, class) token sums; index via {@link columnIndex}. */
	tokens: Float64Array;
	/** Sum of `tokens`. */
	grossTokens: number;
	requestCount: number;
	/** A contributing delta was negative: a refund, not a burn. */
	hasRefund: boolean;
	/** A contributing snapshot endpoint sat at or above 100%. */
	saturated: boolean;
	/** A contributing request was billed as `overage`. */
	overage: boolean;
	/** Cache keepalive was running: traffic this ledger cannot attribute. */
	keepaliveActive: boolean;
	/** Coverage floor met AND no contamination flag: the CLEAN cohort. */
	usable: boolean;
}

export interface BuildBinsOptions {
	widthMs: number;
	/**
	 * Milliseconds a request's tokens are shifted before they are attributed.
	 * NEGATIVE lags attribute a bin's rise to tokens spent AFTER it — the
	 * future-token control, which must not score.
	 */
	lagMs: number;
	anchor: BinAnchor;
	/** Owner of both series; stamped on every bin so groups can be pooled. */
	accountId: string;
	/**
	 * Periods where the cache-keepalive counters moved, SORTED and DISJOINT.
	 * Informational only: it marks bins, it never excludes them.
	 */
	keepaliveActivePeriods?: readonly TimeInterval[];
}

/** Why a request contributed no tokens to any bin. */
export interface BinRequestDrops {
	/** The anchor time fell outside every reset-lifecycle segment. */
	outsideSegment: number;
	/** The LAG-SHIFTED time left the segment, or fell in a rejected gap. */
	outsideObservedInterval: number;
	/** Its bin was discarded for straddling a reset. */
	inDiscardedBin: number;
}

export interface LedgerBinSet {
	bins: LedgerBin[];
	/** Bins touched by more than one reset lifecycle; discarded, never scored. */
	resetCrossingBins: number;
	drops: BinRequestDrops;
}

/** Index of the bin whose `(startMs, endMs]` span contains `t`. */
export function binIndexOf(t: number, widthMs: number): number {
	return Math.ceil(t / widthMs) - 1;
}

interface ObservedInterval {
	fromMs: number;
	toMs: number;
	dPct: number;
	saturated: boolean;
}

interface MutableBin {
	index: number;
	segment: number;
	observedMs: number;
	dPct: number;
	tokens: Float64Array;
	grossTokens: number;
	requestCount: number;
	hasRefund: boolean;
	saturated: boolean;
	overage: boolean;
	resetCrossing: boolean;
}

/**
 * The accepted sub-intervals of one reset-lifecycle segment, with the endpoint
 * utilizations the acceptance rule itself does not carry.
 *
 * Acceptance is delegated wholesale to `withinWindowDeltas`, the same rule the
 * backtest harness uses, so "observed" means one thing across both tools: no
 * lifecycle straddle, no gap wider than `MAX_DELTA_GAP_MS`, positive elapsed
 * time. The pairs are then re-walked in lockstep to recover each accepted
 * delta's two endpoints — within a segment the accepted `(fromMs, toMs)` pairs
 * are unique, because a zero-length pair is rejected.
 */
function observedIntervalsOf(
	segment: readonly PredictionPoint[],
): ObservedInterval[] {
	const deltas = withinWindowDeltas(segment, MAX_DELTA_GAP_MS);
	const out: ObservedInterval[] = [];
	let k = 0;
	for (let i = 1; i < segment.length && k < deltas.length; i++) {
		const prev = segment[i - 1];
		const cur = segment[i];
		const delta = deltas[k];
		if (delta.fromMs !== prev.t || delta.toMs !== cur.t) continue;
		k++;
		out.push({
			fromMs: delta.fromMs,
			toMs: delta.toMs,
			dPct: delta.dPct,
			saturated: prev.utilization >= 100 || cur.utilization >= 100,
		});
	}
	return out;
}

/** The interval whose `(fromMs, toMs]` span contains `t`, or null. */
function findObservedInterval(
	intervals: readonly ObservedInterval[],
	t: number,
): ObservedInterval | null {
	let lo = 0;
	let hi = intervals.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const iv = intervals[mid];
		if (t <= iv.fromMs) hi = mid - 1;
		else if (t > iv.toMs) lo = mid + 1;
		else return iv;
	}
	return null;
}

function makeMutableBin(index: number, segment: number): MutableBin {
	return {
		index,
		segment,
		observedMs: 0,
		dPct: 0,
		tokens: new Float64Array(COLUMN_COUNT),
		grossTokens: 0,
		requestCount: 0,
		hasRefund: false,
		saturated: false,
		overage: false,
		resetCrossing: false,
	};
}

/**
 * Does `[startMs, endMs)` meet any period?
 *
 * PRECONDITION: `periods` is sorted ascending and disjoint. A run bins hundreds
 * of thousands of intervals against this list, so it is a binary search rather
 * than a scan; a caller that passes an unsorted or overlapping list gets wrong
 * answers rather than slow ones.
 */
function overlapsAny(
	startMs: number,
	endMs: number,
	periods: readonly TimeInterval[],
): boolean {
	let lo = 0;
	let hi = periods.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const p = periods[mid];
		if (p.toMs <= startMs) lo = mid + 1;
		else if (p.fromMs >= endMs) hi = mid - 1;
		else return true;
	}
	return false;
}

/**
 * Bin one account's window: percent mass and token mass over the SAME observed
 * intervals.
 *
 * The construction, in order:
 *
 *  1. The snapshot series is split into reset-lifecycle segments
 *     (`isResetBoundary`). Nothing is ever measured across a reset — a new
 *     window's percent is not a continuation of the old one's.
 *  2. Inside a segment, `withinWindowDeltas` decides which consecutive pairs
 *     count as OBSERVED. A pair rejected for a wide gap takes its whole
 *     interval out of the study, tokens included: a restart-shaped hole must
 *     not become a bin with tokens and no rise.
 *  3. A delta straddling a bin boundary is PRO-RATED linearly across the bins
 *     it overlaps, percent and milliseconds alike. Assigning it whole to the
 *     bin it ended in would credit up to a full sampler tick of burn to the
 *     wrong bin, which at a 2-minute width is the entire bin.
 *  4. A request counts only if its LAG-SHIFTED time lands inside an accepted
 *     sub-interval of the segment its unshifted anchor time belongs to. A lag
 *     that carries a request across a reset therefore drops it rather than
 *     moving its tokens into a window that never saw them.
 *  5. A bin touched by more than one segment straddles a reset and is
 *     DISCARDED. Its requests are counted as dropped, never silently lost.
 */
export function buildBins(
	snapshotSeries: readonly PredictionPoint[],
	requests: readonly LedgerRequest[],
	options: BuildBinsOptions,
): LedgerBinSet {
	const { widthMs, lagMs, anchor, accountId } = options;
	if (!(widthMs > 0)) throw new Error("buildBins: widthMs must be positive");
	const keepalive = options.keepaliveActivePeriods ?? [];
	const drops: BinRequestDrops = {
		outsideSegment: 0,
		outsideObservedInterval: 0,
		inDiscardedBin: 0,
	};

	const segments = splitSeries([...snapshotSeries], isResetBoundary);
	const intervalsBySegment = segments.map(observedIntervalsOf);
	const bins = new Map<number, MutableBin>();

	const touch = (index: number, segmentIndex: number): MutableBin => {
		let bin = bins.get(index);
		if (bin == null) {
			bin = makeMutableBin(index, segmentIndex);
			bins.set(index, bin);
		} else if (bin.segment !== segmentIndex) {
			bin.resetCrossing = true;
		}
		return bin;
	};

	for (let s = 0; s < segments.length; s++) {
		for (const iv of intervalsBySegment[s]) {
			const totalMs = iv.toMs - iv.fromMs;
			const firstIndex = binIndexOf(iv.fromMs + 1, widthMs);
			const lastIndex = binIndexOf(iv.toMs, widthMs);
			for (let index = firstIndex; index <= lastIndex; index++) {
				const binStart = index * widthMs;
				const binEnd = binStart + widthMs;
				const overlapMs =
					Math.min(iv.toMs, binEnd) - Math.max(iv.fromMs, binStart);
				if (!(overlapMs > 0)) continue;
				const bin = touch(index, s);
				bin.observedMs += overlapMs;
				bin.dPct += iv.dPct * (overlapMs / totalMs);
				if (iv.dPct < 0) bin.hasRefund = true;
				if (iv.saturated) bin.saturated = true;
			}
		}
	}

	// Segment spans, so a request can be placed without scanning every segment.
	const segmentBounds = segments.map((segment) => ({
		fromMs: segment[0].t,
		toMs: segment[segment.length - 1].t,
	}));

	for (const request of requests) {
		const anchorMs =
			anchor === "start" && request.responseTimeMs != null
				? request.timestamp - request.responseTimeMs
				: request.timestamp;
		let segmentIndex = -1;
		let lo = 0;
		let hi = segmentBounds.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const bounds = segmentBounds[mid];
			if (anchorMs < bounds.fromMs) hi = mid - 1;
			else if (anchorMs > bounds.toMs) lo = mid + 1;
			else {
				segmentIndex = mid;
				break;
			}
		}
		if (segmentIndex < 0) {
			drops.outsideSegment++;
			continue;
		}
		const shiftedMs = anchorMs + lagMs;
		// BOTH endpoints must be observed, and in the SAME lifecycle segment. The
		// shifted time alone is not enough: a request physically spent inside a
		// REJECTED sampling gap would otherwise have its tokens imported into a
		// neighbouring accepted interval by the lag, inventing burn the study
		// deliberately excluded along with the gap.
		const anchorInterval = findObservedInterval(
			intervalsBySegment[segmentIndex],
			anchorMs,
		);
		const interval =
			anchorInterval == null
				? null
				: findObservedInterval(intervalsBySegment[segmentIndex], shiftedMs);
		if (interval == null) {
			drops.outsideObservedInterval++;
			continue;
		}
		const bin = bins.get(binIndexOf(shiftedMs, widthMs));
		if (bin == null) {
			// Unreachable: the interval containing `shiftedMs` necessarily gave that
			// bin coverage. Counted rather than thrown so a study run cannot die on
			// an arithmetic edge.
			drops.outsideObservedInterval++;
			continue;
		}
		const family = familyKeyOf(request.model);
		const add = (tokenClass: TokenClass, amount: number) => {
			if (!(amount > 0)) return;
			bin.tokens[columnIndex(family, tokenClass)] += amount;
			bin.grossTokens += amount;
		};
		add("input", request.inputTokens);
		add("output", request.outputTokens);
		add("cache_read", request.cacheReadInputTokens);
		add("cache_creation", request.cacheCreationInputTokens);
		bin.requestCount++;
		if (request.billingType === "overage") bin.overage = true;
	}

	const out: LedgerBin[] = [];
	let resetCrossingBins = 0;
	for (const bin of [...bins.values()].sort((a, b) => a.index - b.index)) {
		if (bin.resetCrossing) {
			resetCrossingBins++;
			drops.inDiscardedBin += bin.requestCount;
			continue;
		}
		const startMs = bin.index * widthMs;
		const endMs = startMs + widthMs;
		const coverage = bin.observedMs / widthMs;
		out.push({
			accountId,
			startMs,
			endMs,
			widthMs,
			observedMs: bin.observedMs,
			coverage,
			dPct: bin.dPct,
			tokens: bin.tokens,
			grossTokens: bin.grossTokens,
			requestCount: bin.requestCount,
			hasRefund: bin.hasRefund,
			saturated: bin.saturated,
			overage: bin.overage,
			keepaliveActive: overlapsAny(startMs, endMs, keepalive),
			usable:
				coverage >= MIN_BIN_COVERAGE &&
				!bin.hasRefund &&
				!bin.saturated &&
				!bin.overage,
		});
	}
	return { bins: out, resetCrossingBins, drops };
}

// ---------------------------------------------------------------------------
// Bin census — what was dropped, and why
// ---------------------------------------------------------------------------

export interface BinCensus {
	total: number;
	usable: number;
	lowCoverage: number;
	refund: number;
	saturated: number;
	overage: number;
	keepaliveActive: number;
	positiveSignal: number;
	/** Observed milliseconds over ALL bins, contaminated ones included. */
	observedMs: number;
	/** `observedMs` expressed in 2-minute-equivalent bins. */
	equivalentBins: number;
	/** Observed milliseconds over the CLEAN cohort only. */
	usableObservedMs: number;
	/** `usableObservedMs` expressed in 2-minute-equivalent bins. */
	usableEquivalentBins: number;
}

/** True when the bin carries both a token mass and a rise. */
export function isPositiveSignal(bin: LedgerBin): boolean {
	return bin.grossTokens > 0 && bin.dPct > 0;
}

export function censusBins(bins: readonly LedgerBin[]): BinCensus {
	const census: BinCensus = {
		total: bins.length,
		usable: 0,
		lowCoverage: 0,
		refund: 0,
		saturated: 0,
		overage: 0,
		keepaliveActive: 0,
		positiveSignal: 0,
		observedMs: 0,
		equivalentBins: 0,
		usableObservedMs: 0,
		usableEquivalentBins: 0,
	};
	for (const bin of bins) {
		census.observedMs += bin.observedMs;
		if (bin.coverage < MIN_BIN_COVERAGE) census.lowCoverage++;
		if (bin.hasRefund) census.refund++;
		if (bin.saturated) census.saturated++;
		if (bin.overage) census.overage++;
		if (bin.keepaliveActive) census.keepaliveActive++;
		if (bin.usable) {
			census.usable++;
			census.usableObservedMs += bin.observedMs;
			if (isPositiveSignal(bin)) census.positiveSignal++;
		}
	}
	census.equivalentBins = census.observedMs / GROUP_EQUIVALENT_BIN_MS;
	census.usableEquivalentBins =
		census.usableObservedMs / GROUP_EQUIVALENT_BIN_MS;
	return census;
}

export function usableBins(bins: readonly LedgerBin[]): LedgerBin[] {
	return bins.filter((b) => b.usable);
}

// ---------------------------------------------------------------------------
// Small numerics
// ---------------------------------------------------------------------------

/**
 * Ordinary R-squared of `y = b*x` fitted WITHOUT an intercept.
 *
 * No intercept by construction: a bin with no tokens must predict no rise. An
 * intercept would absorb exactly the thing being tested — a per-bin baseline
 * burn that the ledger does not explain — and inflate the fit.
 *
 * Consequently `ss_tot` is the UNCENTERED sum of squares, so the number is the
 * uncentered R-squared and is not comparable with a centred one. Null when
 * either sum of squares is zero: no variation to explain is not a perfect fit.
 */
export function noInterceptR2(
	xs: readonly number[],
	ys: readonly number[],
): { r2: number | null; slope: number | null } {
	let sxx = 0;
	let sxy = 0;
	let syy = 0;
	for (let i = 0; i < xs.length; i++) {
		sxx += xs[i] * xs[i];
		sxy += xs[i] * ys[i];
		syy += ys[i] * ys[i];
	}
	if (!(sxx > 0) || !(syy > 0)) return { r2: null, slope: null };
	const slope = sxy / sxx;
	let ssRes = 0;
	for (let i = 0; i < xs.length; i++) {
		const residual = ys[i] - slope * xs[i];
		ssRes += residual * residual;
	}
	return { r2: 1 - ssRes / syy, slope };
}

/**
 * Eigenvalues of a SYMMETRIC matrix, descending, by the cyclic Jacobi method.
 *
 * The design matrix here is at most 20 columns wide, so the Gram matrix is
 * tiny and a rotation-based solver is both exact enough and fully
 * deterministic — no random starts, no iteration order that depends on input
 * ordering.
 */
export function symmetricEigenvalues(
	input: readonly (readonly number[])[],
): number[] {
	const n = input.length;
	if (n === 0) return [];
	const a = input.map((row) => [...row]);
	for (let sweep = 0; sweep < 100; sweep++) {
		let off = 0;
		for (let p = 0; p < n; p++) {
			for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
		}
		if (off <= 1e-30) break;
		for (let p = 0; p < n; p++) {
			for (let q = p + 1; q < n; q++) {
				if (a[p][q] === 0) continue;
				const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
				const sign = theta >= 0 ? 1 : -1;
				const t = sign / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
				const c = 1 / Math.sqrt(t * t + 1);
				const s = t * c;
				for (let k = 0; k < n; k++) {
					const akp = a[k][p];
					const akq = a[k][q];
					a[k][p] = c * akp - s * akq;
					a[k][q] = s * akp + c * akq;
				}
				for (let k = 0; k < n; k++) {
					const apk = a[p][k];
					const aqk = a[q][k];
					a[p][k] = c * apk - s * aqk;
					a[q][k] = s * apk + c * aqk;
				}
			}
		}
	}
	const values: number[] = [];
	for (let i = 0; i < n; i++) values.push(a[i][i]);
	return values.sort((x, y) => y - x);
}

/**
 * UNCENTERED correlation (the cosine) of two equal-length columns.
 *
 * Deliberately not Pearson. The design has no intercept, so the relevant
 * geometry is the raw one: two columns are interchangeable exactly when their
 * vectors point the same way. Centring would call a pair of columns that never
 * co-occur — say opus/input and sonnet/input in bins that only ever hold one
 * family — perfectly ANTI-correlated at -1, when in the fit they are
 * orthogonal and perfectly separable. That is the opposite of the truth this
 * table is asked for.
 */
export function uncenteredCorrelation(
	xs: readonly number[],
	ys: readonly number[],
): number | null {
	let sxx = 0;
	let syy = 0;
	let sxy = 0;
	for (let i = 0; i < xs.length; i++) {
		sxx += xs[i] * xs[i];
		syy += ys[i] * ys[i];
		sxy += xs[i] * ys[i];
	}
	if (!(sxx > 0) || !(syy > 0)) return null;
	return sxy / Math.sqrt(sxx * syy);
}

/** Nearest-rank percentile over an ASCENDING array. Empty => null. */
function percentile(sorted: readonly number[], p: number): number | null {
	if (sorted.length === 0) return null;
	const rank = Math.min(
		sorted.length,
		Math.max(1, Math.ceil(p * sorted.length)),
	);
	return sorted[rank - 1];
}

// ---------------------------------------------------------------------------
// aggregateRelation
// ---------------------------------------------------------------------------

export interface AggregateRelation {
	/** Uncentered R-squared of gross tokens against dPct, no intercept. */
	r2: number | null;
	/** Percent per million gross tokens. A DIAGNOSTIC, never a prediction. */
	slopePctPerMillionTokens: number | null;
	usableBins: number;
	positiveSignalBins: number;
	accounts: number;
	/** True when a minimum was not met, so the nulls above mean "unknown". */
	insufficient: boolean;
}

/**
 * Gross-token-vs-percent relation over the CLEAN cohort of one group.
 *
 * Bins from every account in the group are POOLED into one fit. That pooling
 * assumes a single percent-per-token price across the group's accounts, which
 * is not guaranteed — a Max 5x and a Max 20x account on the same window would
 * have different prices. The assumption is deliberate and is reported:
 * `concentration` shows whether one account is carrying the pooled number, and
 * the tier-provenance entry states that the recorded history cannot say whether
 * the tiers even differed. Fitting per account instead would put most accounts
 * below `MIN_USABLE_BINS` and answer nothing.
 */
export function aggregateRelation(
	bins: readonly LedgerBin[],
): AggregateRelation {
	const clean = usableBins(bins);
	const accounts = new Set(clean.map((b) => b.accountId)).size;
	const positive = clean.filter(isPositiveSignal).length;
	const insufficient =
		clean.length < MIN_USABLE_BINS || positive < MIN_POSITIVE_SIGNAL_BINS;
	if (insufficient) {
		return {
			r2: null,
			slopePctPerMillionTokens: null,
			usableBins: clean.length,
			positiveSignalBins: positive,
			accounts,
			insufficient: true,
		};
	}
	const xs = clean.map((b) => b.grossTokens);
	const ys = clean.map((b) => b.dPct);
	const { r2, slope } = noInterceptR2(xs, ys);
	return {
		r2,
		slopePctPerMillionTokens: slope == null ? null : slope * 1_000_000,
		usableBins: clean.length,
		positiveSignalBins: positive,
		accounts,
		insufficient: false,
	};
}

// ---------------------------------------------------------------------------
// conditionalObservability
// ---------------------------------------------------------------------------

export interface ConditionalObservability {
	/** P(dPct = 0 | tokens > 0) over the clean cohort. */
	silentBurnRate: number | null;
	silentBurnCount: number;
	tokenBearingBins: number;
	/** P(tokens = 0 | dPct > 0) over the clean cohort. */
	unexplainedRiseRate: number | null;
	unexplainedRiseCount: number;
	risingBins: number;
	usableBins: number;
	insufficient: boolean;
}

/**
 * How often the two series disagree about whether anything happened.
 *
 * Both directions matter and they fail differently. A bin with tokens and no
 * rise is the QUANTISATION floor made visible: the percent column is integer,
 * so on the 5-hour window one unit is three minutes of headroom and a small
 * burn simply does not move it. A bin with a rise and no tokens is a
 * COMPLETENESS hole: something consumed quota that the ledger has no row for.
 */
export function conditionalObservability(
	bins: readonly LedgerBin[],
): ConditionalObservability {
	const clean = usableBins(bins);
	const positive = clean.filter(isPositiveSignal).length;
	const insufficient =
		clean.length < MIN_USABLE_BINS || positive < MIN_POSITIVE_SIGNAL_BINS;
	let tokenBearing = 0;
	let silent = 0;
	let rising = 0;
	let unexplained = 0;
	for (const bin of clean) {
		if (bin.grossTokens > 0) {
			tokenBearing++;
			if (bin.dPct === 0) silent++;
		}
		if (bin.dPct > 0) {
			rising++;
			if (bin.grossTokens === 0) unexplained++;
		}
	}
	if (insufficient) {
		return {
			silentBurnRate: null,
			silentBurnCount: silent,
			tokenBearingBins: tokenBearing,
			unexplainedRiseRate: null,
			unexplainedRiseCount: unexplained,
			risingBins: rising,
			usableBins: clean.length,
			insufficient: true,
		};
	}
	return {
		silentBurnRate: tokenBearing > 0 ? silent / tokenBearing : null,
		silentBurnCount: silent,
		tokenBearingBins: tokenBearing,
		unexplainedRiseRate: rising > 0 ? unexplained / rising : null,
		unexplainedRiseCount: unexplained,
		risingBins: rising,
		usableBins: clean.length,
		insufficient: false,
	};
}

// ---------------------------------------------------------------------------
// identifiability
// ---------------------------------------------------------------------------

export interface IdentifiabilityColumn {
	index: number;
	label: string;
	/** L2 norm of the raw column: the scale each column is standardized by. */
	norm: number;
	/** Bins in which this column is non-zero. */
	support: number;
	tokenShare: number;
}

export interface IdentifiabilityPair {
	a: string;
	b: string;
	correlation: number;
}

export interface Identifiability {
	usableBins: number;
	activeColumns: number;
	columns: IdentifiabilityColumn[];
	/** Singular values of the UNIT-SCALED design matrix, descending. */
	singularValues: number[];
	conditionNumber: number | null;
	rank: number | null;
	/** Column pairs whose uncentered correlation exceeds 0.9, worst first. */
	collinearPairs: IdentifiabilityPair[];
	identifiable: boolean;
	insufficient: boolean;
}

/**
 * Can the intended family x token-class design be told apart at all?
 *
 * The columns are scaled to unit norm before the decomposition, so the
 * condition number describes the design's GEOMETRY rather than the fact that
 * cache-read counts run three orders of magnitude above output counts. Without
 * that scaling every design would look catastrophically conditioned for a
 * reason that a fit would simply absorb.
 *
 * Identifiable means: full numerical rank over the columns that carry any mass
 * at all, AND a condition number inside `IDENTIFIABILITY_MAX_CONDITION`. Both
 * are needed. Rank alone passes a design where two columns differ only by
 * rounding, which fits but cannot ATTRIBUTE — and attribution by family and
 * class is the entire point of the proposed model.
 */
export function identifiability(bins: readonly LedgerBin[]): Identifiability {
	const clean = usableBins(bins);
	const positive = clean.filter(isPositiveSignal).length;
	const insufficient =
		clean.length < MIN_USABLE_BINS || positive < MIN_POSITIVE_SIGNAL_BINS;

	let totalTokens = 0;
	const norms = new Float64Array(COLUMN_COUNT);
	const support = new Int32Array(COLUMN_COUNT);
	const sums = new Float64Array(COLUMN_COUNT);
	for (const bin of clean) {
		for (let c = 0; c < COLUMN_COUNT; c++) {
			const v = bin.tokens[c];
			if (v === 0) continue;
			norms[c] += v * v;
			support[c]++;
			sums[c] += v;
			totalTokens += v;
		}
	}
	const columns: IdentifiabilityColumn[] = [];
	const active: number[] = [];
	for (let c = 0; c < COLUMN_COUNT; c++) {
		const norm = Math.sqrt(norms[c]);
		if (support[c] > 0) active.push(c);
		if (support[c] === 0 && sums[c] === 0) continue;
		columns.push({
			index: c,
			label: columnLabel(c),
			norm,
			support: support[c],
			tokenShare: totalTokens > 0 ? sums[c] / totalTokens : 0,
		});
	}

	if (insufficient || active.length === 0) {
		return {
			usableBins: clean.length,
			activeColumns: active.length,
			columns,
			singularValues: [],
			conditionNumber: null,
			rank: null,
			collinearPairs: [],
			identifiable: false,
			insufficient: true,
		};
	}

	// Unit-scaled columns, then the Gram matrix; the design is tall and thin, so
	// the Gram matrix is the cheap route to the singular values.
	const scaled: number[][] = active.map((c) => {
		const norm = Math.sqrt(norms[c]);
		return clean.map((bin) => (norm > 0 ? bin.tokens[c] / norm : 0));
	});
	const k = active.length;
	const gram: number[][] = [];
	for (let i = 0; i < k; i++) {
		const row: number[] = [];
		for (let j = 0; j < k; j++) {
			let acc = 0;
			for (let r = 0; r < clean.length; r++) acc += scaled[i][r] * scaled[j][r];
			row.push(acc);
		}
		gram.push(row);
	}
	const eigenvalues = symmetricEigenvalues(gram);
	const singularValues = eigenvalues.map((v) => Math.sqrt(Math.max(0, v)));
	const smax = singularValues.length ? singularValues[0] : 0;
	const smin = singularValues.length
		? singularValues[singularValues.length - 1]
		: 0;
	const rank = singularValues.filter((s) => s > RANK_TOLERANCE * smax).length;
	const conditionNumber = smin > 0 ? smax / smin : null;

	const collinearPairs: IdentifiabilityPair[] = [];
	for (let i = 0; i < k; i++) {
		for (let j = i + 1; j < k; j++) {
			const r = uncenteredCorrelation(scaled[i], scaled[j]);
			if (r != null && Math.abs(r) > 0.9) {
				collinearPairs.push({
					a: columnLabel(active[i]),
					b: columnLabel(active[j]),
					correlation: r,
				});
			}
		}
	}
	collinearPairs.sort(
		(x, y) =>
			Math.abs(y.correlation) - Math.abs(x.correlation) ||
			x.a.localeCompare(y.a) ||
			x.b.localeCompare(y.b),
	);

	return {
		usableBins: clean.length,
		activeColumns: active.length,
		columns,
		singularValues,
		conditionNumber,
		rank,
		collinearPairs,
		identifiable:
			rank === active.length &&
			conditionNumber != null &&
			conditionNumber <= IDENTIFIABILITY_MAX_CONDITION,
		insufficient: false,
	};
}

// ---------------------------------------------------------------------------
// concentration
// ---------------------------------------------------------------------------

export interface AccountConcentration {
	accountId: string;
	usableBins: number;
	positiveSignalBins: number;
	tokenMass: number;
	tokenShare: number;
	/** R-squared of the group with THIS account removed, or null. */
	leaveOneOutR2: number | null;
}

export interface Concentration {
	accounts: AccountConcentration[];
	/** Inverse Herfindahl index over token shares: accounts that actually count. */
	effectiveAccounts: number | null;
	maxAccountShare: number | null;
	pooledR2: number | null;
	pass: boolean;
	insufficient: boolean;
}

/**
 * Whether the group's number is a group's number or one account's.
 *
 * Six accounts of which one produced 95% of the tokens is a one-account study
 * wearing a six-account label, and the previous handover round already found
 * that six accounts cannot make a bootstrap interval narrow. The inverse HHI
 * says how many accounts the mass behaves like; leave-one-out says whether the
 * relation survives dropping any one of them.
 *
 * `byAccount` is a SELECTOR rather than the bin's own `accountId` so the same
 * function can be run over permuted labels as a control.
 */
export function concentration(
	bins: readonly LedgerBin[],
	byAccount: (bin: LedgerBin) => string,
): Concentration {
	const clean = usableBins(bins);
	const positive = clean.filter(isPositiveSignal).length;
	const insufficient =
		clean.length < MIN_USABLE_BINS || positive < MIN_POSITIVE_SIGNAL_BINS;

	const grouped = new Map<string, LedgerBin[]>();
	for (const bin of clean) {
		const key = byAccount(bin);
		const list = grouped.get(key);
		if (list) list.push(bin);
		else grouped.set(key, [bin]);
	}
	let totalTokens = 0;
	for (const bin of clean) totalTokens += bin.grossTokens;

	const pooled = noInterceptR2(
		clean.map((b) => b.grossTokens),
		clean.map((b) => b.dPct),
	).r2;

	const accounts: AccountConcentration[] = [];
	let hhi = 0;
	let maxShare = 0;
	for (const key of [...grouped.keys()].sort()) {
		const own = grouped.get(key) ?? [];
		let mass = 0;
		for (const bin of own) mass += bin.grossTokens;
		const share = totalTokens > 0 ? mass / totalTokens : 0;
		hhi += share * share;
		maxShare = Math.max(maxShare, share);
		const rest = clean.filter((bin) => byAccount(bin) !== key);
		const leaveOneOutR2 =
			rest.length >= MIN_USABLE_BINS
				? noInterceptR2(
						rest.map((b) => b.grossTokens),
						rest.map((b) => b.dPct),
					).r2
				: null;
		accounts.push({
			accountId: key,
			usableBins: own.length,
			positiveSignalBins: own.filter(isPositiveSignal).length,
			tokenMass: mass,
			tokenShare: share,
			leaveOneOutR2,
		});
	}

	const effectiveAccounts = hhi > 0 ? 1 / hhi : null;
	if (insufficient || accounts.length === 0) {
		return {
			accounts,
			effectiveAccounts,
			maxAccountShare: accounts.length > 0 ? maxShare : null,
			pooledR2: null,
			pass: false,
			insufficient: true,
		};
	}
	return {
		accounts,
		effectiveAccounts,
		maxAccountShare: maxShare,
		pooledR2: pooled,
		pass:
			effectiveAccounts != null &&
			effectiveAccounts >= EFFECTIVE_ACCOUNTS_MIN &&
			maxShare <= MAX_ACCOUNT_SHARE,
		insufficient: false,
	};
}

/**
 * A deterministic DERANGEMENT of account labels, for the placebo control.
 *
 * Sattolo's algorithm — the inner draw is STRICTLY below `i`, not up to it —
 * driven by the shared seeded xorshift. The result is a single cyclic
 * permutation, so with at least two accounts every account is mapped to a
 * DIFFERENT one. Plain Fisher-Yates would not do: it can return the identity,
 * and an identity "permutation" hands the control the real pairing, letting a
 * genuine relation score as its own placebo.
 */
export function permuteAccountLabels(
	bins: readonly LedgerBin[],
	seed: number,
): Map<string, string> {
	const labels = [...new Set(bins.map((b) => b.accountId))].sort();
	const shuffled = [...labels];
	const rand = makePrng(seed);
	for (let i = shuffled.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * i);
		const tmp = shuffled[i];
		shuffled[i] = shuffled[j];
		shuffled[j] = tmp;
	}
	const map = new Map<string, string>();
	for (let i = 0; i < labels.length; i++) map.set(labels[i], shuffled[i]);
	return map;
}

/** A permutation control that could not be run at all. */
export function unmeasuredPermutationControl(
	seed: number,
	detail: string,
): PermutationControl {
	return {
		seed,
		r2: null,
		treatmentR2: null,
		accounts: 0,
		pairedBins: 0,
		insufficient: true,
		detail,
	};
}

/**
 * The permutation PLACEBO for the relation itself, at the ACCOUNT level.
 *
 * Each account's token series is fitted against a DIFFERENT account's percent
 * series over the bins the two accounts SHARE: a recipient bin takes part only
 * when its donor has a bin with the IDENTICAL edges, so both series describe the
 * same wall-clock interval. The permutation is a derangement, so no account is
 * ever paired with itself.
 *
 * The unit of permutation is the account on purpose. Shuffling individual bins
 * would destroy the within-account autocorrelation of both series as well as
 * the pairing, so it measures a much weaker null than the one that matters:
 * whether tokens explain THIS account's percent, or merely look like what any
 * busy account's percent does. Only the pairing may be broken.
 *
 * The MATCHED cohort is also the only cohort either number is fitted over.
 * `treatmentR2` refits each recipient's own percent on exactly the bins that
 * survived the join, so the margin the caller computes compares two fits of the
 * same bins. Pairing by ordinal position and truncating to the shorter series
 * would instead compare the whole group's fit against a placebo scored on a
 * smaller, differently-composed subset, and any difference between the two
 * could be the cohorts rather than the pairing.
 *
 * The evidence floor is SYMMETRIC, and that is load-bearing. The matched cohort
 * must carry at least `MIN_POSITIVE_SIGNAL_BINS` bins where the RECIPIENT spent
 * tokens and rose (the treatment's own signal) AND at least that many where the
 * recipient spent tokens while the DONOR rose (the placebo's). Requiring only
 * the treatment side lets two accounts that are busy at different times produce
 * a placebo fitted almost entirely on donor bins that never moved: its
 * R-squared is near zero for want of coincidences rather than for want of a
 * relation, and the margin over it is manufactured, not measured. A placebo
 * that had no opportunity to score has not been beaten.
 *
 * `null` whenever the control cannot be run — fewer than two accounts, a
 * permutation that somehow fixed a point, or a matched cohort below the same
 * minimums the real fit must reach on either side. A null control is NOT a
 * beaten control; the caller must treat it as insufficient evidence.
 */
export function permutedAccountRelationR2(
	bins: readonly LedgerBin[],
	seed: number,
): PermutationControl {
	const clean = usableBins(bins);
	const byAccount = new Map<string, Map<number, LedgerBin>>();
	for (const bin of clean) {
		let own = byAccount.get(bin.accountId);
		if (own == null) {
			own = new Map<number, LedgerBin>();
			byAccount.set(bin.accountId, own);
		}
		own.set(bin.startMs, bin);
	}
	const accountIds = [...byAccount.keys()].sort();

	const unmeasurable = (detail: string, pairedBins: number) => ({
		seed,
		r2: null,
		treatmentR2: null,
		accounts: accountIds.length,
		pairedBins,
		insufficient: true,
		detail,
	});

	if (accountIds.length < 2) {
		return unmeasurable(
			`an account permutation needs at least two accounts in the clean cohort; this group has ${accountIds.length}`,
			0,
		);
	}

	const donorOf = permuteAccountLabels(clean, seed);
	const fixedPoints = accountIds.filter(
		(id) => (donorOf.get(id) ?? id) === id,
	).length;
	if (fixedPoints > 0) {
		return unmeasurable(
			`the seeded permutation left ${fixedPoints} of ${accountIds.length} accounts mapped to themselves, so it is not a permutation of anything`,
			0,
		);
	}

	// The matched cohort: recipient bins whose donor has a bin with the same
	// edges. Both fits below read these bins and nothing else.
	const xs: number[] = [];
	const placeboYs: number[] = [];
	const treatmentYs: number[] = [];
	// Positive-signal bins of each fit, counted separately: the treatment's are
	// the recipient's own tokens against its own rise, the placebo's the same
	// tokens against the DONOR's rise. Only the treatment side is the ordinary
	// `isPositiveSignal`; the placebo needs its own count because a bin can be a
	// signal for one fit and a silent bin for the other.
	let treatmentPositiveBins = 0;
	let placeboPositiveBins = 0;
	for (const id of accountIds) {
		const own = byAccount.get(id);
		const donorId = donorOf.get(id);
		const donor = donorId == null ? null : byAccount.get(donorId);
		if (own == null || donor == null) continue;
		for (const startMs of [...own.keys()].sort((a, b) => a - b)) {
			const mine = own.get(startMs);
			const theirs = donor.get(startMs);
			if (mine == null || theirs == null) continue;
			xs.push(mine.grossTokens);
			treatmentYs.push(mine.dPct);
			placeboYs.push(theirs.dPct);
			if (mine.grossTokens > 0 && mine.dPct > 0) treatmentPositiveBins++;
			if (mine.grossTokens > 0 && theirs.dPct > 0) placeboPositiveBins++;
		}
	}
	if (
		xs.length < MIN_USABLE_BINS ||
		treatmentPositiveBins < MIN_POSITIVE_SIGNAL_BINS ||
		placeboPositiveBins < MIN_POSITIVE_SIGNAL_BINS
	) {
		return unmeasurable(
			`${xs.length} bins matched on identical edges between an account and its donor (${treatmentPositiveBins} positive-signal for the treatment, ${placeboPositiveBins} for the placebo), against the same minimums the real fit must reach, ${MIN_USABLE_BINS} matched bins and ${MIN_POSITIVE_SIGNAL_BINS} positive-signal bins on EACH side — a placebo with no coincidences to score on scores near zero for want of opportunity, not for want of a relation`,
			xs.length,
		);
	}
	const placeboR2 = noInterceptR2(xs, placeboYs).r2;
	const treatmentR2 = noInterceptR2(xs, treatmentYs).r2;
	if (placeboR2 == null || treatmentR2 == null) {
		return unmeasurable(
			"the matched cohort had no variation to explain on one side of the comparison, so no placebo margin exists",
			xs.length,
		);
	}
	return {
		seed,
		r2: placeboR2,
		treatmentR2,
		accounts: accountIds.length,
		pairedBins: xs.length,
		insufficient: false,
		detail: `${accountIds.length} accounts deranged onto each other over ${xs.length} bins matched on identical edges (${treatmentPositiveBins} positive-signal for the treatment, ${placeboPositiveBins} for the placebo); treatment and placebo are fitted over that same cohort, and no account kept its own percent series`,
	};
}

// ---------------------------------------------------------------------------
// selectCell
// ---------------------------------------------------------------------------

export interface CellKey {
	lagMs: number;
	widthMs: number;
	anchor: BinAnchor;
}

export interface BlockScore {
	r2: number | null;
	usableBins: number;
	positiveSignalBins: number;
}

export interface CellScore {
	cell: CellKey;
	/** Scored on the SELECTION block. Chooses; never reported as the result. */
	selection: BlockScore;
	/** Scored on the disjoint EVALUATION block. The only reportable number. */
	evaluation: BlockScore;
	/** A future-token control (negative lag): scored, never selectable. */
	control: boolean;
}

export interface PermutationControl {
	seed: number;
	/** Uncentered R-squared of the permuted pairing. `null` = unmeasurable. */
	r2: number | null;
	/**
	 * The SAME cohort refitted with each account's own percent series.
	 *
	 * The placebo margin is `treatmentR2 - r2`, both sides of it computed over
	 * the matched bins and nothing else. Comparing the placebo against the
	 * group's full-cohort score instead would let a difference in cohort
	 * composition masquerade as a difference in pairing.
	 */
	treatmentR2: number | null;
	/** Accounts whose series took part in the permutation. */
	accounts: number;
	/** Bins of the matched cohort both R-squareds were fitted over. */
	pairedBins: number;
	/** True exactly when `r2` is null: nothing was measured, so nothing is beaten. */
	insufficient: boolean;
	/** Why the control says what it says, verbatim into the report. */
	detail: string;
}

export interface CellSelection {
	selected: CellKey | null;
	selectionR2: number | null;
	evaluationR2: number | null;
	tieBreak: string;
	/** True only when every stability sub-check was measured AND held. */
	stabilityPass: boolean;
	/**
	 * False when a stability sub-check needed a number nothing produced.
	 *
	 * An unmeasurable sub-check is not a failed one: it leaves its own question
	 * open, exactly like an unmeasurable control, and follows the same
	 * precedence.
	 */
	stabilityMeasurable: boolean;
	/** True when a sub-check had every input it needed and was violated anyway. */
	stabilityMeasuredFailure: boolean;
	stabilityDetails: string[];
	controlsPass: boolean;
	/** False when a mandatory control produced no number: nothing was beaten. */
	controlsMeasurable: boolean;
	controlDetails: string[];
	verdict: Verdict;
	verdictDetail: string;
}

function cellLabel(cell: CellKey): string {
	return `L=${cell.lagMs / MINUTE_MS}min W=${cell.widthMs / MINUTE_MS}min ${cell.anchor}`;
}

function sameCell(a: CellKey, b: CellKey): boolean {
	return (
		a.lagMs === b.lagMs && a.widthMs === b.widthMs && a.anchor === b.anchor
	);
}

/**
 * Pick one (lag, width, anchor) cell on the selection block and report it on
 * the evaluation block.
 *
 * BLOCKED, not cross-validated: the cell is chosen by its SELECTION-block
 * score and every number that follows comes from a disjoint later block. A
 * sweep of dozens of cells scored and reported on the same data would find its
 * best-looking cell whether or not any relation exists, which is the failure
 * this whole split exists to prevent.
 *
 * The tie-break is fully deterministic — highest selection R-squared, then the
 * WIDEST bin (less quantisation noise per bin), then the SMALLEST absolute lag
 * (a smaller unexplained delay is a smaller assumption), then the terminal
 * anchor — so re-running the study cannot silently pick a different cell.
 *
 * A selected cell is only VALID if it also survives:
 *  - both anchors clearing the threshold on the evaluation block, within
 *    `ANCHOR_STABILITY_MAX_GAP` of each other. A relation that exists under one
 *    anchor and not the other is a relation with the timestamps, not the tokens.
 *  - at least `MIN_ADJACENT_LAGS` neighbouring lags at the same width also
 *    clearing it. A single isolated lag spike is a coincidence.
 *  - beating EVERY mandatory control by `CONTROL_MARGIN`: the future-token
 *    lags, which attribute a bin's rise to tokens spent wholly after it, and
 *    the seeded account permutation, which attributes it to another account's
 *    tokens. A study whose placebo scores as well as its treatment has measured
 *    its own arithmetic. The permutation's margin is the one it carries itself,
 *    treatment minus placebo over its MATCHED cohort, so both terms describe
 *    the same bins.
 *
 * Three properties of that control gate are load-bearing:
 *
 *  - Only the controls at the SELECTED cell's width AND anchor count. A control
 *    is a like-for-like comparison; scoring a 10-minute cell against a
 *    2-minute control compares two different quantisation regimes and says
 *    nothing about the pairing.
 *  - A control with NO number is not a beaten control. An unmeasurable placebo
 *    leaves ITS OWN question open, so a cell that clears everything else is
 *    insufficient evidence rather than a pass.
 *  - It cannot, however, reopen a question something else already answered. A
 *    measured control that was not beaten, an evaluation score below the
 *    threshold and a MEASURED stability failure each REFUTE the cell on their
 *    own, and are checked before any unmeasurable check is consulted. Ordering
 *    it the other way lets a placebo that could not be run launder a measured
 *    failure into "we do not know".
 *
 * The stability checks obey the same three-outcome rule as the controls, and
 * for the same reason. A sub-check whose inputs are all present and violated is
 * a MEASURED failure and refutes the cell; a sub-check missing a score it reads
 * is UNMEASURABLE and only leaves its own question open, so a cell that clears
 * everything else alongside one is insufficient evidence rather than a failure.
 * Collapsing "no number" into "did not hold" would report a stability failure
 * nothing ever measured.
 */
export function selectCell(
	cellsByBlock: readonly CellScore[],
	permutation: PermutationControl,
): CellSelection {
	const candidates = cellsByBlock.filter(
		(c) => !c.control && c.selection.r2 != null,
	);
	if (candidates.length === 0) {
		return {
			selected: null,
			selectionR2: null,
			evaluationR2: null,
			tieBreak: "no cell produced a selection-block score",
			stabilityPass: false,
			stabilityMeasurable: false,
			stabilityMeasuredFailure: false,
			stabilityDetails: [],
			controlsPass: false,
			controlsMeasurable: false,
			controlDetails: [],
			verdict: "insufficient-evidence",
			verdictDetail:
				"No cell reached the minimum usable and positive-signal bin counts on the selection block.",
		};
	}
	const ranked = [...candidates].sort(
		(a, b) =>
			(b.selection.r2 ?? 0) - (a.selection.r2 ?? 0) ||
			b.cell.widthMs - a.cell.widthMs ||
			Math.abs(a.cell.lagMs) - Math.abs(b.cell.lagMs) ||
			(a.cell.anchor === b.cell.anchor
				? 0
				: a.cell.anchor === "terminal"
					? -1
					: 1),
	);
	const winner = ranked[0];
	const selected = winner.cell;

	// --- stability -----------------------------------------------------------
	//
	// Each sub-check answers with one of THREE outcomes, never two. It fails only
	// when the numbers that would establish a violation are all present and do
	// violate it; when a number it needs was never produced, the sub-check is
	// UNMEASURABLE and says nothing at all. Collapsing the two into `false` would
	// report a stability failure that was never measured, and treating a null as
	// a pass would do the mirror-image damage.
	const stabilityDetails: string[] = [];
	/** Sub-checks that could not be judged, named for the report. */
	const unmeasurableStabilityChecks: string[] = [];
	let stabilityMeasuredFailure = false;

	const atSameLagWidth = cellsByBlock.filter(
		(c) =>
			c.cell.lagMs === selected.lagMs && c.cell.widthMs === selected.widthMs,
	);
	const anchorScores = new Map<BinAnchor, number | null>();
	for (const c of atSameLagWidth)
		anchorScores.set(c.cell.anchor, c.evaluation.r2);
	const terminal = anchorScores.get("terminal") ?? null;
	const start = anchorScores.get("start") ?? null;
	// An anchor that HAS a score below the threshold refutes the check on its
	// own, whatever the other anchor did: one anchor measurably failing is enough
	// for "the relation does not hold under both". Only when neither present
	// score refutes it does a missing score leave the question open.
	const anchorBelowThreshold =
		(terminal != null && terminal < R2_PASS_THRESHOLD) ||
		(start != null && start < R2_PASS_THRESHOLD);
	const anchorScoreMissing = terminal == null || start == null;
	let anchorNote = "";
	if (anchorBelowThreshold) {
		stabilityMeasuredFailure = true;
	} else if (anchorScoreMissing) {
		unmeasurableStabilityChecks.push("both anchors clearing the threshold");
		anchorNote =
			" — UNMEASURABLE: an anchor produced no evaluation score, so nothing says whether the relation holds under both";
	}
	const bothAnchorsPass = !anchorBelowThreshold && !anchorScoreMissing;
	stabilityDetails.push(
		`evaluation R2 terminal ${fmtOrDash(terminal)} / start ${fmtOrDash(start)} against threshold ${R2_PASS_THRESHOLD}${anchorNote}`,
	);

	const anchorGap =
		terminal != null && start != null ? Math.abs(terminal - start) : null;
	const anchorGapOk =
		anchorGap != null && anchorGap <= ANCHOR_STABILITY_MAX_GAP;
	let anchorGapNote = "";
	if (anchorGap == null) {
		unmeasurableStabilityChecks.push("the anchor gap");
		anchorGapNote =
			" — UNMEASURABLE: a gap needs both anchors' evaluation scores";
	} else if (!anchorGapOk) {
		stabilityMeasuredFailure = true;
	}
	stabilityDetails.push(
		`anchor gap ${fmtOrDash(anchorGap)} against maximum ${ANCHOR_STABILITY_MAX_GAP}${anchorGapNote}`,
	);

	const lagsAtWidth = [
		...new Set(
			cellsByBlock
				.filter((c) => c.cell.widthMs === selected.widthMs && !c.control)
				.map((c) => c.cell.lagMs),
		),
	].sort((a, b) => a - b);
	const position = lagsAtWidth.indexOf(selected.lagMs);
	const neighbourLags = [
		lagsAtWidth[position - 1],
		lagsAtWidth[position + 1],
	].filter((v): v is number => v != null);
	let adjacentPassing = 0;
	/** Lags of the plateau that produced no evaluation score to count. */
	let plateauScoresMissing = 0;
	for (const lagMs of neighbourLags) {
		const neighbour = cellsByBlock.find(
			(c) =>
				c.cell.lagMs === lagMs &&
				c.cell.widthMs === selected.widthMs &&
				c.cell.anchor === selected.anchor,
		);
		if (neighbour?.evaluation.r2 == null) {
			plateauScoresMissing++;
		} else if (neighbour.evaluation.r2 >= R2_PASS_THRESHOLD) {
			adjacentPassing++;
		}
	}
	// The selected lag counts toward its own neighbourhood: the requirement is
	// that a CONTIGUOUS stretch of at least MIN_ADJACENT_LAGS lags works, not
	// that two further lags do on top of it.
	const selectedEvaluationR2 =
		cellsByBlock.find((c) => sameCell(c.cell, selected))?.evaluation.r2 ?? null;
	if (selectedEvaluationR2 == null) {
		plateauScoresMissing++;
	} else if (selectedEvaluationR2 >= R2_PASS_THRESHOLD) {
		adjacentPassing++;
	}
	const lagPlateauOk = adjacentPassing >= MIN_ADJACENT_LAGS;
	// A missing score can only ever RAISE the count, so a plateau that already
	// reached the minimum is measured whatever is missing beside it. Short of the
	// minimum it is the other way round: the missing lag might have been the one
	// that carried it, so the check is unmeasurable rather than failed.
	let plateauNote = "";
	if (lagPlateauOk) {
		// measured pass
	} else if (plateauScoresMissing > 0) {
		unmeasurableStabilityChecks.push("the contiguous-lag plateau");
		plateauNote = `; ${plateauScoresMissing} of the lags it reads produced no evaluation score — UNMEASURABLE, so the shortfall was never measured`;
	} else {
		stabilityMeasuredFailure = true;
	}
	stabilityDetails.push(
		`contiguous lags at W=${selected.widthMs / MINUTE_MS}min clearing the threshold: ${adjacentPassing} (need ${MIN_ADJACENT_LAGS})${plateauNote}`,
	);
	const stabilityMeasurable = unmeasurableStabilityChecks.length === 0;
	const stabilityPass =
		stabilityMeasurable && bothAnchorsPass && anchorGapOk && lagPlateauOk;

	// --- controls ------------------------------------------------------------
	//
	// LIKE FOR LIKE: only the controls sharing the selected cell's width AND
	// anchor are eligible. A control at another width bins the same history at a
	// different quantisation, and a control at the other anchor stamps requests
	// at a different instant; neither is the same experiment with the causal
	// direction removed, which is the only thing a placebo may differ by.
	const controlDetails: string[] = [];
	let controlsPass = true;
	let controlsMeasurable = true;
	/** A control that HAS a number and was not beaten by it. */
	let measuredControlFailure = false;
	const controlCells = cellsByBlock.filter(
		(c) =>
			c.control &&
			c.cell.widthMs === selected.widthMs &&
			c.cell.anchor === selected.anchor,
	);
	for (const control of controlCells) {
		const r2 = control.evaluation.r2;
		const margin =
			selectedEvaluationR2 != null && r2 != null
				? selectedEvaluationR2 - r2
				: null;
		if (r2 == null) {
			controlsMeasurable = false;
			controlsPass = false;
		} else if (margin == null) {
			controlsPass = false;
		} else if (margin < CONTROL_MARGIN) {
			controlsPass = false;
			measuredControlFailure = true;
		}
		controlDetails.push(
			`future-token control ${cellLabel(control.cell)}: evaluation R2 ${fmtOrDash(r2)}; margin ${fmtOrDash(margin)} (need ${CONTROL_MARGIN})${r2 == null ? " — UNMEASURABLE, so nothing was beaten" : ""}`,
		);
	}
	// The permutation margin is a MATCHED-COHORT comparison: both its treatment
	// and its placebo score come from the bins the join kept, so the selected
	// cell's own full-cohort R-squared is deliberately not one of its terms.
	const permutationMargin =
		permutation.treatmentR2 != null && permutation.r2 != null
			? permutation.treatmentR2 - permutation.r2
			: null;
	if (permutationMargin == null) {
		controlsMeasurable = false;
		controlsPass = false;
	} else if (permutationMargin < CONTROL_MARGIN) {
		controlsPass = false;
		measuredControlFailure = true;
	}
	controlDetails.push(
		`account-permutation control (seed ${permutation.seed}): matched-cohort treatment R2 ${fmtOrDash(permutation.treatmentR2)} against placebo R2 ${fmtOrDash(permutation.r2)}; margin ${fmtOrDash(permutationMargin)} (need ${CONTROL_MARGIN})${permutationMargin == null ? " — UNMEASURABLE, so nothing was beaten" : ""} — ${permutation.detail}`,
	);
	if (controlCells.length === 0) {
		controlsPass = false;
		controlsMeasurable = false;
		controlDetails.push(
			`no future-token control was scored at W=${selected.widthMs / MINUTE_MS}min ${selected.anchor}; a study without a like-for-like placebo cannot be called valid`,
		);
	}

	// PRECEDENCE: no score at all, then every MEASURED refutation, and only then
	// a check that could not be measured — a control without a number, or a
	// stability sub-check without the scores it reads. Either leaves its OWN
	// question open; neither can reopen a question another check already
	// answered, so a measured failure standing next to one is still a failure.
	let verdict: Verdict;
	let verdictDetail: string;
	if (selectedEvaluationR2 == null) {
		verdict = "insufficient-evidence";
		verdictDetail = `The selected cell (${cellLabel(selected)}) produced no evaluation-block score: too few usable or positive-signal bins there.`;
	} else {
		const measuredFailures: string[] = [];
		if (measuredControlFailure) {
			measuredFailures.push(
				`a control that WAS measured was not beaten by ${CONTROL_MARGIN}, so the signal is INVALID regardless of magnitude`,
			);
		}
		if (selectedEvaluationR2 < R2_PASS_THRESHOLD) {
			measuredFailures.push(
				`the evaluation R-squared ${selectedEvaluationR2.toFixed(3)} is below the threshold ${R2_PASS_THRESHOLD}`,
			);
		}
		if (stabilityMeasuredFailure) {
			measuredFailures.push(
				"the cell did not hold across both anchors and a contiguous run of lags",
			);
		}
		const everythingMeasurable = controlsMeasurable && stabilityMeasurable;
		if (measuredFailures.length > 0) {
			verdict = "fail";
			verdictDetail = `The selected cell scored ${selectedEvaluationR2.toFixed(3)} on the evaluation block and was refuted by ${measuredFailures.length === 1 ? "a measured check" : `${measuredFailures.length} measured checks`}: ${measuredFailures.join("; ")}.${everythingMeasurable ? "" : " A further check could not be measured at all, but a measured failure is decisive."}`;
		} else if (!everythingMeasurable) {
			const openQuestions: string[] = [];
			if (!controlsMeasurable) {
				openQuestions.push(
					"at least one mandatory control produced no number at all",
				);
			}
			if (!stabilityMeasurable) {
				openQuestions.push(
					`a stability sub-check had no number to judge (${unmeasurableStabilityChecks.join("; ")})`,
				);
			}
			verdict = "insufficient-evidence";
			verdictDetail = `The selected cell scored ${selectedEvaluationR2.toFixed(3)} on the evaluation block and every measured check held, but ${openQuestions.join(", and ")}. ${
				controlsMeasurable
					? "An unmeasurable check is not a passed check"
					: "An unmeasurable control is not a beaten control"
			}, so the cell is neither valid nor refuted.`;
		} else {
			verdict = "pass";
			verdictDetail = `The selected cell scored ${selectedEvaluationR2.toFixed(3)} on the evaluation block, held across anchors and adjacent lags, and beat every control by at least ${CONTROL_MARGIN}.`;
		}
	}

	return {
		selected,
		selectionR2: winner.selection.r2,
		evaluationR2: selectedEvaluationR2,
		tieBreak:
			"highest selection R-squared, then widest width, then smallest |lag|, then the terminal anchor",
		stabilityPass,
		stabilityMeasurable,
		stabilityMeasuredFailure,
		stabilityDetails,
		controlsPass,
		controlsMeasurable,
		controlDetails,
		verdict,
		verdictDetail,
	};
}

// ---------------------------------------------------------------------------
// eraStability
// ---------------------------------------------------------------------------

export interface EraBoundary {
	label: string;
	atMs: number;
	/** How the timestamp was established, verbatim into the report. */
	provenance: string;
}

export interface EraStratum {
	accountId: string;
	column: string;
	binsBefore: number;
	binsAfter: number;
	tokensBefore: number;
	tokensAfter: number;
	ratioBefore: number | null;
	ratioAfter: number | null;
	relativeChange: number | null;
}

export interface EraBoundaryResult {
	boundary: EraBoundary;
	strata: EraStratum[];
	qualifyingStrata: number;
	pooledRatioBefore: number | null;
	pooledRatioAfter: number | null;
	relativeChange: number | null;
	beforeCi: [number | null, number | null];
	afterCi: [number | null, number | null];
	ciDisjoint: boolean;
	materialShift: boolean;
	verdict: Verdict;
	detail: string;
}

export interface EraStability {
	boundaries: EraBoundaryResult[];
	verdict: Verdict;
	detail: string;
}

export interface EraStabilityOptions {
	seed: number;
	iterations?: number;
	byAccount?: (bin: LedgerBin) => string;
}

/**
 * A bin whose ENTIRE token mass sits in one (family, class) column, and which
 * column that is. Mixed bins are excluded: without a fitted coefficient per
 * column there is no way to attribute a mixed bin's rise to one of them, and
 * the whole point of this check is to compare a ratio with the same ratio
 * later.
 */
function pureColumnOf(bin: LedgerBin): number | null {
	let found = -1;
	for (let c = 0; c < COLUMN_COUNT; c++) {
		if (bin.tokens[c] === 0) continue;
		if (found >= 0) return null;
		found = c;
	}
	return found >= 0 ? found : null;
}

function weightedMean(
	values: readonly { value: number; weight: number }[],
): number | null {
	let num = 0;
	let den = 0;
	for (const v of values) {
		num += v.value * v.weight;
		den += v.weight;
	}
	return den > 0 ? num / den : null;
}

/**
 * Does the percent-per-token ratio survive the boundaries the deployment
 * itself moved?
 *
 * Strata are MATCHED (account, family, class) triples: the same account
 * spending the same kind of token on the same model family, before and after.
 * An unmatched comparison would confuse a change in the ratio with a change in
 * the traffic MIX, which moved constantly over these 82 days.
 *
 * "Insufficient evidence" is a first-class outcome and will usually be the
 * honest one — a stratum needs `MIN_ERA_STRATUM_BINS` PURE bins on each side,
 * and pure bins are rare when a proxy multiplexes families onto one account.
 */
export function eraStability(
	bins: readonly LedgerBin[],
	boundaries: readonly EraBoundary[],
	options: EraStabilityOptions,
): EraStability {
	const byAccount = options.byAccount ?? ((bin: LedgerBin) => bin.accountId);
	const iterations = options.iterations ?? ERA_BOOTSTRAP_ITERATIONS;
	const clean = usableBins(bins);
	const results: EraBoundaryResult[] = [];

	for (const boundary of boundaries) {
		interface Side {
			bins: number;
			tokens: number;
			dPct: number;
		}
		const strataMap = new Map<
			string,
			{ accountId: string; column: number; before: Side; after: Side }
		>();
		for (const bin of clean) {
			const column = pureColumnOf(bin);
			if (column == null) continue;
			const accountId = byAccount(bin);
			const key = `${accountId} ${column}`;
			let entry = strataMap.get(key);
			if (entry == null) {
				entry = {
					accountId,
					column,
					before: { bins: 0, tokens: 0, dPct: 0 },
					after: { bins: 0, tokens: 0, dPct: 0 },
				};
				strataMap.set(key, entry);
			}
			const side = bin.endMs <= boundary.atMs ? entry.before : entry.after;
			side.bins++;
			side.tokens += bin.tokens[column];
			side.dPct += bin.dPct;
		}

		const strata: EraStratum[] = [];
		const qualifying: {
			accountId: string;
			ratioBefore: number;
			ratioAfter: number;
			weight: number;
		}[] = [];
		for (const key of [...strataMap.keys()].sort()) {
			const entry = strataMap.get(key);
			if (entry == null) continue;
			const ratioBefore =
				entry.before.tokens > 0
					? entry.before.dPct / entry.before.tokens
					: null;
			const ratioAfter =
				entry.after.tokens > 0 ? entry.after.dPct / entry.after.tokens : null;
			const qualifies =
				entry.before.bins >= MIN_ERA_STRATUM_BINS &&
				entry.after.bins >= MIN_ERA_STRATUM_BINS &&
				ratioBefore != null &&
				ratioAfter != null &&
				ratioBefore > 0;
			strata.push({
				accountId: entry.accountId,
				column: columnLabel(entry.column),
				binsBefore: entry.before.bins,
				binsAfter: entry.after.bins,
				tokensBefore: entry.before.tokens,
				tokensAfter: entry.after.tokens,
				ratioBefore,
				ratioAfter,
				relativeChange:
					qualifies && ratioBefore != null && ratioAfter != null
						? (ratioAfter - ratioBefore) / ratioBefore
						: null,
			});
			if (qualifies && ratioBefore != null && ratioAfter != null) {
				qualifying.push({
					accountId: entry.accountId,
					ratioBefore,
					ratioAfter,
					weight: Math.min(entry.before.tokens, entry.after.tokens),
				});
			}
		}

		if (qualifying.length === 0) {
			results.push({
				boundary,
				strata,
				qualifyingStrata: 0,
				pooledRatioBefore: null,
				pooledRatioAfter: null,
				relativeChange: null,
				beforeCi: [null, null],
				afterCi: [null, null],
				ciDisjoint: false,
				materialShift: false,
				verdict: "insufficient-evidence",
				detail: `No (account, family, class) stratum had ${MIN_ERA_STRATUM_BINS} pure clean bins on both sides of this boundary.`,
			});
			continue;
		}

		const pooledBefore = weightedMean(
			qualifying.map((q) => ({ value: q.ratioBefore, weight: q.weight })),
		);
		const pooledAfter = weightedMean(
			qualifying.map((q) => ({ value: q.ratioAfter, weight: q.weight })),
		);
		const relativeChange =
			pooledBefore != null && pooledAfter != null && pooledBefore > 0
				? (pooledAfter - pooledBefore) / pooledBefore
				: null;

		// Bootstrap over ACCOUNTS: strata inside one account share its traffic and
		// its plan tier, so resampling strata would pretend they are independent.
		const accounts = [...new Set(qualifying.map((q) => q.accountId))].sort();
		const byAccountStrata = new Map<string, typeof qualifying>();
		for (const q of qualifying) {
			const list = byAccountStrata.get(q.accountId);
			if (list) list.push(q);
			else byAccountStrata.set(q.accountId, [q]);
		}
		const rand = makePrng(options.seed);
		const beforeDraws: number[] = [];
		const afterDraws: number[] = [];
		for (let i = 0; i < iterations; i++) {
			const drawn: typeof qualifying = [];
			for (let k = 0; k < accounts.length; k++) {
				const account = accounts[Math.floor(rand() * accounts.length)];
				drawn.push(...(byAccountStrata.get(account) ?? []));
			}
			const b = weightedMean(
				drawn.map((q) => ({ value: q.ratioBefore, weight: q.weight })),
			);
			const a = weightedMean(
				drawn.map((q) => ({ value: q.ratioAfter, weight: q.weight })),
			);
			if (b != null) beforeDraws.push(b);
			if (a != null) afterDraws.push(a);
		}
		beforeDraws.sort((x, y) => x - y);
		afterDraws.sort((x, y) => x - y);
		const beforeCi: [number | null, number | null] = [
			percentile(beforeDraws, 0.025),
			percentile(beforeDraws, 0.975),
		];
		const afterCi: [number | null, number | null] = [
			percentile(afterDraws, 0.025),
			percentile(afterDraws, 0.975),
		];
		const ciDisjoint =
			beforeCi[0] != null &&
			beforeCi[1] != null &&
			afterCi[0] != null &&
			afterCi[1] != null &&
			(beforeCi[1] < afterCi[0] || afterCi[1] < beforeCi[0]);
		const materialShift =
			relativeChange != null &&
			Math.abs(relativeChange) > ERA_MATERIAL_SHIFT_FRACTION &&
			ciDisjoint;
		const changeLabel =
			relativeChange != null
				? `${(relativeChange * 100).toFixed(1)}%`
				: "an unmeasurable amount";
		results.push({
			boundary,
			strata,
			qualifyingStrata: qualifying.length,
			pooledRatioBefore: pooledBefore,
			pooledRatioAfter: pooledAfter,
			relativeChange,
			beforeCi,
			afterCi,
			ciDisjoint,
			materialShift,
			verdict: materialShift ? "fail" : "pass",
			detail: materialShift
				? `The pooled percent-per-token ratio moved ${changeLabel} across this boundary with non-overlapping account-bootstrap intervals: a material shift.`
				: `The pooled ratio moved ${changeLabel} across this boundary; ${ciDisjoint ? "the intervals are disjoint but the change is below the material threshold" : "the account-bootstrap intervals overlap"}.`,
		});
	}

	if (results.length === 0) {
		return {
			boundaries: results,
			verdict: "insufficient-evidence",
			detail: "No era boundaries were supplied.",
		};
	}
	if (results.some((r) => r.verdict === "fail")) {
		return {
			boundaries: results,
			verdict: "fail",
			detail: `${results.filter((r) => r.verdict === "fail").length} of ${results.length} boundaries show a material shift in the percent-per-token ratio.`,
		};
	}
	// EVERY supplied boundary must be measurable AND stable. A boundary with no
	// qualifying stratum is a boundary nothing is known about, and a ratio that
	// held across the two boundaries that could be measured says nothing about
	// the one that could not. Passing on the measurable subset would report
	// "stable" for a period the study never looked at.
	const unmeasurable = results.filter(
		(r) => r.verdict === "insufficient-evidence",
	).length;
	if (unmeasurable > 0) {
		return {
			boundaries: results,
			verdict: "insufficient-evidence",
			detail:
				unmeasurable === results.length
					? "No boundary had a matched stratum with enough pure bins on both sides."
					: `${unmeasurable} of ${results.length} boundaries had no matched stratum with enough pure bins on both sides; the remaining ${results.length - unmeasurable} did not shift materially, but stability is unknown across the unmeasured ones.`,
		};
	}
	return {
		boundaries: results,
		verdict: "pass",
		detail: `All ${results.length} boundaries were measurable and none shifted materially.`,
	};
}

// ---------------------------------------------------------------------------
// capabilityMatrix
// ---------------------------------------------------------------------------

/**
 * What the report may say about plan tiers: that it cannot say anything.
 *
 * No recorded row carries one. `usage_snapshots` and `requests` have no tier
 * column, so the studied history holds no tier at all, and the only tier the
 * database has — `accounts.identity_rate_limit_tier` — is live, mutable and
 * unversioned: it is rewritten by every identity refresh of a running
 * deployment. Printing its value, a count of the accounts carrying one, or
 * where its capture instant falls would make an artifact that is otherwise a
 * pure function of the frozen range change on a refresh that has nothing to do
 * with the studied history. It goes to stderr instead, and what stays here is a
 * constant: the same sentence for every group and every run.
 */
const TIER_PROVENANCE_DETAIL =
	"No account has in-range tier provenance: nothing the study read records a plan tier, because neither `usage_snapshots` nor `requests` carries a tier column and the only tier the schema has is a live, mutable `accounts` value with no history. Informational: the pooled fit assumes one price across the group, and a tier difference would break that assumption.";

/** The tier-provenance section's body. Constant, for the same reason. */
const TIER_PROVENANCE_SECTION =
	"The schema records no historical tier: neither `usage_snapshots` nor `requests` carries a tier column, so no account has tier provenance inside the study range. The live `accounts` tier is deliberately absent from this report, being mutable and unversioned: reading it would rewrite a frozen artifact on the next identity refresh. Any future fit must therefore either assume the current tiers held across the range, or wait for schema work that records tier history.";

export interface CapabilityEntry {
	name: string;
	verdict: Verdict;
	detail: string;
	/** Reported, but never counted toward the group's verdict. */
	informational: boolean;
}

export interface FamilyResolution {
	resolvedShare: number | null;
	resolvedTokens: number;
	unresolvedTokens: number;
	verdict: Verdict;
}

export interface CompletenessBound {
	/** Positive percent mass in clean bins that carry NO tokens at all. */
	unmatchedShare: number | null;
	unmatchedPositiveDPct: number;
	totalPositiveDPct: number;
	verdict: Verdict;
}

export interface GroupCapability {
	provider: string;
	windowKind: LedgerWindowKind;
	excludedReason: string | null;
	eligible: boolean;
	eligibilityDetail: string;
	census: BinCensus;
	selection: CellSelection;
	relation: AggregateRelation | null;
	observability: ConditionalObservability | null;
	familyResolution: FamilyResolution | null;
	identifiability: Identifiability | null;
	completeness: CompletenessBound | null;
	concentration: Concentration | null;
	era: EraStability | null;
	entries: CapabilityEntry[];
	verdict: Verdict;
}

export interface CapabilityMatrixInput {
	provider: string;
	windowKind: LedgerWindowKind;
	/** Bins of the SELECTED cell on the evaluation block. */
	evaluationBins: readonly LedgerBin[];
	/** Bins of the SELECTED cell on the selection block; eligibility only. */
	selectionBins: readonly LedgerBin[];
	/** Every cell's two block scores, for `selectCell`. */
	cellScores: readonly CellScore[];
	permutation: PermutationControl;
	eraBoundaries: readonly EraBoundary[];
	seed: number;
	/**
	 * Set when no cell could be selected at all, so NO bins were built to
	 * analyse. The group is then insufficient evidence for this stated reason —
	 * analysing an arbitrary fallback cell would report a number nothing chose.
	 */
	analysisUnavailable?: string | null;
}

function fmtOrDash(value: number | null): string {
	return value == null || !Number.isFinite(value) ? "—" : value.toFixed(3);
}

function familyResolutionOf(bins: readonly LedgerBin[]): FamilyResolution {
	let resolved = 0;
	let unresolved = 0;
	const unresolvedStart = columnIndex("unresolved", "input");
	for (const bin of usableBins(bins)) {
		for (let c = 0; c < COLUMN_COUNT; c++) {
			const v = bin.tokens[c];
			if (v === 0) continue;
			if (c >= unresolvedStart) unresolved += v;
			else resolved += v;
		}
	}
	const total = resolved + unresolved;
	if (total === 0) {
		return {
			resolvedShare: null,
			resolvedTokens: 0,
			unresolvedTokens: 0,
			verdict: "insufficient-evidence",
		};
	}
	const share = resolved / total;
	return {
		resolvedShare: share,
		resolvedTokens: resolved,
		unresolvedTokens: unresolved,
		verdict: share >= FAMILY_RESOLUTION_MIN_SHARE ? "pass" : "fail",
	};
}

/**
 * A LOWER BOUND on the ledger's incompleteness.
 *
 * It measures only the fully unexplained case: clean bins that rose while
 * carrying no tokens at all. A bin whose ledger accounts for a tenth of its
 * real burn looks perfectly matched here. So this number can only understate
 * the hole, never overstate it, and the report must say so wherever it is
 * quoted.
 */
function completenessBoundOf(bins: readonly LedgerBin[]): CompletenessBound {
	let unmatched = 0;
	let total = 0;
	for (const bin of usableBins(bins)) {
		if (!(bin.dPct > 0)) continue;
		total += bin.dPct;
		if (bin.grossTokens === 0) unmatched += bin.dPct;
	}
	if (!(total > 0)) {
		return {
			unmatchedShare: null,
			unmatchedPositiveDPct: 0,
			totalPositiveDPct: 0,
			verdict: "insufficient-evidence",
		};
	}
	const share = unmatched / total;
	return {
		unmatchedShare: share,
		unmatchedPositiveDPct: unmatched,
		totalPositiveDPct: total,
		verdict: share < MAX_UNMATCHED_POSITIVE_DELTA_SHARE ? "pass" : "fail",
	};
}

/**
 * Assemble the per-(provider, window) capability matrix.
 *
 * Every entry answers one question with its numbers attached, and every entry
 * can answer "insufficient evidence" — which is neither a pass nor a
 * fail, and is the correct answer far more often than either.
 *
 * The group verdict is the AND of the non-informational entries: a burn model
 * needs the relation AND identifiability AND completeness AND breadth AND
 * stability. Any single one failing is enough to make the model unbuildable
 * from this data, so a matrix of mostly-passes with one fail is a NO.
 */
export function capabilityMatrix(
	input: CapabilityMatrixInput,
): GroupCapability {
	const census = censusBins(input.evaluationBins);
	const excludedReason = excludedGroupReason(input.provider, input.windowKind);
	const emptySelection: CellSelection = {
		selected: null,
		selectionR2: null,
		evaluationR2: null,
		tieBreak: "not evaluated",
		stabilityPass: false,
		stabilityMeasurable: false,
		stabilityMeasuredFailure: false,
		stabilityDetails: [],
		controlsPass: false,
		controlsMeasurable: false,
		controlDetails: [],
		verdict: "insufficient-evidence",
		verdictDetail: "The group was not evaluated.",
	};

	/** Insufficient evidence with the stated reason and nothing measured. */
	const unevaluated = (
		reason: string,
		selection: CellSelection,
		excluded: string | null,
	): GroupCapability => ({
		provider: input.provider,
		windowKind: input.windowKind,
		excludedReason: excluded,
		eligible: false,
		eligibilityDetail: reason,
		census,
		selection,
		relation: null,
		observability: null,
		familyResolution: null,
		identifiability: null,
		completeness: null,
		concentration: null,
		era: null,
		entries: [
			{
				name: "group eligibility",
				verdict: "insufficient-evidence",
				detail: reason,
				informational: false,
			},
		],
		verdict: "insufficient-evidence",
	});

	if (excludedReason != null) {
		return unevaluated(excludedReason, emptySelection, excludedReason);
	}

	// Before anything else: if no cell was selectable there are no bins, and the
	// exposure floor below would report "0 equivalent bins" — true of the empty
	// input, false about the group.
	if (input.analysisUnavailable != null) {
		return unevaluated(
			input.analysisUnavailable,
			selectCell(input.cellScores, input.permutation),
			null,
		);
	}

	// CLEAN-COHORT exposure. Counting contaminated and low-coverage bins toward
	// the floor would admit a group on the strength of the very milliseconds
	// every primary metric then throws away — a saturated week is exposure that
	// can answer nothing.
	const exposure =
		censusBins(input.selectionBins).usableEquivalentBins +
		census.usableEquivalentBins;
	if (exposure < MIN_GROUP_EQUIVALENT_BINS) {
		return unevaluated(
			`${exposure.toFixed(0)} equivalent 2-minute bins of CLEAN-cohort exposure against a floor of ${MIN_GROUP_EQUIVALENT_BINS}.`,
			emptySelection,
			null,
		);
	}

	const selection = selectCell(input.cellScores, input.permutation);
	const relation = aggregateRelation(input.evaluationBins);
	const observability = conditionalObservability(input.evaluationBins);
	const resolution = familyResolutionOf(input.evaluationBins);
	const ident = identifiability(input.evaluationBins);
	const completeness = completenessBoundOf(input.evaluationBins);
	const conc = concentration(input.evaluationBins, (bin) => bin.accountId);
	const era = eraStability(input.evaluationBins, input.eraBoundaries, {
		seed: input.seed,
	});

	// A cell selection that came back INSUFFICIENT — no evaluation-block score,
	// or a mandatory control that produced no number — carries straight through.
	// Calling the relation "fail" on the strength of an unrun control would
	// report a refutation the study never obtained.
	const relationVerdict: Verdict =
		relation.insufficient || selection.verdict === "insufficient-evidence"
			? "insufficient-evidence"
			: selection.verdict === "pass" &&
					relation.r2 != null &&
					relation.r2 >= R2_PASS_THRESHOLD
				? "pass"
				: "fail";

	const entries: CapabilityEntry[] = [
		{
			name: "group eligibility",
			verdict: "pass",
			detail: `${exposure.toFixed(0)} equivalent 2-minute bins of CLEAN-cohort exposure (floor ${MIN_GROUP_EQUIVALENT_BINS}); ${census.usable} usable bins of ${census.total} at the selected cell on the evaluation block.`,
			informational: false,
		},
		{
			name: "aggregate relation",
			verdict: relationVerdict,
			detail: `evaluation R2 ${fmtOrDash(relation.r2)} (threshold ${R2_PASS_THRESHOLD}) over ${relation.usableBins} clean bins, ${relation.positiveSignalBins} of them positive-signal; cell selection ${selection.verdict}: ${selection.verdictDetail}`,
			informational: false,
		},
		{
			name: "family resolution",
			verdict: resolution.verdict,
			detail: `${resolution.resolvedShare == null ? "—" : `${(resolution.resolvedShare * 100).toFixed(1)}%`} of clean-bin token mass resolves to a Claude family (floor ${(FAMILY_RESOLUTION_MIN_SHARE * 100).toFixed(0)}%); ${resolution.unresolvedTokens.toFixed(0)} tokens are unresolved. \`getModelFamily\` recognises Claude slugs only.`,
			informational: false,
		},
		{
			name: "class identifiability",
			verdict: ident.insufficient
				? "insufficient-evidence"
				: ident.identifiable
					? "pass"
					: "fail",
			detail: `rank ${ident.rank ?? "—"} of ${ident.activeColumns} active columns, condition number ${fmtOrDash(ident.conditionNumber)} (maximum ${IDENTIFIABILITY_MAX_CONDITION}); ${ident.collinearPairs.length} column pairs have an uncentered correlation above 0.9.`,
			informational: false,
		},
		{
			name: "completeness bound",
			verdict: completeness.verdict,
			detail: `${completeness.unmatchedShare == null ? "—" : `${(completeness.unmatchedShare * 100).toFixed(1)}%`} of positive percent mass sits in clean bins with NO ledger tokens (ceiling ${(MAX_UNMATCHED_POSITIVE_DELTA_SHARE * 100).toFixed(0)}%). This is a LOWER BOUND on the ledger's incompleteness: a bin whose ledger explains part of its burn counts as matched.`,
			informational: false,
		},
		{
			name: "account concentration",
			verdict: conc.insufficient
				? "insufficient-evidence"
				: conc.pass
					? "pass"
					: "fail",
			detail: `${fmtOrDash(conc.effectiveAccounts)} effective accounts by inverse HHI (floor ${EFFECTIVE_ACCOUNTS_MIN}), largest token share ${conc.maxAccountShare == null ? "—" : `${(conc.maxAccountShare * 100).toFixed(1)}%`} (ceiling ${(MAX_ACCOUNT_SHARE * 100).toFixed(0)}%) over ${conc.accounts.length} accounts.`,
			informational: false,
		},
		{
			name: "era stability",
			verdict: era.verdict,
			detail: era.detail,
			informational: false,
		},
		{
			name: "tier provenance",
			// Fixed, and insufficient evidence by construction: the recorded history
			// carries no tier at all, so there is nothing here that could be measured
			// per group or that could move between runs.
			verdict: "insufficient-evidence",
			detail: TIER_PROVENANCE_DETAIL,
			informational: true,
		},
	];

	const decisive = entries.filter((e) => !e.informational);
	const verdict: Verdict = decisive.some((e) => e.verdict === "fail")
		? "fail"
		: decisive.some((e) => e.verdict === "insufficient-evidence")
			? "insufficient-evidence"
			: "pass";

	return {
		provider: input.provider,
		windowKind: input.windowKind,
		excludedReason: null,
		eligible: true,
		eligibilityDetail: `${exposure.toFixed(0)} equivalent 2-minute bins of CLEAN-cohort exposure.`,
		census,
		selection,
		relation,
		observability,
		familyResolution: resolution,
		identifiability: ident,
		completeness,
		concentration: conc,
		era,
		entries,
		verdict,
	};
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

/**
 * What the study actually read, counted over `[from, to)` and NOTHING else.
 *
 * Every field here is a statistic of the rows inside the frozen study range.
 * Whole-table bounds are deliberately absent: the database this is read from is
 * live and grows past `to` between one run and the next, so a whole-table
 * MIN/MAX would rewrite the artifact on every run while describing history the
 * study never looked at.
 */
export interface FeasibilityDatasetSummary {
	snapshotRows: number;
	requestRows: number;
	accounts: number;
	providers: string[];
	firstSnapshotIso: string;
	lastSnapshotIso: string;
	firstRequestIso: string;
	lastRequestIso: string;
	keepaliveActivePeriods: number;
}

export interface FeasibilityReportInput {
	title: string;
	/**
	 * The exact invocation, so the report is reproducible.
	 *
	 * There is deliberately no generation timestamp and no run duration in this
	 * input: the artifact is a pure function of the frozen study range, the seed
	 * and the history, so re-running it on unchanged data must produce a
	 * BYTE-IDENTICAL file. A wall clock in the header would turn every re-run
	 * into a diff and hide the changes that matter. Timings go to stderr.
	 */
	command: string;
	config: Record<string, string | number | boolean | null>;
	dataset: FeasibilityDatasetSummary;
	selectionBlock: { fromIso: string; toIso: string };
	evaluationBlock: { fromIso: string; toIso: string };
	eraBoundaries: readonly EraBoundary[];
	groups: readonly GroupCapability[];
	/** Every cell's scores per group, for the sweep tables. */
	cellScoresByGroup: readonly {
		provider: string;
		windowKind: LedgerWindowKind;
		cells: readonly CellScore[];
	}[];
	notes?: string[];
}

const EM_DASH = "—";

function num(value: number | null | undefined, digits = 3): string {
	if (value == null || !Number.isFinite(value)) return EM_DASH;
	return value.toFixed(digits);
}

function pctOf(value: number | null | undefined): string {
	if (value == null || !Number.isFinite(value)) return EM_DASH;
	return `${(value * 100).toFixed(1)}%`;
}

function bigNum(value: number | null | undefined): string {
	if (value == null || !Number.isFinite(value)) return EM_DASH;
	return Math.round(value).toLocaleString("en-US");
}

function verdictLabel(verdict: Verdict): string {
	if (verdict === "pass") return "PASS";
	if (verdict === "fail") return "FAIL";
	return "INSUFFICIENT EVIDENCE";
}

function groupTitle(group: {
	provider: string;
	windowKind: LedgerWindowKind;
}): string {
	return `${group.provider} / ${group.windowKind}`;
}

const METHODOLOGY = `## Methodology

- **This is a feasibility study, not an estimator.** Nothing here is wired into
  the server, no coefficient produced here is used to predict anything, and the
  fitted slopes exist only so a ratio can be compared with the same ratio in
  another era.
- **Bins live inside one reset lifecycle.** The snapshot series is split at
  \`isResetBoundary\` before anything is measured. A bin touched by two
  lifecycles straddles a reset and is DISCARDED, never averaged across.
- **Percent mass and token mass come from the same interval.** The accepted
  deltas of \`withinWindowDeltas\` (no gap wider than 15 minutes, positive
  elapsed time) define the observed sub-intervals. A request counts only if
  BOTH its unshifted anchor time and its lag-shifted time fall in accepted
  sub-intervals of the same lifecycle segment, so a sampling outage can never
  become a bin with tokens and no rise, and a lag can never import tokens that
  were physically spent inside a rejected gap.
- **Straddling deltas are pro-rated.** A delta overlapping two bins contributes
  its percent and its milliseconds to each in proportion to the overlap. At a
  2-minute width a whole sampler tick is a whole bin, so assigning it to the bin
  it happened to end in would be a systematic misattribution.
- **Half-open, upper-closed.** Both the observed intervals and the bins are
  \`(from, to]\`. A request stamped exactly on a delta's closing endpoint
  therefore lands in the bin that delta's percent went to.
- **Clean cohort.** A bin counts toward the primary metrics only with at least
  50% observed coverage AND no contamination flag: a refund (a negative delta),
  saturation (an endpoint at or above 100%, where the meter stops moving), or an
  \`overage\`-billed request (which spends purchased credit, not window quota).
  Contaminated and low-coverage bins are COUNTED and reported, never silently
  dropped, and they do not count toward the group's exposure floor either — the
  floor is clean-cohort milliseconds only.
- **Blocked selection.** The (lag, width, anchor) cell is chosen on an early
  selection block and every reported number comes from a disjoint later
  evaluation block. A sweep scored and reported on the same data finds its best
  cell whether or not a relation exists. A bin belongs to a block only when the
  bin interval AND the interval its tokens were drawn from (the unshifted anchor
  times, so the bin shifted back by the lag) lie wholly inside that block —
  which also means wholly inside the study range, since no request outside the
  range was loaded. Boundary bins that would need requests from the other block,
  or from before the range's start or after its end, are dropped from both and
  COUNTED. Without the first half a positive lag would let evaluation-block bins
  ingest selection-block tokens and the split would leak; without the second a
  future-token control at the range's end would be scored on bins whose token
  mass was silently truncated to the requests that happened to exist.
- **Controls decide validity before magnitude.** Two mandatory controls, and a
  cell that does not beat BOTH by 0.15 R-squared is INVALID no matter how high
  it scores:
  - **Future tokens.** The control lag is \`-(width + offset)\` for offsets of 2
    and 4 minutes, so a control bin's tokens come from an interval lying WHOLLY
    after the bin, by at least the offset. A fixed small negative lag would not
    do: at a 10-minute width, a lag of -2 minutes still overlaps 8 of the bin's
    own 10 minutes, so most of that "future" is the bin's own present and the
    control scores nearly what the real cell does — a margin manufactured by
    construction rather than measured.
  - **Account permutation.** Each account's token series is fitted against a
    DIFFERENT account's percent series under a seeded derangement (no account is
    ever paired with itself), joined on IDENTICAL bin edges so both series
    describe the same wall-clock intervals. Its margin is the one it carries
    itself: the treatment is refitted over exactly the bins the join kept, so
    treatment and placebo differ only in the pairing and not in which bins each
    saw. The unit is the account because the question is whether tokens explain
    THIS account's percent; shuffling individual bins would also destroy each
    series' own autocorrelation and so test a much weaker null.
  Only controls at the SELECTED cell's width AND anchor are compared against it:
  a control at another width bins the same history at a different quantisation
  and is not the same experiment. A control that produces NO number is not a
  beaten control — it leaves ITS OWN question open, so a cell that clears
  everything else is INSUFFICIENT EVIDENCE rather than a pass.
- **A measured failure outranks an unmeasurable control.** The cell verdict is
  read in one order: no evaluation score at all is insufficient evidence; then
  any MEASURED refutation — a control that has a number and was not beaten by
  it, an evaluation R-squared below the threshold, a failed stability check —
  is a FAIL; and only if nothing measured failed does an unmeasurable mandatory
  control make the answer insufficient evidence. The other order would let a
  placebo that could not be run turn a refutation into "we do not know".
- **No intercept.** A bin with no tokens must predict no rise. An intercept
  would absorb exactly the unexplained baseline burn the study is looking for.
  The R-squared is therefore UNCENTERED and is not comparable with a centred
  one.
- **Pooling.** Bins from every account in a group are pooled into one fit,
  which assumes a single percent-per-token price across the group. The account
  concentration table shows whether one account is carrying that number;
  whether the accounts' plan tiers even agreed over the range is not recoverable
  from the recorded history at all, which is what tier provenance says.
- **\`null\` is not zero.** Every statistic below a minimum is \`null\` and
  every table renders it as an em-dash. A \`null\` never passes a criterion.`;

/** Deterministic markdown. Every date and number comes from the input. */
export function formatFeasibilityReport(input: FeasibilityReportInput): string {
	const out: string[] = [];
	out.push(`# ${input.title}`);
	out.push("");
	out.push(
		`Study range: \`[${input.selectionBlock.fromIso}, ${input.evaluationBlock.toIso})\`. This report carries no generation timestamp and no run durations: it is a pure function of that frozen range, the seed and the recorded history, so an unchanged history reproduces it byte for byte.`,
	);
	out.push("");
	out.push("Reproduce with:");
	out.push("");
	out.push("```");
	out.push(input.command);
	out.push("```");
	out.push("");

	const configKeys = Object.keys(input.config).sort();
	if (configKeys.length > 0) {
		out.push("| config | value |");
		out.push("|---|---|");
		for (const key of configKeys) {
			out.push(`| ${key} | ${input.config[key] ?? EM_DASH} |`);
		}
		out.push("");
	}

	out.push("## Dataset");
	out.push("");
	out.push(
		"Every figure below counts only rows inside the study range. The database is live and keeps growing past the range's end; whole-table bounds would describe history this study never read and would change the artifact on every run.",
	);
	out.push("");
	out.push("| field (within the study range) | value |");
	out.push("|---|---|");
	out.push(`| usage_snapshots rows | ${bigNum(input.dataset.snapshotRows)} |`);
	out.push(`| requests rows | ${bigNum(input.dataset.requestRows)} |`);
	out.push(`| accounts | ${input.dataset.accounts} |`);
	out.push(
		`| providers | ${input.dataset.providers.length ? input.dataset.providers.join(", ") : EM_DASH} |`,
	);
	out.push(`| first snapshot | ${input.dataset.firstSnapshotIso} |`);
	out.push(`| last snapshot | ${input.dataset.lastSnapshotIso} |`);
	out.push(`| first request | ${input.dataset.firstRequestIso} |`);
	out.push(`| last request | ${input.dataset.lastRequestIso} |`);
	out.push(
		`| keepalive-active periods | ${input.dataset.keepaliveActivePeriods} |`,
	);
	out.push("");
	out.push(
		`Selection block: \`[${input.selectionBlock.fromIso}, ${input.selectionBlock.toIso})\`  `,
	);
	out.push(
		`Evaluation block: \`[${input.evaluationBlock.fromIso}, ${input.evaluationBlock.toIso})\``,
	);
	out.push("");

	out.push(METHODOLOGY);
	out.push("");

	out.push("## Era boundaries");
	out.push("");
	out.push("| boundary | at | provenance |");
	out.push("|---|---|---|");
	for (const b of input.eraBoundaries) {
		out.push(
			`| ${b.label} | ${new Date(b.atMs).toISOString()} | ${b.provenance} |`,
		);
	}
	out.push("");

	out.push("## Capability matrix");
	out.push("");
	out.push("| group | verdict | criterion | result | numbers |");
	out.push("|---|---|---|---|---|");
	for (const group of input.groups) {
		for (const entry of group.entries) {
			out.push(
				`| ${groupTitle(group)} | ${verdictLabel(group.verdict)} | ${entry.name}${entry.informational ? " (informational)" : ""} | ${verdictLabel(entry.verdict)} | ${entry.detail} |`,
			);
		}
	}
	out.push("");

	for (const group of input.groups) {
		out.push(`## ${groupTitle(group)}`);
		out.push("");
		if (group.excludedReason != null) {
			out.push(`EXCLUDED. ${group.excludedReason}`);
			out.push("");
			continue;
		}
		if (!group.eligible) {
			out.push(`INSUFFICIENT EVIDENCE. ${group.eligibilityDetail}`);
			out.push("");
			continue;
		}

		out.push("Bin census at the selected cell (evaluation block):");
		out.push("");
		out.push(
			"| bins | usable | low coverage | refund | saturated | overage | keepalive-active | positive signal | equivalent 2-min bins | clean equivalent 2-min bins |",
		);
		out.push("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
		const c = group.census;
		out.push(
			`| ${c.total} | ${c.usable} | ${c.lowCoverage} | ${c.refund} | ${c.saturated} | ${c.overage} | ${c.keepaliveActive} | ${c.positiveSignal} | ${bigNum(c.equivalentBins)} | ${bigNum(c.usableEquivalentBins)} |`,
		);
		out.push("");

		const sweep = input.cellScoresByGroup.find(
			(s) => s.provider === group.provider && s.windowKind === group.windowKind,
		);
		if (sweep && sweep.cells.length > 0) {
			out.push(
				"Cell sweep (selection block chooses; evaluation block reports):",
			);
			out.push("");
			out.push(
				"| lag (min) | width (min) | anchor | role | selection R2 | selection bins | evaluation R2 | evaluation bins | positive-signal bins |",
			);
			out.push("|---:|---:|---|---|---:|---:|---:|---:|---:|");
			for (const cell of sweep.cells) {
				out.push(
					`| ${cell.cell.lagMs / MINUTE_MS} | ${cell.cell.widthMs / MINUTE_MS} | ${cell.cell.anchor} | ${cell.control ? "control" : "candidate"} | ${num(cell.selection.r2)} | ${cell.selection.usableBins} | ${num(cell.evaluation.r2)} | ${cell.evaluation.usableBins} | ${cell.evaluation.positiveSignalBins} |`,
				);
			}
			out.push("");
		}

		const s = group.selection;
		out.push(
			`Selected cell: **${s.selected ? cellLabel(s.selected) : EM_DASH}** (${s.tieBreak})`,
		);
		out.push("");
		out.push(
			`Selection-block R2 ${num(s.selectionR2)}; evaluation-block R2 ${num(s.evaluationR2)}. Verdict: **${verdictLabel(s.verdict)}** — ${s.verdictDetail}`,
		);
		out.push("");
		// Three states, like the controls line below: a sub-check that could not be
		// judged is not a failed one, and the bullets say which one it was.
		out.push(
			`Stability: ${s.stabilityMeasuredFailure ? "FAIL" : s.stabilityPass ? "PASS" : "UNMEASURABLE"}`,
		);
		out.push("");
		for (const detail of s.stabilityDetails) out.push(`- ${detail}`);
		out.push("");
		out.push(
			`Controls: ${s.controlsPass ? "PASS" : s.controlsMeasurable ? "FAIL" : "UNMEASURABLE"}`,
		);
		out.push("");
		for (const detail of s.controlDetails) out.push(`- ${detail}`);
		out.push("");

		if (group.observability) {
			const o = group.observability;
			out.push("Conditional observability (clean cohort):");
			out.push("");
			out.push("| quantity | value | numerator | denominator |");
			out.push("|---|---:|---:|---:|");
			out.push(
				`| P(dPct = 0 given tokens > 0) | ${pctOf(o.silentBurnRate)} | ${o.silentBurnCount} | ${o.tokenBearingBins} |`,
			);
			out.push(
				`| P(tokens = 0 given dPct > 0) | ${pctOf(o.unexplainedRiseRate)} | ${o.unexplainedRiseCount} | ${o.risingBins} |`,
			);
			out.push("");
		}

		if (group.identifiability) {
			const i = group.identifiability;
			out.push("Design-matrix identifiability (clean cohort):");
			out.push("");
			out.push("| column | L2 norm | nonzero bins | token share |");
			out.push("|---|---:|---:|---:|");
			for (const col of i.columns) {
				out.push(
					`| ${col.label} | ${num(col.norm, 1)} | ${col.support} | ${pctOf(col.tokenShare)} |`,
				);
			}
			out.push("");
			out.push(
				`Active columns ${i.activeColumns}; rank ${i.rank ?? EM_DASH} at relative tolerance ${RANK_TOLERANCE}; condition number ${num(i.conditionNumber, 1)} against a maximum of ${IDENTIFIABILITY_MAX_CONDITION}.`,
			);
			out.push("");
			if (i.singularValues.length > 0) {
				out.push(
					`Singular values (unit-scaled columns): ${i.singularValues.map((v) => v.toFixed(4)).join(", ")}`,
				);
				out.push("");
			}
			if (i.collinearPairs.length > 0) {
				out.push("| column pair | correlation |");
				out.push("|---|---:|");
				for (const pair of i.collinearPairs.slice(0, 20)) {
					out.push(`| ${pair.a} vs ${pair.b} | ${num(pair.correlation)} |`);
				}
				out.push("");
			}
		}

		if (group.concentration) {
			out.push("Account concentration (clean cohort):");
			out.push("");
			out.push(
				"| account | usable bins | positive-signal bins | token mass | share | leave-one-out R2 |",
			);
			out.push("|---|---:|---:|---:|---:|---:|");
			for (const a of group.concentration.accounts) {
				out.push(
					`| ${a.accountId} | ${a.usableBins} | ${a.positiveSignalBins} | ${bigNum(a.tokenMass)} | ${pctOf(a.tokenShare)} | ${num(a.leaveOneOutR2)} |`,
				);
			}
			out.push("");
			out.push(
				`Effective accounts (inverse HHI) ${num(group.concentration.effectiveAccounts, 2)} against a floor of ${EFFECTIVE_ACCOUNTS_MIN}; pooled R2 ${num(group.concentration.pooledR2)}.`,
			);
			out.push("");
		}

		if (group.era) {
			out.push("Era stability (matched account x family x class strata):");
			out.push("");
			out.push(
				"| boundary | qualifying strata | pooled ratio before | pooled ratio after | relative change | before CI | after CI | verdict |",
			);
			out.push("|---|---:|---:|---:|---:|---|---|---|");
			for (const b of group.era.boundaries) {
				out.push(
					`| ${b.boundary.label} | ${b.qualifyingStrata} | ${num(b.pooledRatioBefore, 9)} | ${num(b.pooledRatioAfter, 9)} | ${pctOf(b.relativeChange)} | ${num(b.beforeCi[0], 9)} .. ${num(b.beforeCi[1], 9)} | ${num(b.afterCi[0], 9)} .. ${num(b.afterCi[1], 9)} | ${verdictLabel(b.verdict)} |`,
				);
			}
			out.push("");
			for (const b of group.era.boundaries) {
				out.push(`- ${b.boundary.label}: ${b.detail}`);
			}
			out.push("");
		}

		out.push("Tier provenance (informational):");
		out.push("");
		out.push(TIER_PROVENANCE_SECTION);
		out.push("");
	}

	if (input.notes && input.notes.length > 0) {
		out.push("## Notes");
		out.push("");
		for (const note of input.notes) out.push(`- ${note}`);
		out.push("");
	}

	return `${out.join("\n").trimEnd()}\n`;
}
