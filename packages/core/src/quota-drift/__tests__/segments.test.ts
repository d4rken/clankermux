import { describe, expect, it } from "bun:test";
import { fitOnce, selectKeys } from "../fit";
import {
	buildSegments,
	MAX_SAMPLE_GAP_MS,
	RESET_MOVE_TOLERANCE_MS,
	splitRuns,
	type WindowSample,
} from "../segments";

const T0 = 1_760_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

function sample(
	offsetMs: number,
	pct: number | null,
	resetAt: number | null = T0 + 5 * HOUR,
	accountId = "acct-a",
): WindowSample {
	return { accountId, sampledAt: T0 + offsetMs, pct, resetAt };
}

const NO_TOKENS = () => ({});

describe("splitRuns", () => {
	it("keeps a monotone series with jittering resets as ONE run", () => {
		// +/-1s reset jitter is what the live data actually looks like; a naive
		// inequality test on the reset column fires on nearly every sample.
		const samples = [
			sample(0, 10, T0 + 5 * HOUR),
			sample(2 * MIN, 12, T0 + 5 * HOUR + 1000),
			sample(4 * MIN, 14, T0 + 5 * HOUR - 1000),
			sample(6 * MIN, 15, T0 + 5 * HOUR + 999),
		];

		const runs = splitRuns(samples);

		expect(runs).toHaveLength(1);
		expect(runs[0].samples).toHaveLength(4);
	});

	it("splits on a percentage decrease", () => {
		const runs = splitRuns([
			sample(0, 10),
			sample(2 * MIN, 12),
			sample(4 * MIN, 3),
			sample(6 * MIN, 5),
		]);

		expect(runs).toHaveLength(2);
		expect(runs[0].samples.map((s) => s.pct)).toEqual([10, 12]);
		expect(runs[1].samples.map((s) => s.pct)).toEqual([3, 5]);
	});

	it("splits on a null percentage and never bridges across it", () => {
		const runs = splitRuns([
			sample(0, 10),
			sample(2 * MIN, 12),
			sample(4 * MIN, null),
			sample(6 * MIN, 20),
			sample(8 * MIN, 22),
		]);

		expect(runs).toHaveLength(2);
		expect(runs[0].samples.map((s) => s.pct)).toEqual([10, 12]);
		expect(runs[1].samples.map((s) => s.pct)).toEqual([20, 22]);
	});

	it("splits on a reset move beyond the tolerance even when pct rises", () => {
		// The case a pct-decrease test alone misses: the window rolled over and
		// post-reset usage already exceeds the prior integer percentage.
		const runs = splitRuns([
			sample(0, 10, T0 + 5 * HOUR),
			sample(2 * MIN, 12, T0 + 5 * HOUR),
			sample(4 * MIN, 14, T0 + 10 * HOUR),
			sample(6 * MIN, 16, T0 + 10 * HOUR),
		]);

		expect(runs).toHaveLength(2);
		expect(runs[1].samples[0].pct).toBe(14);
	});

	it("does not split on a reset move at exactly the tolerance", () => {
		const runs = splitRuns([
			sample(0, 10, T0 + 5 * HOUR),
			sample(2 * MIN, 12, T0 + 5 * HOUR + RESET_MOVE_TOLERANCE_MS),
		]);

		expect(runs).toHaveLength(1);
	});

	it("splits on a sample gap longer than the observation limit", () => {
		const runs = splitRuns([
			sample(0, 10),
			sample(2 * MIN, 12),
			sample(2 * MIN + MAX_SAMPLE_GAP_MS + 1, 14),
			sample(2 * MIN + MAX_SAMPLE_GAP_MS + 1 + 2 * MIN, 16),
		]);

		expect(runs).toHaveLength(2);
	});

	it("splits between accounts", () => {
		const runs = splitRuns([
			sample(0, 10, T0 + 5 * HOUR, "acct-a"),
			sample(2 * MIN, 12, T0 + 5 * HOUR, "acct-a"),
			sample(4 * MIN, 30, T0 + 5 * HOUR, "acct-b"),
			sample(6 * MIN, 32, T0 + 5 * HOUR, "acct-b"),
		]);

		expect(runs).toHaveLength(2);
		expect(runs.map((r) => r.accountId)).toEqual(["acct-a", "acct-b"]);
	});

	it("drops a run that cannot produce a segment", () => {
		expect(splitRuns([sample(0, 10)])).toHaveLength(0);
	});
});

