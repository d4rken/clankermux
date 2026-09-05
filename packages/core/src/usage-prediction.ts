import type { PredictionPoint, UsagePrediction } from "@clankermux/types";

const HOUR_MS = 3_600_000;
const MIN_POINTS = 3;
const MIN_SPAN_MS = 5 * 60 * 1000;
const RESET_JITTER_TOLERANCE_MS = 60_000;
const LIMIT = 100;

/**
 * WINDOW-LIFECYCLE boundary: `prev` and `cur` belong to different quota
 * windows. True when `resets_at` changed by more than the jitter tolerance,
 * counting a null <-> value transition as a change (idle vs active).
 *
 * This is deliberately NOT the estimator's segmentation rule: a refund drops
 * utilization without ending the quota window. Ground-truth labelling (see
 * `prediction-backtest.ts`) must split on THIS predicate so a window that gets
 * refunded and later exhausts is still one window.
 */
export function isResetBoundary(
	prev: PredictionPoint,
	cur: PredictionPoint,
): boolean {
	const prevReset = prev.resetsAt ?? null;
	const curReset = cur.resetsAt ?? null;
	if (prevReset == null && curReset == null) return false;
	if (prevReset == null || curReset == null) return true;
	return Math.abs(curReset - prevReset) > RESET_JITTER_TOLERANCE_MS;
}

/**
 * Smallest downward move in reported utilization (percentage points) that
 * counts as a MID-WINDOW REVISION: a refund, a gift credit, or a reset the
 * `resets_at` column has not caught up with yet.
 *
 * This is the ONE threshold for that judgement. The regression restarts its fit
 * on it (`isFitBoundary`) and the burn-anchor registry anchors the lifetime
 * baseline on it (`observeUsageReading` in `@clankermux/proxy`); the two must
 * agree, or a drop can anchor the lifetime path while the regression keeps
 * fitting across it.
 */
export const REVISION_MIN_DROP_PCT = 5;

/**
 * True when `curPct` is a revision below `prevPct`.
 *
 * INCLUSIVE at the threshold: providers report whole percents, so 5.0 pp is the
 * smallest drop the threshold can actually observe, and treating it as a
 * revision only ever shortens a fit (the conservative direction).
 */
export function isRevisionDrop(prevPct: number, curPct: number): boolean {
	return prevPct - curPct >= REVISION_MIN_DROP_PCT;
}

/**
 * FIT boundary: the point at which the regression restarts. A reset boundary,
 * or a utilization drop of at least `REVISION_MIN_DROP_PCT` (a refund, or a
 * reset the `resets_at` column has not caught up with yet).
 */
export function isFitBoundary(
	prev: PredictionPoint,
	cur: PredictionPoint,
): boolean {
	return (
		isResetBoundary(prev, cur) || isRevisionDrop(prev.utilization, cur.utilization)
	);
}

/**
 * Split an ascending-by-time series wherever `predicate(prev, cur)` holds.
 * No idle filtering, no gating — a plain partition, so callers can segment by
 * window lifecycle (`isResetBoundary`) or by fit (`isFitBoundary`).
 */
export function splitSeries(
	points: PredictionPoint[],
	predicate: (prev: PredictionPoint, cur: PredictionPoint) => boolean,
): PredictionPoint[][] {
	if (points.length === 0) return [];
	const out: PredictionPoint[][] = [];
	let current: PredictionPoint[] = [points[0]];
	for (let i = 1; i < points.length; i++) {
		if (predicate(points[i - 1], points[i])) {
			out.push(current);
			current = [points[i]];
		} else {
			current.push(points[i]);
		}
	}
	out.push(current);
	return out;
}

