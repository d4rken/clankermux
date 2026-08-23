import type { PredictionPoint } from "@clankermux/types";
import { computeUsagePrediction } from "./usage-prediction";

/**
 * Offline replay harness for the usage-exhaustion estimators.
 *
 * PURE: no DB, no clock, no `Math.random`. Everything here takes arrays in and
 * returns metrics out, exactly like `computeUsagePrediction`, so it is unit
 * testable and reproducible. The I/O lives in `scripts/prediction-backtest.ts`.
 *
 * This is a development tool. It must never run on the request path.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const LIMIT = 100;

export const FIVE_HOUR_WINDOW_MS = 5 * HOUR_MS;
export const SEVEN_DAY_WINDOW_MS = 7 * 24 * HOUR_MS;

/**
 * How far the last sample of a window may sit from the window's end before the
 * label becomes untrustworthy. The sampler runs every 120 s; a gap wider than
 * this can hide an exhaustion, so such windows are CENSORED rather than
 * counted as survivals.
 */
export const SEGMENT_COVERAGE_SLACK_MS = 10 * MINUTE_MS;

/** Minimum points/span the naive-persistence baseline needs to answer. */
const NAIVE_LOOKBACK_MS = HOUR_MS;
const NAIVE_MIN_SPAN_MS = 5 * MINUTE_MS;

export type BacktestWindowKind = "five_hour" | "seven_day";

export type BacktestOutcome =
	| { kind: "exhausted"; atMs: number }
	| { kind: "survived" }
	| { kind: "censored" };

/**
 * Why an estimator declined to answer at an instant. Every record is either
 * usable or carries exactly one of these, so coverage counts sum to the number
 * of instants.
 */
export type UnusableReason =
	| "insufficient_data"
	| "low_confidence"
	| "no_slope"
	| "no_reset";

export interface BacktestRecord {
	/** The prediction instant (an ACTUAL snapshot timestamp, never synthetic). */
	T: number;
	windowKind: BacktestWindowKind;
	accountId: string;
	provider: string | null;
	usable: boolean;
	unusableReason: UnusableReason | null;
	/** Did the estimator claim this window exhausts before its reset? */
	predictsExhaust: boolean;
	predictedEtaMs: number | null;
	outcome: BacktestOutcome;
	resetAtMs: number | null;
	windowMs: number;
}

// ---------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------

/**
 * Label what actually happened to a WINDOW after a prediction made at `T`.
 *
 * `windowSeries` must be window-scoped: split the raw per-account series with
 * `isResetBoundary`, NOT `isFitBoundary`. A refund drops utilization by more
 * than the fit threshold without ending the quota window, and such a window can
 * still exhaust later; segmenting on the fit rule would label that exhaustion
 * as belonging to a different window and lose it.
 *
 * `survived` is only ever asserted from POSITIVE evidence: the next window was
 * observed to start, and this window's sampling ran up to (within
 * `SEGMENT_COVERAGE_SLACK_MS` of) its end. Anything else is `censored` and is
 * excluded from the confusion matrix and the error distributions, because an
 * exhaustion could be hiding in the gap.
 */
export function deriveOutcome(
	windowSeries: readonly PredictionPoint[],
	T: number,
	resetAtMs: number | null,
	nextWindowStartsMs: number | null,
): BacktestOutcome {
	for (const p of windowSeries) {
		if (p.t > T && p.utilization >= LIMIT) {
			return { kind: "exhausted", atMs: p.t };
		}
	}
	// No observed reset transition => the window is still in progress at the end
	// of history (or the next window's samples are missing).
	if (nextWindowStartsMs == null) return { kind: "censored" };
	const last = windowSeries.length
		? windowSeries[windowSeries.length - 1]
		: null;
	if (last == null) return { kind: "censored" };
	const bounds: number[] = [];
	if (resetAtMs != null) bounds.push(resetAtMs);
	bounds.push(nextWindowStartsMs);
	const windowEnd = Math.min(...bounds);
	if (windowEnd - last.t > SEGMENT_COVERAGE_SLACK_MS) {
		return { kind: "censored" };
	}
	return { kind: "survived" };
}

