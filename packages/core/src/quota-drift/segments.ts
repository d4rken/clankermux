import type { QuotaSegment, QuotaWindowKind } from "./types";

/**
 * Turning one account's ordered usage samples into fittable segments.
 *
 * This is the ONE segment implementation. The precompute path calls it rather
 * than re-deriving run/bucket logic in SQL: a second implementation would leave
 * the exhaustively tested one non-authoritative and drift on reset, gap, null
 * and bucket-edge behaviour, all of which are silent failures.
 *
 * ## Why runs exist
 *
 * `Δpct = Σ w·tokens` only holds while the reported percentage is purely
 * accumulating. Measured on the live database, `five_hour_reset` is a FIXED
 * wall-clock boundary (e.g. 14:00:00) that jitters by about a second between
 * consecutive samples, so the 5h window is a fixed bucket rather than a rolling
 * one: usage does not age out mid-run, and a monotone run really is pure
 * accumulation.
 *
 * A run therefore ends at any point where accumulation is broken or unobserved.
 *
 * ## Timestamp caveat (bounded, not eliminated)
 *
 * `requests.timestamp` is stamped when the asynchronous repository save runs,
 * not when the provider accounted the usage; `sampled_at` is the sampler tick
 * rather than the observation time for rows predating the `observed_at` column.
 * Both smear traffic across segment boundaries by a bounded amount. That is
 * why `segments.test.ts` includes a jitter-sensitivity case: perturbing request
 * timestamps by +/-150s must move recovered coefficients by less than the
 * interval width, or the estimate is an artefact of the clock.
 */

/** One stored sample of one window for one account. */
export interface WindowSample {
	accountId: string;
	/** Sample time, ms since epoch. */
	sampledAt: number;
	/** Reported utilization, or null when the provider reported nothing. */
	pct: number | null;
	/** Window reset time, ms since epoch, or null when unknown. */
	resetAt: number | null;
}

/**
 * Tolerance on a reset-time move before it counts as a real window rollover.
 *
 * Measured on the live database: a naive `resetAt !== prevResetAt` test fires on
 * 117,338 of 126,544 samples, because the reported boundary jitters by about a
 * second between consecutive readings. 60s turns a useless signal into a usable
 * one while still catching a genuine rollover.
 */
export const RESET_MOVE_TOLERANCE_MS = 60_000;

/**
 * Longest gap between consecutive samples that still counts as continuous
 * observation. The sampler writes nothing when its cache is stale, so a longer
 * gap is a real blind spot: usage may have accumulated across it with no
 * matching request evidence, and treating it as one segment would attribute
 * that Δpct to whatever traffic happens to sit at its edges.
 */
export const MAX_SAMPLE_GAP_MS = 15 * 60_000;

/** Anchor bucket width per window kind. */
const BUCKET_MS_BY_WINDOW: Record<QuotaWindowKind, number> = {
	// A 5h window quantized to 1pp yields ~1 point per 3 minutes at full burn;
	// 1h anchors keep enough Δ per segment to be above the quantization floor
	// without collapsing the window into a handful of observations.
	five_hour: 60 * 60_000,
	// The weekly window moves ~20x slower, so it needs a proportionally wider
	// bucket to clear the same quantization floor.
	seven_day: 6 * 60 * 60_000,
};

export interface BuildSegmentsOptions {
	window: QuotaWindowKind;
	/** Override the anchor bucket width (tests). */
	bucketMs?: number;
	/** Override the reset-move tolerance (tests). */
	resetToleranceMs?: number;
	/** Override the maximum continuous-observation gap (tests). */
	maxGapMs?: number;
	/**
	 * Resolve the eq-tokens charged in `[t0, t1)`, keyed by normalized model.
	 * Supplied by the caller because the token side comes from a different table
	 * (and, in production, a different query) than the percentage side.
	 */
	tokensFor: (
		accountId: string,
		t0: number,
		t1: number,
	) => Readonly<Record<string, number>>;
	/** Prefix for generated run ids, so ids stay unique across windows. */
	runIdPrefix?: string;
}

/** A maximal stretch of samples over which the percentage purely accumulates. */
export interface SampleRun {
	runId: string;
	accountId: string;
	samples: WindowSample[];
}

/**
 * Split one account's ordered samples into monotone runs.
 *
 * A new run starts when any of these holds:
 *  - there is no previous sample;
 *  - `pct < prevPct` — the window rolled over or the provider revised downward;
 *  - `pct` is null — absence of evidence is NEVER a flat line, so it must split
 *    rather than bridge two readings that may be hours apart in meaning;
 *  - the reset time moved by more than the tolerance — a real rollover. This
 *    catches the case a pct-decrease test alone misses: a window whose
 *    post-reset usage already equals or exceeds the prior integer percentage;
 *  - the sample gap exceeds `maxGapMs` — unobserved accumulation.
 *
 * Samples must be ordered by `sampledAt`; the caller reads them that way.
 */
