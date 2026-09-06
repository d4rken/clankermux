/**
 * Offline experiment only. Compare the current hour gate with an earlier,
 * observation-based gate. Does not change the production confidence policy.
 *
 * bun scripts/forecast-confidence-backtest.ts DB FROM_ISO SPLIT_ISO TO_ISO
 * The database is read-only; the JSON report goes to stdout.
 */
import { Database } from "bun:sqlite";
import type { PredictionPoint, UsagePrediction } from "@clankermux/types";
import {
	estimateWindowExhaustion,
	isLearningEstimate,
} from "../packages/core/src/capacity-runway";
import {
	deriveOutcome,
	scoreRecords,
	type BacktestRecord,
} from "../packages/core/src/prediction-backtest";
import {
	computeUsagePrediction,
	isFitBoundary,
	isResetBoundary,
	isRevisionDrop,
	splitSeries,
} from "../packages/core/src/usage-prediction";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface ObservedPoint extends PredictionPoint {
	/** Provider observation time, not the sampler's repeated cache-write tick. */
	observedAt: number | null;
}

/** Fixed candidate: six distinct observations, 15 minutes, 5pp growth, stable slope. */
export function earlyEvidencePrediction(
	rows: ObservedPoint[],
	now: number,
): UsagePrediction | null {
	const distinct = new Map<number, PredictionPoint>();
	for (const row of rows) {
		if (
			row.t > now ||
			row.observedAt == null ||
			row.observedAt > row.t ||
			row.observedAt < now - 6 * HOUR
		)
			continue;
		if (!distinct.has(row.observedAt))
			distinct.set(row.observedAt, {
				t: row.observedAt,
				utilization: row.utilization,
				resetsAt: row.resetsAt,
			});
	}
	const sorted = [...distinct.values()].sort((a, b) => a.t - b.t);
	const segment = splitSeries(sorted, isFitBoundary).at(-1) ?? [];
	if (segment.length < 6) return null;
	const first = segment[0];
	const last = segment[segment.length - 1];
	if (
		now - last.t > 10 * MINUTE ||
		last.t - first.t < 15 * MINUTE ||
		last.utilization - first.utilization < 5
	)
		return null;
	const prediction = computeUsagePrediction(segment);
	const midpoint = (first.t + last.t) / 2;
	const recent = computeUsagePrediction(
		segment.filter((point) => point.t >= midpoint),
	);
	if (
		prediction.state !== "rising" ||
		prediction.lowConfidence ||
		recent.state !== "rising" ||
		recent.lowConfidence
	)
		return null;
	if (Math.abs(recent.slopePerHour / prediction.slopePerHour - 1) > 0.25)
		return null;
	return prediction;
}

interface Row {
	account_id: string;
	sampled_at: number;
	observed_at: number | null;
	five_hour_pct: number;
	five_hour_reset: number | null;
}