describe("buildSegments", () => {
	function everyTwoMinutes(count: number, pctPerStep = 0.5): WindowSample[] {
		return Array.from({ length: count }, (_, i) =>
			sample(i * 2 * MIN, i * pctPerStep),
		);
	}

	it("tiles the run with no gap between consecutive segments", () => {
		// Defining a segment as min..max WITHIN a bucket would strand the ~2min
		// between one bucket's last sample and the next bucket's first: those
		// tokens vanish while their Δpct is kept, inflating every coefficient.
		const samples = everyTwoMinutes(100);

		const segments = buildSegments(samples, {
			window: "five_hour",
			tokensFor: NO_TOKENS,
		});

		expect(segments.length).toBeGreaterThan(2);
		for (let i = 0; i + 1 < segments.length; i++) {
			expect(segments[i].t1).toBe(segments[i + 1].t0);
		}
	});

	it("covers the run end to end, including the final partial bucket", () => {
		const samples = everyTwoMinutes(100);

		const segments = buildSegments(samples, {
			window: "five_hour",
			tokensFor: NO_TOKENS,
		});

		expect(segments[0].t0).toBe(samples[0].sampledAt);
		expect(segments[segments.length - 1].t1).toBe(
			samples[samples.length - 1].sampledAt,
		);
	});

	it("sums Δpct across segments to the run's total movement", () => {
		const samples = everyTwoMinutes(100);
		const segments = buildSegments(samples, {
			window: "five_hour",
			tokensFor: NO_TOKENS,
		});

		const total = segments.reduce((sum, s) => sum + s.dpct, 0);
		const expected =
			(samples[samples.length - 1].pct as number) - (samples[0].pct as number);
		expect(total).toBeCloseTo(expected, 9);
	});

	it("keeps dpct === 0 segments", () => {
		// A flat segment bounds the cost of everything that ran in it from above.
		// Dropping it is selection on the dependent variable.
		const samples = everyTwoMinutes(100, 0);

		const segments = buildSegments(samples, {
			window: "five_hour",
			tokensFor: () => ({ "claude-opus-5": 1_000_000 }),
		});

		expect(segments.length).toBeGreaterThan(0);
		expect(segments.every((s) => s.dpct === 0)).toBe(true);
	});

	it("drops only zero-length segments", () => {
		const samples: WindowSample[] = [
			sample(0, 10),
			sample(0, 10), // duplicate timestamp
			sample(2 * HOUR, 20),
		];

		const segments = buildSegments(samples, {
			window: "five_hour",
			tokensFor: NO_TOKENS,
		});

		expect(segments.every((s) => s.t1 > s.t0)).toBe(true);
	});

	it("uses a wider anchor bucket for the weekly window", () => {
		const samples = Array.from({ length: 200 }, (_, i) =>
			sample(i * 10 * MIN, i * 0.05, T0 + 7 * 24 * HOUR),
		);

		const fiveHour = buildSegments(samples, {
			window: "five_hour",
			tokensFor: NO_TOKENS,
		});
		const sevenDay = buildSegments(samples, {
			window: "seven_day",
			tokensFor: NO_TOKENS,
		});

		expect(fiveHour.length).toBeGreaterThan(sevenDay.length);
	});

	it("asks for tokens over exactly the segment's half-open interval", () => {
		const asked: Array<[number, number]> = [];
		const samples = everyTwoMinutes(100);

		const segments = buildSegments(samples, {
			window: "five_hour",
			tokensFor: (_a, t0, t1) => {
				asked.push([t0, t1]);
				return {};
			},
		});

		expect(asked).toHaveLength(segments.length);
		for (let i = 0; i < segments.length; i++) {
			expect(asked[i]).toEqual([segments[i].t0, segments[i].t1]);
		}
	});
});

describe("timestamp jitter sensitivity", () => {
	/**
	 * `requests.timestamp` is stamped when the asynchronous save runs, not when
	 * the provider accounted the usage, and pre-`observed_at` snapshot rows carry
	 * the tick time rather than the observation time. Both smear traffic across
	 * segment boundaries. If a +/-150s perturbation moved the recovered
	 * coefficient by more than the interval width, the estimate would be an
	 * artefact of the clock rather than a measurement.
	 */
	it("moves the recovered coefficient by less than the interval width under +/-150s jitter", () => {
		const TRUE_W = 2.4; // points per Mtok
		const STEP = 2 * MIN;
		const N = 600;
		// One request every step, 100k eq-tokens each.
		const TOKENS_PER_STEP = 100_000;

		const requests: Array<{ t: number; tokens: number }> = [];
		for (let i = 0; i < N; i++) {
			requests.push({ t: T0 + i * STEP + MIN, tokens: TOKENS_PER_STEP });
		}

		const samples: WindowSample[] = [];
		let pct = 0;
		for (let i = 0; i <= N; i++) {
			samples.push(sample(i * STEP, Math.round(pct), T0 + 100 * HOUR));
			pct += (TRUE_W * TOKENS_PER_STEP) / 1e6;
		}

		function tokensFor(jitterSeed: number) {
			const jittered = requests.map((r, i) => ({
				...r,
				// Deterministic +/-150s perturbation.
				t: r.t + (jitterSeed === 0 ? 0 : ((i * 7919) % 301) - 150) * 1000,
			}));
			return (_a: string, t0: number, t1: number) => {
				let sum = 0;
				for (const r of jittered) if (r.t >= t0 && r.t < t1) sum += r.tokens;
				return { "claude-opus-5": sum };
			};
		}

		const clean = buildSegments(samples, {
			window: "five_hour",
			tokensFor: tokensFor(0),
		});
		const jittered = buildSegments(samples, {
			window: "five_hour",
			tokensFor: tokensFor(1),
		});

		const keys = selectKeys(clean);
		const wClean = fitOnce(clean, keys).coefficients[0];
		const wJitter = fitOnce(jittered, keys).coefficients[0];

		// Both must land near the truth, and the jitter must move the estimate by
		// far less than a plausible interval width (10% of the estimate).
		expect(wClean).toBeCloseTo(TRUE_W, 1);
		expect(Math.abs(wJitter - wClean)).toBeLessThan(0.1 * wClean);
	});
});