/**
 * Pure least-squares usage-window exhaustion predictor.
 *
 * Ported/adapted from robsonek's upstream PR tombii/better-ccflare#294. Unlike
 * the legacy single-snapshot burn-rate (which averages in idle time), this fits
 * a regression over the *recent* snapshot segment, with reset/refund
 * segmentation, idle filtering, ±jitter tolerance on `resetsAt`, and confidence
 * gating. It is provider-agnostic: callers pass a normalized
 * `PredictionPoint[]` (epoch-ms `t`, 0-100 `utilization`, nullable `resetsAt`)
 * regardless of the underlying provider or window.
 */
export function computeUsagePrediction(
	points: PredictionPoint[],
): UsagePrediction {
	const sorted = [...points].sort((a, b) => a.t - b.t);
	const latest = sorted.length ? sorted[sorted.length - 1] : null;
	const resetsAtMs = latest ? latest.resetsAt : null;
	const base = {
		slopePerHour: 0,
		etaExhaustMs: null as number | null,
		predictedAtReset: null as number | null,
		resetsAtMs,
		willExhaustBeforeReset: false,
		lowConfidence: false,
	};
	// Already at/over the cap (overage). No forward extrapolation.
	if (latest && latest.utilization >= LIMIT) {
		return {
			...base,
			etaExhaustMs: latest.t,
			predictedAtReset: LIMIT,
			willExhaustBeforeReset: true,
			state: "exhausted",
		};
	}
	// When a current-period reset is known, idle readings (resets_at == null) are
	// NOT part of the active window — including them flattens the slope ~10x.
	let pts = sorted;
	if (resetsAtMs != null) {
		const active = sorted.filter((p) => p.resetsAt != null);
		if (active.length >= 2) pts = active;
	}
	// Segment to the current window: cut at the last boundary — a resets_at change
	// beyond jitter tolerance OR a drop of at least REVISION_MIN_DROP_PCT.
	let segStart = 0;
	for (let i = 1; i < pts.length; i++) {
		if (isFitBoundary(pts[i - 1], pts[i])) segStart = i;
	}
	const segment = pts.slice(segStart);
	if (segment.length < MIN_POINTS)
		return { ...base, state: "insufficient_data" };
	const first = segment[0];
	const last = segment[segment.length - 1];
	const currentUsage = last.utilization;
	const lowConfidence = last.t - first.t < MIN_SPAN_MS;
	// Least-squares on centered, hour-scaled time: utilization = a*x + b, x = (t - first.t)/HOUR_MS.
	const n = segment.length;
	let sumX = 0;
	let sumU = 0;
	let sumXX = 0;
	let sumXU = 0;
	for (const p of segment) {
		const x = (p.t - first.t) / HOUR_MS;
		sumX += x;
		sumU += p.utilization;
		sumXX += x * x;
		sumXU += x * p.utilization;
	}
	const denom = n * sumXX - sumX * sumX;
	const a = denom === 0 ? 0 : (n * sumXU - sumX * sumU) / denom; // per hour
	const slopePerHour = a;
	const hoursToReset =
		resetsAtMs != null ? Math.max(0, (resetsAtMs - last.t) / HOUR_MS) : null;
	const rawAtReset =
		hoursToReset != null ? currentUsage + a * hoursToReset : null;
	const clamp = (v: number, lo: number, hi: number) =>
		Math.max(lo, Math.min(hi, v));
	const predictedAtReset =
		!lowConfidence && rawAtReset != null ? clamp(rawAtReset, 0, LIMIT) : null;
	const willExhaustBeforeReset =
		!lowConfidence && rawAtReset != null && rawAtReset >= LIMIT;
	if (a <= 0) {
		return {
			...base,
			slopePerHour,
			predictedAtReset,
			willExhaustBeforeReset,
			lowConfidence,
			state: "stable",
		};
	}
	const etaExhaustMs = lowConfidence
		? null
		: Math.round(last.t + ((LIMIT - currentUsage) / a) * HOUR_MS);
	return {
		...base,
		slopePerHour,
		etaExhaustMs,
		predictedAtReset,
		willExhaustBeforeReset,
		lowConfidence,
		state: "rising",
	};
}