export function replayConfidence(rows: Row[], from: number, to: number) {
	const accounts = new Map<string, ObservedPoint[]>();
	for (const row of rows) {
		const list = accounts.get(row.account_id) ?? [];
		list.push({
			t: row.sampled_at,
			observedAt: row.observed_at,
			utilization: row.five_hour_pct,
			resetsAt: row.five_hour_reset,
		});
		accounts.set(row.account_id, list);
	}
	const baseline: BacktestRecord[] = [];
	const candidate: BacktestRecord[] = [];
	const early: BacktestRecord[] = [];
	for (const [accountId, points] of accounts) {
		const windows = splitSeries(points, isResetBoundary);
		for (let index = 0; index < windows.length; index++) {
			const window = windows[index];
			const finalReset = window.at(-1)?.resetsAt ?? null;
			let lastScored = -Infinity;
			for (let i = 0; i < window.length; i++) {
				const point = window[i] as ObservedPoint;
				if (
					point.t < from ||
					point.t >= to ||
					point.t - lastScored < 10 * MINUTE ||
					point.utilization >= 100
				)
					continue;
				lastScored = point.t;
				const outcome = deriveOutcome(
					window,
					point.t,
					finalReset,
					windows[index + 1]?.[0].t ?? null,
				);
				// A completed outcome must belong wholly to this partition.
				const outcomeEnd =
					outcome.kind === "exhausted" ? outcome.atMs : finalReset;
				if (outcomeEnd == null || outcomeEnd >= to) continue;
				const history = window
					.slice(0, i + 1)
					.filter((p) => p.t >= point.t - 6 * HOUR) as ObservedPoint[];
				const prediction = computeUsagePrediction([
					...history,
					{ ...point, t: point.t },
				]);
				let anchor = null;
				for (let j = 1; j <= i; j++) {
					const previous = window[j - 1];
					const revised = window[j] as ObservedPoint;
					if (
						isRevisionDrop(previous.utilization, revised.utilization) &&
						revised.observedAt != null &&
						revised.resetsAt != null
					) {
						anchor = {
							anchorMs: revised.observedAt,
							anchorPct: revised.utilization,
							windowResetMs: revised.resetsAt,
						};
					}
				}
				const estimate = estimateWindowExhaustion(
					{
						anchor,
						utilizationPct: point.utilization,
						resetsAtMs: point.resetsAt,
						windowStartMs:
							point.resetsAt == null ? null : point.resetsAt - 5 * HOUR,
						prediction,
						observedAtMs: point.observedAt,
					},
					point.t,
				);
				const usable =
					estimate.source !== "none" &&
					!isLearningEstimate(estimate, point.utilization);
				const record: BacktestRecord = {
					T: point.t,
					windowKind: "five_hour",
					accountId,
					provider: "anthropic",
					usable,
					unusableReason: usable ? null : "low_confidence",
					predictsExhaust:
						estimate.exhaustsAtMs != null &&
						point.resetsAt != null &&
						estimate.exhaustsAtMs < point.resetsAt,
					predictedEtaMs: estimate.exhaustsAtMs,
					outcome,
					knownResetAtMs: point.resetsAt,
					labelResetAtMs: finalReset,
					windowMs: 5 * HOUR,
				};
				baseline.push(record);
				const alternative =
					!usable && estimate.source !== "none" && point.utilization > 0
						? earlyEvidencePrediction(history, point.t)
						: null;
				const extra = alternative
					? {
							...record,
							usable: true,
							unusableReason: null,
							predictsExhaust: alternative.willExhaustBeforeReset,
							predictedEtaMs: alternative.etaExhaustMs,
						}
					: record;
				candidate.push(extra);
				if (alternative) early.push(extra);
			}
		}
	}
	return {
		baseline: scoreRecords(baseline),
		candidate: scoreRecords(candidate),
		additionalEarly: scoreRecords(early),
		additionalByAccount: [
			...new Set(early.map((record) => record.accountId)),
		].map((accountId) => ({
			accountId,
			metrics: scoreRecords(
				early.filter((record) => record.accountId === accountId),
			),
		})),
	};
}

if (import.meta.main) {
	const [path, fromIso, splitIso, toIso] = process.argv.slice(2);
	const [from, split, to] = [fromIso, splitIso, toIso].map((value) =>
		Date.parse(value),
	);
	if (!path || !Number.isFinite(from) || !(from < split && split < to))
		throw new Error(
			"Usage: forecast-confidence-backtest.ts DB FROM_ISO SPLIT_ISO TO_ISO",
		);
	const db = new Database(path, { readonly: true });
	try {
		const rows = db
			.query<Row, [number, number]>(
				`SELECT account_id, sampled_at, observed_at, five_hour_pct, five_hour_reset FROM usage_snapshots WHERE provider = 'anthropic' AND five_hour_pct IS NOT NULL AND sampled_at >= ? AND sampled_at <= ? ORDER BY account_id, sampled_at`,
			)
			.all(from - 6 * HOUR, to + 6 * HOUR);
		console.log(
			JSON.stringify(
				{
					from: fromIso,
					split: splitIso,
					to: toIso,
					rows: rows.length,
					timedRows: rows.filter((row) => row.observed_at != null).length,
					development: replayConfidence(rows, from, split),
					heldOut: replayConfidence(rows, split, to),
				},
				null,
				2,
			),
		);
	} finally {
		db.close();
	}
}