export function splitRuns(
	samples: readonly WindowSample[],
	opts: {
		resetToleranceMs?: number;
		maxGapMs?: number;
		runIdPrefix?: string;
	} = {},
): SampleRun[] {
	const resetTolerance = opts.resetToleranceMs ?? RESET_MOVE_TOLERANCE_MS;
	const maxGap = opts.maxGapMs ?? MAX_SAMPLE_GAP_MS;
	const prefix = opts.runIdPrefix ?? "run";

	const runs: SampleRun[] = [];
	let current: SampleRun | null = null;
	let prev: WindowSample | null = null;
	let runSeq = 0;

	for (const sample of samples) {
		const breaks =
			prev === null ||
			sample.pct === null ||
			prev.pct === null ||
			sample.accountId !== prev.accountId ||
			sample.pct < prev.pct ||
			sample.sampledAt - prev.sampledAt > maxGap ||
			resetMoved(prev.resetAt, sample.resetAt, resetTolerance);

		if (sample.pct === null) {
			// A null cannot anchor anything, so it closes the run and joins none.
			current = null;
			prev = sample;
			continue;
		}

		if (breaks || current === null) {
			runSeq += 1;
			current = {
				runId: `${prefix}:${sample.accountId}:${runSeq}`,
				accountId: sample.accountId,
				samples: [],
			};
			runs.push(current);
		}
		current.samples.push(sample);
		prev = sample;
	}

	return runs.filter((run) => run.samples.length >= 2);
}

/**
 * True when the reset time moved far enough to be a real rollover rather than
 * the measured ~1s jitter. A null on either side is not evidence of a move: the
 * window may simply not have been reported, and splitting on that would shred
 * every run on a provider that omits the field.
 */
function resetMoved(
	prevReset: number | null,
	reset: number | null,
	toleranceMs: number,
): boolean {
	if (prevReset === null || reset === null) return false;
	return Math.abs(reset - prevReset) > toleranceMs;
}

/**
 * Build fittable segments from one account's ordered samples for one window.
 *
 * Within each run, the FIRST snapshot of every wall-clock bucket is an anchor,
 * and segment *i* spans anchor *i* to anchor *i+1*. The final partial segment
 * ends at the run's last snapshot.
 *
 * The anchors TILE the run with no gaps, and that is not a stylistic choice.
 * Defining a segment as min..max *within* a bucket strands the couple of
 * minutes between one bucket's last snapshot and the next bucket's first: those
 * tokens are dropped while their Δpct is kept by the following segment, which
 * inflates every coefficient by roughly 3% at a 1h bucket. Tiling makes that
 * impossible by construction.
 *
 * Segments are dropped ONLY when they are empty in time (`t1 === t0`). In
 * particular there is no filter on `dpct`: dropping low-Δ segments is selection
 * on the dependent variable and biases the fit upward, and `dpct === 0`
 * segments are informative — they bound the cost of everything that ran in them
 * from above.
 */
export function buildSegments(
	samples: readonly WindowSample[],
	opts: BuildSegmentsOptions,
): QuotaSegment[] {
	const bucketMs = opts.bucketMs ?? BUCKET_MS_BY_WINDOW[opts.window];
	const runs = splitRuns(samples, {
		resetToleranceMs: opts.resetToleranceMs,
		maxGapMs: opts.maxGapMs,
		runIdPrefix: opts.runIdPrefix ?? opts.window,
	});

	const segments: QuotaSegment[] = [];
	for (const run of runs) {
		const anchors = pickAnchors(run.samples, bucketMs);
		for (let i = 0; i + 1 < anchors.length; i++) {
			const a = anchors[i];
			const b = anchors[i + 1];
			if (b.sampledAt === a.sampledAt) continue;
			// pct nullity was already excluded when the run was formed.
			const dpct = (b.pct as number) - (a.pct as number);
			segments.push({
				runId: run.runId,
				accountId: run.accountId,
				t0: a.sampledAt,
				t1: b.sampledAt,
				dpct,
				eqTokensByModel: opts.tokensFor(
					run.accountId,
					a.sampledAt,
					b.sampledAt,
				),
			});
		}
	}
	return segments;
}

/**
 * The first sample of each bucket, plus the run's last sample so the final
 * partial segment is closed. The trailing sample is skipped when it is already
 * the last anchor.
 */
function pickAnchors(
	samples: readonly WindowSample[],
	bucketMs: number,
): WindowSample[] {
	const anchors: WindowSample[] = [];
	let lastBucket: number | null = null;
	for (const sample of samples) {
		const bucket = Math.floor(sample.sampledAt / bucketMs);
		if (lastBucket === null || bucket !== lastBucket) {
			anchors.push(sample);
			lastBucket = bucket;
		}
	}
	const last = samples[samples.length - 1];
	if (
		anchors.length > 0 &&
		anchors[anchors.length - 1].sampledAt !== last.sampledAt
	) {
		anchors.push(last);
	}
	return anchors;
}

/** Anchor bucket width used for a window kind (exposed for the compute path). */
export function bucketMsForWindow(window: QuotaWindowKind): number {
	return BUCKET_MS_BY_WINDOW[window];
}
