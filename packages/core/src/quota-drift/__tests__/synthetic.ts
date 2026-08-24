import { mulberry32 } from "../fit";
import type { QuotaSegment } from "../types";

/**
 * Synthetic segment generation with KNOWN ground truth.
 *
 * The estimator's correctness cannot be checked against production data — the
 * true coefficients there are exactly what is being estimated. These helpers
 * build segments from weights the test chose, so a recovered number can be
 * compared to the answer.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** How the provider turns a real-valued percentage into the integer it reports. */
export type Quantizer = "round" | "floor" | "none";

export interface SyntheticOptions {
	/** True cost per model, in points per 1M eq-tokens. */
	weights: Readonly<Record<string, number>>;
	/** Number of runs to generate. */
	runs: number;
	/** Segments per run. */
	segmentsPerRun: number;
	/** Segment duration. */
	segmentMs?: number;
	/** Start of the first run. */
	startMs?: number;
	/** Mean eq-tokens per model per segment. */
	meanTokens?: number;
	/** PRNG seed. */
	seed: number;
	/**
	 * Which quantizer the provider is assumed to use. Unknown in reality, so the
	 * coverage test exercises both.
	 */
	quantizer?: Quantizer;
	/** Accounts to spread the runs across. */
	accountIds?: readonly string[];
	/**
	 * Optional weight override applied from `stepAtMs` onward — a planted step
	 * change with a known boundary, direction and magnitude.
	 */
	stepAtMs?: number;
	stepWeights?: Readonly<Record<string, number>>;
	/** Fixed per-segment token ratios, for the collinear case. */
	fixedRatios?: Readonly<Record<string, number>>;
}

/**
 * Generate segments whose `dpct` follows `Σ w·Mtok` exactly, then quantize the
 * CUMULATIVE percentage the way a provider does.
 *
 * Quantizing the cumulative series rather than each Δ is the point: the reported
 * integer is a running total, so the error in consecutive Δs is correlated, and
 * a generator that rounded each Δ independently would make the estimator look
 * better than it is.
 */
export function makeSyntheticSegments(opts: SyntheticOptions): QuotaSegment[] {
	const segmentMs = opts.segmentMs ?? 60 * 60 * 1000;
	const start = opts.startMs ?? 1_760_000_000_000;
	const meanTokens = opts.meanTokens ?? 500_000;
	const quantizer = opts.quantizer ?? "round";
	const accountIds = opts.accountIds ?? ["acct-a"];
	const rand = mulberry32(opts.seed);
	const models = Object.keys(opts.weights);

	const segments: QuotaSegment[] = [];
	let cursor = start;
	for (let r = 0; r < opts.runs; r++) {
		const accountId = accountIds[r % accountIds.length];
		const runId = `syn:${accountId}:${r}`;
		let cumulative = 0;
		let reportedPrev = quantize(0, quantizer);
		for (let k = 0; k < opts.segmentsPerRun; k++) {
			const t0 = cursor;
			const t1 = cursor + segmentMs;
			cursor = t1;

			const tokens: Record<string, number> = {};
			const base = meanTokens * (0.2 + 1.6 * rand());
			for (const model of models) {
				tokens[model] = opts.fixedRatios
					? base * (opts.fixedRatios[model] ?? 1)
					: meanTokens * (0.2 + 1.6 * rand());
			}

			const activeWeights =
				opts.stepAtMs != null && opts.stepWeights && t0 >= opts.stepAtMs
					? opts.stepWeights
					: opts.weights;

			let exact = 0;
			for (const model of models) {
				exact += ((activeWeights[model] ?? 0) * tokens[model]) / 1e6;
			}
			cumulative += exact;
			const reported = quantize(cumulative, quantizer);
			segments.push({
				runId,
				accountId,
				t0,
				t1,
				dpct: reported - reportedPrev,
				eqTokensByModel: tokens,
			});
			reportedPrev = reported;
		}
		// Gap between runs, so a caller re-deriving runs would split here too.
		cursor += segmentMs;
	}
	return segments;
}

function quantize(value: number, kind: Quantizer): number {
	if (kind === "round") return Math.round(value);
	if (kind === "floor") return Math.floor(value);
	return value;
}
