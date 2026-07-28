import type { PredictionPoint, UsagePrediction } from "@clankermux/types";

const HOUR_MS = 3_600_000;
const MIN_POINTS = 3;
const MIN_SPAN_MS = 5 * 60 * 1000;
const RESET_DROP_THRESHOLD = 5;
const RESET_JITTER_TOLERANCE_MS = 60_000;
const LIMIT = 100;

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
	// beyond jitter tolerance OR a drop larger than RESET_DROP_THRESHOLD.
	let segStart = 0;
	for (let i = 1; i < pts.length; i++) {
		const prev = pts[i - 1];
		const cur = pts[i];
		const prevReset = prev.resetsAt ?? null;
		const curReset = cur.resetsAt ?? null;
		let resetChanged: boolean;
		if (prevReset == null && curReset == null) resetChanged = false;
		else if (prevReset == null || curReset == null) resetChanged = true;
		else
			resetChanged = Math.abs(curReset - prevReset) > RESET_JITTER_TOLERANCE_MS;
		const dropped = cur.utilization < prev.utilization - RESET_DROP_THRESHOLD;
		if (resetChanged || dropped) segStart = i;
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
