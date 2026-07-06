import { describe, expect, test } from "bun:test";
import type { UsageSnapshotSample } from "@clankermux/types";
import {
	type AccountPredictionInput,
	buildAccountUsagePredictions,
} from "./build-account-predictions";
import { computeUsagePrediction } from "./usage-prediction";

const HOUR_MS = 3_600_000;
const NOW = 1_700_000_000_000;
// A reset instant far enough in the future that no window is "at reset".
const RESET = NOW + 3 * HOUR_MS;

function sample(
	over: Partial<UsageSnapshotSample> & {
		accountId: string;
		sampledAt: number;
	},
): UsageSnapshotSample {
	return {
		provider: "anthropic",
		fiveHourPct: null,
		fiveHourReset: null,
		sevenDayPct: null,
		sevenDayReset: null,
		...over,
	};
}

describe("buildAccountUsagePredictions", () => {
	test("rising 5h history + live point that bends the trend", () => {
		const accountId = "acc-rising";
		// Linear rising history over ~3h (well past MIN_SPAN so not lowConfidence).
		const samples: UsageSnapshotSample[] = [
			sample({
				accountId,
				sampledAt: NOW - 3 * HOUR_MS,
				fiveHourPct: 10,
				fiveHourReset: RESET,
			}),
			sample({
				accountId,
				sampledAt: NOW - 2 * HOUR_MS,
				fiveHourPct: 20,
				fiveHourReset: RESET,
			}),
			sample({
				accountId,
				sampledAt: NOW - 1 * HOUR_MS,
				fiveHourPct: 30,
				fiveHourReset: RESET,
			}),
		];
		const inputs: AccountPredictionInput[] = [
			{
				accountId,
				// Off the extrapolated line (history slope 10 => would be 40 at NOW):
				// 60 bends the slope up and pulls the ETA in.
				fiveHour: { utilization: 60, resetsAtMs: RESET },
				sevenDay: null,
			},
		];

		const result = buildAccountUsagePredictions(inputs, samples, NOW);
		const pred = result.get(accountId);
		expect(pred).toBeDefined();
		expect(pred?.fiveHour).toBeDefined();
		expect(pred?.fiveHour?.state).toBe("rising");

		// The live point must actually influence the fit: compare to history-only.
		const historyOnly = computeUsagePrediction([
			{ t: NOW - 3 * HOUR_MS, utilization: 10, resetsAt: RESET },
			{ t: NOW - 2 * HOUR_MS, utilization: 20, resetsAt: RESET },
			{ t: NOW - 1 * HOUR_MS, utilization: 30, resetsAt: RESET },
		]);
		expect(pred?.fiveHour?.slopePerHour).toBeGreaterThan(
			historyOnly.slopePerHour,
		);
		// Steeper slope + higher current usage => sooner exhaustion than history-only.
		expect(historyOnly.etaExhaustMs).not.toBeNull();
		expect(pred?.fiveHour?.etaExhaustMs).not.toBeNull();
		expect(pred?.fiveHour?.etaExhaustMs).toBeLessThan(
			historyOnly.etaExhaustMs as number,
		);
	});

	test("5h lookback: samples older than 6h are excluded, only recent feed the fit", () => {
		const accountId = "acc-lookback";
		const recent = [
			{ sampledAt: NOW - 3 * HOUR_MS, pct: 10 },
			{ sampledAt: NOW - 2 * HOUR_MS, pct: 20 },
			{ sampledAt: NOW - 1 * HOUR_MS, pct: 30 },
		];
		const old = [
			{ sampledAt: NOW - 8 * HOUR_MS, pct: 90 },
			{ sampledAt: NOW - 7 * HOUR_MS, pct: 95 },
		];
		const samples: UsageSnapshotSample[] = [...old, ...recent].map((s) =>
			sample({
				accountId,
				sampledAt: s.sampledAt,
				fiveHourPct: s.pct,
				fiveHourReset: RESET,
			}),
		);
		const inputs: AccountPredictionInput[] = [
			{ accountId, fiveHour: null, sevenDay: null },
		];

		const result = buildAccountUsagePredictions(inputs, samples, NOW);
		const pred = result.get(accountId);
		// Expected uses ONLY the within-6h recent points.
		const expected = computeUsagePrediction(
			recent.map((s) => ({
				t: s.sampledAt,
				utilization: s.pct,
				resetsAt: RESET,
			})),
		);
		expect(pred?.fiveHour).toEqual(expected);
	});

	test("7d uses the 24h window: a ~20h-old sample feeds 7d but not 5h", () => {
		const accountId = "acc-windows";
		const samples: UsageSnapshotSample[] = [
			sample({
				accountId,
				sampledAt: NOW - 20 * HOUR_MS,
				fiveHourPct: 42,
				fiveHourReset: RESET,
				sevenDayPct: 42,
				sevenDayReset: RESET,
			}),
		];
		const inputs: AccountPredictionInput[] = [
			{ accountId, fiveHour: null, sevenDay: null },
		];

		const result = buildAccountUsagePredictions(inputs, samples, NOW);
		const pred = result.get(accountId);
		expect(pred).toBeDefined();
		// 20h > 6h => excluded from 5h => no points => window omitted.
		expect(pred?.fiveHour).toBeUndefined();
		// 20h < 24h => included in 7d => present (single point => insufficient_data).
		expect(pred?.sevenDay).toBeDefined();
		expect(pred?.sevenDay?.state).toBe("insufficient_data");
	});

	test("live-point injection with no history => single point => insufficient_data (present, not omitted)", () => {
		const accountId = "acc-live-only";
		const inputs: AccountPredictionInput[] = [
			{
				accountId,
				fiveHour: { utilization: 25, resetsAtMs: RESET },
				sevenDay: null,
			},
		];

		const result = buildAccountUsagePredictions(inputs, [], NOW);
		const pred = result.get(accountId);
		expect(pred).toBeDefined();
		expect(pred?.fiveHour).toBeDefined();
		expect(pred?.fiveHour?.state).toBe("insufficient_data");
		expect(pred?.sevenDay).toBeUndefined();
	});

	test("no data at all => account absent from the Map", () => {
		const accountId = "acc-empty";
		const inputs: AccountPredictionInput[] = [
			{ accountId, fiveHour: null, sevenDay: null },
		];

		const result = buildAccountUsagePredictions(inputs, [], NOW);
		expect(result.has(accountId)).toBe(false);
	});

	test("grouping: each account gets only its own points", () => {
		const a = "acc-a";
		const b = "acc-b";
		const aSamples = [
			{ sampledAt: NOW - 3 * HOUR_MS, pct: 10 },
			{ sampledAt: NOW - 2 * HOUR_MS, pct: 20 },
			{ sampledAt: NOW - 1 * HOUR_MS, pct: 30 },
		];
		const bSamples = [
			{ sampledAt: NOW - 3 * HOUR_MS, pct: 80 },
			{ sampledAt: NOW - 2 * HOUR_MS, pct: 80 },
			{ sampledAt: NOW - 1 * HOUR_MS, pct: 80 },
		];
		const samples: UsageSnapshotSample[] = [
			...aSamples.map((s) =>
				sample({
					accountId: a,
					sampledAt: s.sampledAt,
					fiveHourPct: s.pct,
					fiveHourReset: RESET,
				}),
			),
			...bSamples.map((s) =>
				sample({
					accountId: b,
					sampledAt: s.sampledAt,
					fiveHourPct: s.pct,
					fiveHourReset: RESET,
				}),
			),
		];
		const inputs: AccountPredictionInput[] = [
			{ accountId: a, fiveHour: null, sevenDay: null },
			{ accountId: b, fiveHour: null, sevenDay: null },
		];

		const result = buildAccountUsagePredictions(inputs, samples, NOW);
		const expectedA = computeUsagePrediction(
			aSamples.map((s) => ({
				t: s.sampledAt,
				utilization: s.pct,
				resetsAt: RESET,
			})),
		);
		const expectedB = computeUsagePrediction(
			bSamples.map((s) => ({
				t: s.sampledAt,
				utilization: s.pct,
				resetsAt: RESET,
			})),
		);
		expect(result.get(a)?.fiveHour).toEqual(expectedA);
		expect(result.get(b)?.fiveHour).toEqual(expectedB);
		// Sanity: A is rising, B is flat/stable — proving no cross-contamination.
		expect(result.get(a)?.fiveHour?.state).toBe("rising");
		expect(result.get(b)?.fiveHour?.state).toBe("stable");
	});

	test("null live utilization with history present => live point NOT appended", () => {
		const accountId = "acc-null-live";
		const hist = [
			{ sampledAt: NOW - 3 * HOUR_MS, pct: 10 },
			{ sampledAt: NOW - 2 * HOUR_MS, pct: 20 },
			{ sampledAt: NOW - 1 * HOUR_MS, pct: 30 },
		];
		const samples: UsageSnapshotSample[] = hist.map((s) =>
			sample({
				accountId,
				sampledAt: s.sampledAt,
				fiveHourPct: s.pct,
				fiveHourReset: RESET,
			}),
		);
		const inputs: AccountPredictionInput[] = [
			{
				accountId,
				// utilization null => the live point must not be appended.
				fiveHour: { utilization: null, resetsAtMs: RESET },
				sevenDay: null,
			},
		];

		const result = buildAccountUsagePredictions(inputs, samples, NOW);
		const expected = computeUsagePrediction(
			hist.map((s) => ({
				t: s.sampledAt,
				utilization: s.pct,
				resetsAt: RESET,
			})),
		);
		expect(result.get(accountId)?.fiveHour).toEqual(expected);
	});
});