/** Did this window actually exhaust before its reset? (the positive class) */
function isActualPositive(record: BacktestRecord): boolean {
	const { outcome } = record;
	if (outcome.kind !== "exhausted") return false;
	if (record.resetAtMs == null) return true;
	return outcome.atMs < record.resetAtMs;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface CoverageCounts {
	usable: number;
	insufficient_data: number;
	low_confidence: number;
	no_slope: number;
	no_reset: number;
}

export interface ConfusionMatrix {
	tp: number;
	fp: number;
	tn: number;
	fn: number;
}

export interface ErrorDistribution {
	n: number;
	medianMinutes: number | null;
	p10Minutes: number | null;
	p90Minutes: number | null;
	medianWindowFraction: number | null;
	p10WindowFraction: number | null;
	p90WindowFraction: number | null;
}

export interface LeadTimeBucketMetrics {
	label: string;
	tp: number;
	fn: number;
	recall: number | null;
	medianSignedErrorMinutes: number | null;
}

export interface FalsePositiveLeadBucket {
	label: string;
	fp: number;
}

export interface BacktestMetrics {
	/** Every record handed in, usable or not. */
	instants: number;
	/** Records that entered the confusion matrix (usable and not censored). */
	scored: number;
	/** Records whose outcome could not be observed (any usability). */
	censored: number;
	coverage: CoverageCounts;
	confusion: ConfusionMatrix;
	precision: number | null;
	recall: number | null;
	f1: number | null;
	signedEtaError: ErrorDistribution;
	absoluteEtaError: ErrorDistribution;
	leadTimeBuckets: LeadTimeBucketMetrics[];
	falsePositiveLeadTimeBuckets: FalsePositiveLeadBucket[];
}

interface LeadBucketSpec {
	label: string;
	maxMs: number;
}

const LEAD_TIME_BUCKETS: LeadBucketSpec[] = [
	{ label: "<30m", maxMs: 30 * MINUTE_MS },
	{ label: "30m-2h", maxMs: 2 * HOUR_MS },
	{ label: "2h-12h", maxMs: 12 * HOUR_MS },
	{ label: "12h-48h", maxMs: 48 * HOUR_MS },
	{ label: ">48h", maxMs: Number.POSITIVE_INFINITY },
];

function leadBucketIndex(leadMs: number): number {
	for (let i = 0; i < LEAD_TIME_BUCKETS.length; i++) {
		if (leadMs < LEAD_TIME_BUCKETS[i].maxMs) return i;
	}
	return LEAD_TIME_BUCKETS.length - 1;
}

/** Nearest-rank percentile over an ASCENDING array. Empty => null. */
function percentile(sorted: number[], p: number): number | null {
	if (sorted.length === 0) return null;
	const rank = Math.min(
		sorted.length,
		Math.max(1, Math.ceil(p * sorted.length)),
	);
	return sorted[rank - 1];
}

function distribution(
	minutes: number[],
	fractions: number[],
): ErrorDistribution {
	const m = [...minutes].sort((a, b) => a - b);
	const f = [...fractions].sort((a, b) => a - b);
	return {
		n: m.length,
		medianMinutes: percentile(m, 0.5),
		p10Minutes: percentile(m, 0.1),
		p90Minutes: percentile(m, 0.9),
		medianWindowFraction: percentile(f, 0.5),
		p10WindowFraction: percentile(f, 0.1),
		p90WindowFraction: percentile(f, 0.9),
	};
}

/**
 * Score a set of records.
 *
 * Confusion and error distributions cover records that are USABLE and whose
 * outcome was OBSERVED; censored and unusable instants are reported as counts
 * instead (an estimator that refuses to answer is absent, not accurate).
 *
 * Rates are `null` when undefined rather than 0: no actual positives means
 * recall has no denominator, and reporting 0 there would read as "missed
 * everything".
 */
export function scoreRecords(
	records: readonly BacktestRecord[],
): BacktestMetrics {
	const coverage: CoverageCounts = {
		usable: 0,
		insufficient_data: 0,
		low_confidence: 0,
		no_slope: 0,
		no_reset: 0,
	};
	let censored = 0;
	for (const r of records) {
		if (r.usable) coverage.usable++;
		else if (r.unusableReason != null) coverage[r.unusableReason]++;
		if (r.outcome.kind === "censored") censored++;
	}

	const scored = records.filter(
		(r) => r.usable && r.outcome.kind !== "censored",
	);
	const confusion: ConfusionMatrix = { tp: 0, fp: 0, tn: 0, fn: 0 };
	const signedMinutes: number[] = [];
	const signedFractions: number[] = [];
	const absMinutes: number[] = [];
	const absFractions: number[] = [];
	const bucketTp = LEAD_TIME_BUCKETS.map(() => 0);
	const bucketFn = LEAD_TIME_BUCKETS.map(() => 0);
	const bucketSigned: number[][] = LEAD_TIME_BUCKETS.map(() => []);
	const bucketFp = LEAD_TIME_BUCKETS.map(() => 0);

	for (const r of scored) {
		const actual = isActualPositive(r);
		if (r.predictsExhaust && actual) confusion.tp++;
		else if (r.predictsExhaust && !actual) confusion.fp++;
		else if (!r.predictsExhaust && actual) confusion.fn++;
		else confusion.tn++;

		if (r.outcome.kind === "exhausted" && r.predictedEtaMs != null) {
			const signedMs = r.predictedEtaMs - r.outcome.atMs;
			signedMinutes.push(signedMs / MINUTE_MS);
			signedFractions.push(signedMs / r.windowMs);
			absMinutes.push(Math.abs(signedMs) / MINUTE_MS);
			absFractions.push(Math.abs(signedMs) / r.windowMs);
		}

		if (actual && r.outcome.kind === "exhausted") {
			const idx = leadBucketIndex(r.outcome.atMs - r.T);
			if (r.predictsExhaust) bucketTp[idx]++;
			else bucketFn[idx]++;
			if (r.predictedEtaMs != null) {
				bucketSigned[idx].push((r.predictedEtaMs - r.outcome.atMs) / MINUTE_MS);
			}
		} else if (r.predictsExhaust && r.predictedEtaMs != null) {
			// A false positive has no actual exhaustion time, so it is bucketed by
			// how far ahead it CLAIMED the exhaustion would be.
			bucketFp[leadBucketIndex(r.predictedEtaMs - r.T)]++;
		}
	}

	const { tp, fp, fn } = confusion;
	const precision = tp + fp > 0 ? tp / (tp + fp) : null;
	const recall = tp + fn > 0 ? tp / (tp + fn) : null;
	const f1Denominator = 2 * tp + fp + fn;
	const f1 = f1Denominator > 0 ? (2 * tp) / f1Denominator : null;

	return {
		instants: records.length,
		scored: scored.length,
		censored,
		coverage,
		confusion,
		precision,
		recall,
		f1,
		signedEtaError: distribution(signedMinutes, signedFractions),
		absoluteEtaError: distribution(absMinutes, absFractions),
		leadTimeBuckets: LEAD_TIME_BUCKETS.map((spec, i) => {
			const total = bucketTp[i] + bucketFn[i];
			const sorted = [...bucketSigned[i]].sort((a, b) => a - b);
			return {
				label: spec.label,
				tp: bucketTp[i],
				fn: bucketFn[i],
				recall: total > 0 ? bucketTp[i] / total : null,
				medianSignedErrorMinutes: percentile(sorted, 0.5),
			};
		}),
		falsePositiveLeadTimeBuckets: LEAD_TIME_BUCKETS.map((spec, i) => ({
			label: spec.label,
			fp: bucketFp[i],
		})),
	};
}

/** Per-account F1 averaged with equal weight, so one busy account cannot carry the number. */
export function macroAverageByAccount(
	records: readonly BacktestRecord[],
): number | null {
	const byAccount = new Map<string, BacktestRecord[]>();
	for (const r of records) {
		const list = byAccount.get(r.accountId);
		if (list) list.push(r);
		else byAccount.set(r.accountId, [r]);
	}
	const values: number[] = [];
	for (const list of byAccount.values()) {
		const f1 = scoreRecords(list).f1;
		if (f1 != null) values.push(f1);
	}
	if (values.length === 0) return null;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

function cohortKey(r: BacktestRecord): string {
	return `${r.accountId} ${r.windowKind} ${r.T}`;
}

/**
 * Restrict every estimator to the (account, window, instant) triples where ALL
 * of them are usable and the outcome was observed. Comparing estimators on
 * their own conditional records rewards refusing to answer on hard instants;
 * the common cohort is the like-for-like comparison. Conditional metrics stay
 * worth reporting because coverage itself is a result.
 */
export function commonCohort(
	recordsByEstimator: ReadonlyMap<string, readonly BacktestRecord[]>,
): Map<string, BacktestRecord[]> {
	const names = [...recordsByEstimator.keys()];
	const indexed = new Map<string, Map<string, BacktestRecord>>();
	for (const name of names) {
		const byKey = new Map<string, BacktestRecord>();
		for (const r of recordsByEstimator.get(name) ?? [])
			byKey.set(cohortKey(r), r);
		indexed.set(name, byKey);
	}
	const first = names.length ? indexed.get(names[0]) : undefined;
	const keep = new Set<string>();
	for (const key of first?.keys() ?? []) {
		let ok = true;
		for (const name of names) {
			const r = indexed.get(name)?.get(key);
			if (!r?.usable || r.outcome.kind === "censored") {
				ok = false;
				break;
			}
		}
		if (ok) keep.add(key);
	}
	const out = new Map<string, BacktestRecord[]>();
	for (const name of names) {
		out.set(
			name,
			(recordsByEstimator.get(name) ?? []).filter((r) =>
				keep.has(cohortKey(r)),
			),
		);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export type BacktestStatistic = "f1" | "medianAbsErrorMinutes";

export interface BootstrapOptions {
	iterations: number;
	seed: number;
	statistic: BacktestStatistic;
}

export interface BootstrapCi {
	p2_5: number | null;
	p50: number | null;
	p97_5: number | null;
	/** Resamples that produced a defined delta on BOTH sides. */
	samples: number;
	iterations: number;
}

/** xorshift128. Deterministic and seedable; `Math.random` is not allowed here. */
function makePrng(seed: number): () => number {
	let x = seed >>> 0 || 0x9e3779b9;
	let y = 0x243f6a88;
	let z = 0xb7e15162;
	let w = 0x1f123bb5;
	// Discard a few outputs so nearby seeds diverge.
	const next = () => {
		const t = x ^ (x << 11);
		x = y;
		y = z;
		z = w;
		w = w ^ (w >>> 19) ^ (t ^ (t >>> 8));
		return (w >>> 0) / 0x1_0000_0000;
	};
	for (let i = 0; i < 8; i++) next();
	return next;
}

function statisticOf(
	records: BacktestRecord[],
	statistic: BacktestStatistic,
): number | null {
	const m = scoreRecords(records);
	return statistic === "f1" ? m.f1 : m.absoluteEtaError.medianMinutes;
}

function groupByAccount(
	records: readonly BacktestRecord[],
): Map<string, BacktestRecord[]> {
	const out = new Map<string, BacktestRecord[]>();
	for (const r of records) {
		const list = out.get(r.accountId);
		if (list) list.push(r);
		else out.set(r.accountId, [r]);
	}
	return out;
}

/**
 * Bootstrap CI on the A-minus-B delta of a statistic, resampling ACCOUNTS with
 * replacement. Samples 10 minutes apart within one account are heavily
 * correlated, so resampling individual instants would understate the interval
 * by pretending they are independent draws.
 */
export function bootstrapDelta(
	recordsA: readonly BacktestRecord[],
	recordsB: readonly BacktestRecord[],
	opts: BootstrapOptions,
): BootstrapCi {
	const byAccountA = groupByAccount(recordsA);
	const byAccountB = groupByAccount(recordsB);
	const accounts = [
		...new Set([...byAccountA.keys(), ...byAccountB.keys()]),
	].sort();
	if (accounts.length === 0) {
		return {
			p2_5: null,
			p50: null,
			p97_5: null,
			samples: 0,
			iterations: opts.iterations,
		};
	}
	const rand = makePrng(opts.seed);
	const deltas: number[] = [];
	for (let i = 0; i < opts.iterations; i++) {
		const drawA: BacktestRecord[] = [];
		const drawB: BacktestRecord[] = [];
		for (let k = 0; k < accounts.length; k++) {
			const account = accounts[Math.floor(rand() * accounts.length)];
			const a = byAccountA.get(account);
			const b = byAccountB.get(account);
			if (a) drawA.push(...a);
			if (b) drawB.push(...b);
		}
		const statA = statisticOf(drawA, opts.statistic);
		const statB = statisticOf(drawB, opts.statistic);
		if (statA == null || statB == null) continue;
		deltas.push(statA - statB);
	}
	deltas.sort((a, b) => a - b);
	return {
		p2_5: percentile(deltas, 0.025),
		p50: percentile(deltas, 0.5),
		p97_5: percentile(deltas, 0.975),
		samples: deltas.length,
		iterations: opts.iterations,
	};
}

// ---------------------------------------------------------------------------
// Estimator adapters
// ---------------------------------------------------------------------------

export interface EstimatorWindow {
	windowMs: number;
	lookbackMs: number;
}

export interface EstimatorOutput {
	predictedEtaMs: number | null;
	predictsExhaust: boolean;
	usable: boolean;
	unusableReason: UnusableReason | null;
}

/**
 * Every estimator sees only points at or before `T` and applies the production
 * lookback itself. No synthetic "live" point is appended: production appends the
 * live reading at `now`, but replay has no reading that is not already a stored
 * row, and inventing one would be a point-in-time lie.
 */
export type Estimator = (
	pointsUpToT: readonly PredictionPoint[],
	T: number,
	window: EstimatorWindow,
) => EstimatorOutput;

function unusable(reason: UnusableReason): EstimatorOutput {
	return {
		predictedEtaMs: null,
		predictsExhaust: false,
		usable: false,
		unusableReason: reason,
	};
}

function withinLookback(
	points: readonly PredictionPoint[],
	T: number,
	lookbackMs: number,
): PredictionPoint[] {
	const from = T - lookbackMs;
	return points.filter((p) => p.t >= from && p.t <= T);
}

/** The shipped estimator: `computeUsagePrediction` over the production lookback. */
export function makeOlsEstimator(): Estimator {
	return (points, T, window) => {
		const input = withinLookback(points, T, window.lookbackMs);
		const pred = computeUsagePrediction(input);
		const resetAt = input.length ? input[input.length - 1].resetsAt : null;
		if (pred.state === "insufficient_data")
			return unusable("insufficient_data");
		// Already at the cap: there is nothing to extrapolate from.
		if (pred.state === "exhausted") return unusable("no_slope");
		if (pred.lowConfidence) return unusable("low_confidence");
		const eta = pred.etaExhaustMs;
		return {
			predictedEtaMs: eta,
			predictsExhaust: eta != null && (resetAt == null || eta < resetAt),
			usable: true,
			unusableReason: null,
		};
	};
}

/**
 * The current fallback for every provider without snapshots: `(100 - pct)/pct x
 * elapsed`, where elapsed is measured from the window start implied by the
 * reset. Averages in idle time by construction.
 */
export const lifetimeAverageEstimator: Estimator = (points, T, window) => {
	const input = withinLookback(points, T, window.lookbackMs);
	const last = input.length ? input[input.length - 1] : null;
	const resetAt = last?.resetsAt ?? null;
	// No reset => no window start => no elapsed time. Never guess one.
	if (resetAt == null || last == null) return unusable("no_reset");
	const windowStart = resetAt - window.windowMs;
	const elapsedMs = T - windowStart;
	const pct = last.utilization;
	if (!(elapsedMs > 0) || !(pct > 0)) return unusable("no_slope");
	const eta = Math.round(T + ((LIMIT - pct) / pct) * elapsedMs);
	return {
		predictedEtaMs: eta,
		predictsExhaust: eta < resetAt,
		usable: true,
		unusableReason: null,
	};
};

/** "The next hour looks like the last hour." */
export const naivePersistenceEstimator: Estimator = (points, T) => {
	const input = withinLookback(points, T, NAIVE_LOOKBACK_MS);
	if (input.length < 2) return unusable("insufficient_data");
	const first = input[0];
	const last = input[input.length - 1];
	const spanMs = last.t - first.t;
	if (spanMs < NAIVE_MIN_SPAN_MS) return unusable("low_confidence");
	const slopePerHour =
		(last.utilization - first.utilization) / (spanMs / HOUR_MS);
	if (slopePerHour <= 0) {
		return {
			predictedEtaMs: null,
			predictsExhaust: false,
			usable: true,
			unusableReason: null,
		};
	}
	const resetAt = last.resetsAt;
	const eta = Math.round(
		last.t + ((LIMIT - last.utilization) / slopePerHour) * HOUR_MS,
	);
	return {
		predictedEtaMs: eta,
		predictsExhaust: resetAt == null || eta < resetAt,
		usable: true,
		unusableReason: null,
	};
};

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

export interface ReportDatasetSummary {
	rows: number;
	accounts: number;
	providers: string[];
	firstSampleIso: string;
	lastSampleIso: string;
}

export interface ReportEstimatorMetrics {
	estimator: string;
	metrics: BacktestMetrics;
}

export interface ReportProviderMetrics extends ReportEstimatorMetrics {
	provider: string;
}

export interface ReportAccountContribution {
	accountId: string;
	provider: string | null;
	instants: number;
	scored: number;
	positives: number;
}

export interface ReportBootstrapEntry {
	label: string;
	statistic: string;
	p2_5: number | null;
	p50: number | null;
	p97_5: number | null;
	samples: number;
}

export interface ReportSweepEntry {
	estimator: string;
	tauLabel: string;
	f1: number | null;
	medianAbsErrorMinutes: number | null;
	usableCoverage: number | null;
	scored: number;
}

export interface ReportWindowBlock {
	windowKind: BacktestWindowKind;
	conditional: ReportEstimatorMetrics[];
	commonCohort: ReportEstimatorMetrics[];
	byProvider: ReportProviderMetrics[];
	byAccount: ReportAccountContribution[];
	macroF1: { estimator: string; macroF1: number | null }[];
	bootstrap?: ReportBootstrapEntry[];
	sweep?: ReportSweepEntry[];
	notes?: string[];
}

export interface ReportRange {
	label: string;
	fromIso: string;
	toIso: string;
	windows: ReportWindowBlock[];
	notes?: string[];
}

export interface ReportRateLimitDiagnosticRow {
	accountId: string;
	provider: string | null;
	windowKind: BacktestWindowKind;
	survivedWindows: number;
	survivedWindowsWith429: number;
	requests429: number;
}

export interface BacktestReportInput {
	title: string;
	generatedAtIso: string;
	/** The exact invocation, so the report is reproducible. */
	command: string;
	config: Record<string, string | number | boolean | null>;
	dataset: ReportDatasetSummary;
	ranges: ReportRange[];
	rateLimitDiagnostic: ReportRateLimitDiagnosticRow[];
	notes?: string[];
	/** Appended verbatim after the generated sections. */
	trailer?: string;
}

const EM_DASH = "—";

function num(v: number | null, digits = 3): string {
	if (v == null || !Number.isFinite(v)) return EM_DASH;
	return v.toFixed(digits);
}

function pct(v: number | null): string {
	if (v == null || !Number.isFinite(v)) return EM_DASH;
	return `${(v * 100).toFixed(1)}%`;
}

function coverageFraction(m: BacktestMetrics): number | null {
	return m.instants > 0 ? m.coverage.usable / m.instants : null;
}

function metricsTable(rows: ReportEstimatorMetrics[]): string {
	const head = [
		"| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |",
		"|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
	];
	const body = rows.map((r) => {
		const m = r.metrics;
		return `| ${r.estimator} | ${m.instants} | ${pct(coverageFraction(m))} | ${m.scored} | ${m.censored} | ${m.confusion.tp} | ${m.confusion.fp} | ${m.confusion.tn} | ${m.confusion.fn} | ${num(m.precision)} | ${num(m.recall)} | ${num(m.f1)} | ${num(m.signedEtaError.medianMinutes, 1)} | ${num(m.absoluteEtaError.medianMinutes, 1)} | ${num(m.absoluteEtaError.medianWindowFraction)} |`;
	});
	return [...head, ...body].join("\n");
}

function coverageTable(rows: ReportEstimatorMetrics[]): string {
	const head = [
		"| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |",
		"|---|---:|---:|---:|---:|---:|---:|",
	];
	const body = rows.map(({ estimator, metrics: m }) => {
		const c = m.coverage;
		return `| ${estimator} | ${c.usable} | ${c.insufficient_data} | ${c.low_confidence} | ${c.no_slope} | ${c.no_reset} | ${m.instants} |`;
	});
	return [...head, ...body].join("\n");
}

function leadTimeTable(rows: ReportEstimatorMetrics[]): string {
	const head = [
		"| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |",
		"|---|---|---:|---:|---:|---:|---:|",
	];
	const body: string[] = [];
	for (const { estimator, metrics: m } of rows) {
		const fpByLabel = new Map(
			m.falsePositiveLeadTimeBuckets.map((b) => [b.label, b.fp]),
		);
		for (const b of m.leadTimeBuckets) {
			body.push(
				`| ${estimator} | ${b.label} | ${b.tp} | ${b.fn} | ${num(b.recall)} | ${num(b.medianSignedErrorMinutes, 1)} | ${fpByLabel.get(b.label) ?? 0} |`,
			);
		}
	}
	return [...head, ...body].join("\n");
}

const METHODOLOGY = `## Methodology

- **Point-in-time replay.** For a prediction at instant \`T\` an estimator sees
  only stored snapshots with \`sampled_at <= T\`, then applies the production
  lookback itself (6 h for the 5-hour window, 24 h for the weekly one).
- **No fabricated live point.** The production path appends the live usage
  reading stamped \`now\`; replay has no such reading, so nothing is appended.
  Candidate instants are ACTUAL snapshot timestamps, so the newest input point
  is at most one sampler tick (120 s) old, which is what production sees.
- **Window-scoped ground truth.** Raw per-account series are split on the
  WINDOW-lifecycle boundary (\`resets_at\` changed beyond the 60 s jitter
  tolerance), not on the estimator's fit boundary. A refund drops utilization
  by more than the fit threshold without ending the quota window, and such a
  window can still exhaust later.
- **Censoring.** \`survived\` is asserted only from positive evidence: the next
  window was observed to start AND this window's last sample is within 10
  minutes of the window end. Otherwise the instant is CENSORED and excluded
  from the confusion matrix and the error distributions, because an exhaustion
  could hide in the gap. Censored counts are reported.
- **Label horizon.** Candidate instants whose outcome region would extend past
  the scoring range's end are dropped, so no label peeks across a
  tuning/held-out boundary.
- **Positive class** = the window reaches 100% before its reset. Class balance
  is heavily skewed, so accuracy is not reported: the confusion matrix, F1 and
  the per-lead-time recall are.
- **Signed vs absolute error.** Both are reported: the absolute median is not
  the magnitude of the signed median, and only the signed one shows the
  early/late bias.
- **Integer quantisation caveat.** \`five_hour_pct\` and \`seven_day_pct\` are
  stored as integers. One point of a 5-hour window is ~3 minutes of headroom,
  so a fit over three identical integers cannot resolve a slope finer than
  that. Sub-quantum ETA differences between estimators are noise.
- **429 diagnostic.** 429 responses inside windows labelled \`survived\` are
  counted as a label-quality signal only. They are never an input to a label:
  a 429 can come from a different (family-scoped) limit than the window being
  scored.
- **Bootstrap.** Confidence intervals resample ACCOUNTS with replacement, not
  instants: samples minutes apart within one account are correlated.`;

/** Deterministic markdown. Every date/number comes from the input; no clock reads. */
export function formatBacktestReport(input: BacktestReportInput): string {
	const out: string[] = [];
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
	const configKeys = Object.keys(input.config).sort();
	if (configKeys.length > 0) {
		out.push("| config | value |");
		out.push("|---|---|");
		for (const k of configKeys)
			out.push(`| ${k} | ${input.config[k] ?? EM_DASH} |`);
		out.push("");
	}

	out.push("## Dataset");
	out.push("");
	out.push("| field | value |");
	out.push("|---|---|");
	out.push(`| usage_snapshots rows | ${input.dataset.rows} |`);
	out.push(`| accounts | ${input.dataset.accounts} |`);
	out.push(
		`| providers | ${input.dataset.providers.length ? input.dataset.providers.join(", ") : EM_DASH} |`,
	);
	out.push(`| first sample | ${input.dataset.firstSampleIso} |`);
	out.push(`| last sample | ${input.dataset.lastSampleIso} |`);
	out.push("");

	out.push(METHODOLOGY);
	out.push("");

	for (const range of input.ranges) {
		out.push(`## ${range.label}`);
		out.push("");
		out.push(`Scoring interval: \`[${range.fromIso}, ${range.toIso})\``);
		out.push("");
		for (const note of range.notes ?? []) {
			out.push(`- ${note}`);
		}
		if (range.notes?.length) out.push("");
		for (const w of range.windows) {
			out.push(`### ${range.label} — ${w.windowKind}`);
			out.push("");
			out.push("Conditional (each estimator on the instants it can answer):");
			out.push("");
			out.push(metricsTable(w.conditional));
			out.push("");
			out.push("Coverage:");
			out.push("");
			out.push(coverageTable(w.conditional));
			out.push("");
			if (w.commonCohort.length > 0) {
				out.push("Common cohort (instants every estimator answered):");
				out.push("");
				out.push(metricsTable(w.commonCohort));
				out.push("");
				out.push("Lead time (common cohort):");
				out.push("");
				out.push(leadTimeTable(w.commonCohort));
				out.push("");
			}
			if (w.macroF1.length > 0) {
				out.push("Macro F1 (per-account, equal weight; common cohort):");
				out.push("");
				out.push("| estimator | macro F1 |");
				out.push("|---|---:|");
				for (const m of w.macroF1) {
					out.push(`| ${m.estimator} | ${num(m.macroF1)} |`);
				}
				out.push("");
			}
			if (w.byProvider.length > 0) {
				out.push("By provider (common cohort):");
				out.push("");
				out.push(
					"| provider | estimator | scored | TP | FP | TN | FN | F1 | median abs err (min) |",
				);
				out.push("|---|---|---:|---:|---:|---:|---:|---:|---:|");
				for (const r of w.byProvider) {
					const m = r.metrics;
					out.push(
						`| ${r.provider} | ${r.estimator} | ${m.scored} | ${m.confusion.tp} | ${m.confusion.fp} | ${m.confusion.tn} | ${m.confusion.fn} | ${num(m.f1)} | ${num(m.absoluteEtaError.medianMinutes, 1)} |`,
					);
				}
				out.push("");
			}
			if (w.byAccount.length > 0) {
				out.push("Per-account contribution:");
				out.push("");
				out.push(
					"| account | provider | instants | scored | actual positives |",
				);
				out.push("|---|---|---:|---:|---:|");
				for (const a of w.byAccount) {
					out.push(
						`| ${a.accountId} | ${a.provider ?? EM_DASH} | ${a.instants} | ${a.scored} | ${a.positives} |`,
					);
				}
				out.push("");
			}
			if (w.sweep && w.sweep.length > 0) {
				out.push("Tau sweep:");
				out.push("");
				out.push(
					"| estimator | tau | scored | F1 | median abs err (min) | usable coverage |",
				);
				out.push("|---|---|---:|---:|---:|---:|");
				for (const s of w.sweep) {
					out.push(
						`| ${s.estimator} | ${s.tauLabel} | ${s.scored} | ${num(s.f1)} | ${num(s.medianAbsErrorMinutes, 1)} | ${pct(s.usableCoverage)} |`,
					);
				}
				out.push("");
			}
			if (w.bootstrap && w.bootstrap.length > 0) {
				out.push("Bootstrap (accounts resampled with replacement):");
				out.push("");
				out.push(
					"| comparison | statistic | p2.5 | median | p97.5 | resamples |",
				);
				out.push("|---|---|---:|---:|---:|---:|");
				for (const b of w.bootstrap) {
					out.push(
						`| ${b.label} | ${b.statistic} | ${num(b.p2_5)} | ${num(b.p50)} | ${num(b.p97_5)} | ${b.samples} |`,
					);
				}
				out.push("");
			}
			for (const note of w.notes ?? []) out.push(`- ${note}`);
			if (w.notes?.length) out.push("");
		}
	}

	out.push("## 429 diagnostic (label quality only)");
	out.push("");
	out.push(
		"Count of `requests` rows with `status_code = 429` falling inside windows this harness labelled `survived`. A high count would mean the polled percent missed real exhaustions. This is NEVER an input to a label.",
	);
	out.push("");
	if (input.rateLimitDiagnostic.length === 0) {
		out.push("No survived windows to check.");
	} else {
		out.push(
			"| account | provider | window | survived windows | with a 429 | 429 requests |",
		);
		out.push("|---|---|---|---:|---:|---:|");
		for (const r of input.rateLimitDiagnostic) {
			out.push(
				`| ${r.accountId} | ${r.provider ?? EM_DASH} | ${r.windowKind} | ${r.survivedWindows} | ${r.survivedWindowsWith429} | ${r.requests429} |`,
			);
		}
	}
	out.push("");
	if (input.notes && input.notes.length > 0) {
		out.push("## Notes");
		out.push("");
		for (const n of input.notes) out.push(`- ${n}`);
		out.push("");
	}
	if (input.trailer) {
		out.push(input.trailer.trimEnd());
		out.push("");
	}
	return `${out.join("\n").trimEnd()}\n`;
}
