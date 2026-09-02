/**
 * Shaping primitives shared by the two snapshot-history endpoints:
 * `/api/analytics/usage-history` (account-wide 5h/7d windows) and
 * `/api/analytics/usage-scoped-history` (per-model-family weekly windows).
 *
 * Both read the same kind of sparse, irregularly-sampled series and have to
 * answer the same two questions: which buckets exist, and what value an
 * account holds in a bucket it did not report in. Keeping one implementation
 * means a fix to the carry-forward rule cannot land on one chart and miss the
 * other. Pure: no clock access, no repository imports.
 */

/**
 * A window value held across gap buckets. `expiresAt` is the window's reset
 * (or the nominal-length fallback): the value is assumed to still hold until
 * then, and is dropped once a bucket reaches it.
 */
export interface CarriedValue {
	pct: number;
	expiresAt: number;
}

/** One bucket's reading for a single window. */
export interface CarrySample {
	pct: number | null;
	reset: number | null;
}

/**
 * The last reading before the range started, with the time it was actually
 * taken — the nominal expiry counts from THAT instant, never from the range
 * start, or a months-old reading would look fresh at the left edge.
 */
export interface CarryPredecessor extends CarrySample {
	sampledAt: number;
}

/**
 * Advance one window's carry-forward state by one bucket. A fresh sample
 * refreshes the held value (until its own reset, or the nominal window length
 * when the row carries no reset); otherwise the last value is held until a
 * bucket reaches that reset, then dropped.
 */
export function advanceCarry(
	carry: CarriedValue | null,
	pct: number | null | undefined,
	reset: number | null | undefined,
	ts: number,
	nominalMs: number,
): CarriedValue | null {
	if (pct != null) {
		return { pct, expiresAt: reset ?? ts + nominalMs };
	}
	if (carry && ts >= carry.expiresAt) return null;
	return carry;
}

export const ALLOWED_RANGES = ["1h", "6h", "24h", "7d", "30d", "all"] as const;
export type Range = (typeof ALLOWED_RANGES)[number];
export const DEFAULT_RANGE: Range = "7d";

export function normalizeRange(raw: string | null): Range {
	if (raw && (ALLOWED_RANGES as readonly string[]).includes(raw)) {
		return raw as Range;
	}
	return DEFAULT_RANGE;
}

/** Mean of the non-null numbers, or null when there are none. */
export function avgOrNull(values: number[]): number | null {
	if (values.length === 0) return null;
	return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Max of the non-null numbers, or null when there are none. */
export function maxOrNull(values: number[]): number | null {
	if (values.length === 0) return null;
	return Math.max(...values);
}

/**
 * The chart's x-axis: a REGULAR grid of bucket starts, not merely the buckets
 * that happen to contain a row.
 *
 * A grid built from the returned rows alone has two holes. An account whose
 * last sample landed before the range start creates no bucket, so its still-
 * valid value is missing from the entire range; and once every account stops
 * reporting there are no later buckets, so a carried value has nothing to
 * expire on and the line runs to the right edge frozen at its last reading.
 *
 * Runs from the later of the range start and the first evidence (so an
 * unbounded `range=all` does not emit empty buckets back to the epoch) through
 * the bucket containing `nowMs`, inclusive. `firstEvidenceMs` of null means
 * there is no evidence at all: an empty grid, and therefore an empty response.
 */
export function buildBucketGrid(opts: {
	sinceMs: number;
	bucketMs: number;
	nowMs: number;
	firstEvidenceMs: number | null;
}): number[] {
	const { sinceMs, bucketMs, nowMs, firstEvidenceMs } = opts;
	if (!(bucketMs > 0) || firstEvidenceMs === null) return [];
	const start = Math.max(
		Math.floor(sinceMs / bucketMs) * bucketMs,
		Math.floor(firstEvidenceMs / bucketMs) * bucketMs,
	);
	const end = Math.floor(nowMs / bucketMs) * bucketMs;
	if (end < start) return [];
	const grid: number[] = [];
	for (let ts = start; ts <= end; ts += bucketMs) grid.push(ts);
	return grid;
}

/**
 * Walk one account's one window across the grid, carrying its last value
 * forward until that value's window resets.
 *
 * A maxed-out account that stops reporting (paused, exhausted) must not
 * silently fall out of the pool average — dropping the highest account makes
 * the pool *look* healthier the moment it got worse. `predecessor` extends the
 * same rule backwards over the range's left edge.
 *
 * @returns bucket start -> held pct, for the buckets that hold a value.
 */
export function walkCarry(
	grid: number[],
	samples: Map<number, CarrySample>,
	predecessor: CarryPredecessor | null,
	nominalMs: number,
): Map<number, number> {
	let carry: CarriedValue | null = predecessor
		? advanceCarry(
				null,
				predecessor.pct,
				predecessor.reset,
				predecessor.sampledAt,
				nominalMs,
			)
		: null;
	const held = new Map<number, number>();
	for (const ts of grid) {
		const sample = samples.get(ts);
		carry = advanceCarry(carry, sample?.pct, sample?.reset, ts, nominalMs);
		if (carry) held.set(ts, carry.pct);
	}
	return held;
}
