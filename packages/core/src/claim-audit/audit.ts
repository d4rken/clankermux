import type {
	ClaimAuditRange,
	ClaimAuditReport,
	ClaimComposition,
	ClaimLabelCount,
	ClaimObservationInput,
	ClaimSeriesAudit,
	ClaimValueCount,
} from "./types";

/**
 * The standing audit of the request-aligned claim series.
 *
 * ## Why this exists before any fit does
 *
 * Every analysis built on `unified_claim_observations` inherits whatever the
 * series actually is: how coarse the reported utilizations are, how often they
 * are absent, how often they go DOWN without the window having rolled over, and
 * how much of the volume is the proxy's own probe traffic rather than user
 * demand. Those are facts about the data, not about the provider, and a fit
 * cannot tell you any of them — it will happily produce coefficients over a
 * series quantized to whole percent with a third of its readings missing.
 *
 * ## Streaming, and bounded
 *
 * `auditClaimSeries` consumes an ITERABLE and never materializes it: the
 * production caller hands it a SQLite cursor over 90 days of rows. Per-series
 * state is one previous row; per-claim state is a fixed set of counters plus
 * two CAPPED frequency maps. A pathological series cannot turn the audit into a
 * second copy of the table — it truncates and says so.
 *
 * ## Ordering is the caller's contract
 *
 * Rows must arrive ordered by `(observedAt, requestId)`. That ordering is what
 * makes a transition well-defined, and the tie-break matters: two rows sharing
 * a millisecond would otherwise pair differently between two passes over the
 * same data. A row that arrives out of order for its series does not form a
 * transition (see `sortsAfter`) rather than forming a spurious one.
 */

/**
 * How far two resets may differ and still be the same window instance.
 *
 * The reset is reported as whole seconds and the two readings are taken from
 * different responses, so bit-equality is the wrong test — but the tolerance
 * must stay far below any real window length (the shortest is 5 hours), or a
 * genuine rollover would read as the same window and its drop would be counted
 * as the provider giving tokens back.
 */
export const RESET_JITTER_TOLERANCE_MS = 60_000;

/**
 * The drop size that counts as a "gift": a fall of at least 5 utilization
 * points within one window instance.
 *
 * Well above the 1-point quantization of the coarsest observed grid, so no
 * amount of rounding noise reaches it — a drop this size is either a real
 * credit, a reset the reset field failed to signal, or an ordering artefact.
 */
export const GIFT_DROP_THRESHOLD = 0.05;

/**
 * Absolute tolerance for the grid tests.
 *
 * Binary floating point cannot represent `0.07` exactly, so `0.07 * 100` is
 * `7.000000000000001` and an equality test against `Math.round` would report a
 * value that is plainly on the 0.01 grid as off it. Loose enough to absorb the
 * representation error, tight enough that a genuinely off-grid value (the next
 * representable steps are ~1e-3 apart on these grids) cannot pass.
 */
export const GRID_TOLERANCE = 1e-6;

/** How many distinct values / increments one claim may track before truncating. */
export const MAX_TRACKED_VALUES = 2_000;

/** How many of the most frequent values are reported. */
export const TOP_VALUES_K = 10;

/** How many distinct labels one composition axis may track before truncating. */
export const MAX_TRACKED_LABELS = 64;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A frequency map that refuses to grow past a cap, and admits when it did. */
class CappedCounter<K> {
	private readonly counts = new Map<K, number>();
	private overflowed = false;

	constructor(private readonly cap: number) {}

	add(key: K): void {
		const existing = this.counts.get(key);
		if (existing !== undefined) {
			this.counts.set(key, existing + 1);
			return;
		}
		if (this.counts.size >= this.cap) {
			// A new key past the cap is DROPPED, not merged into an "other" bucket:
			// the outputs derived from this map are a distinct-value count and a
			// median, and a synthetic bucket would corrupt both. The flag is what
			// keeps those outputs honest.
			this.overflowed = true;
			return;
		}
		this.counts.set(key, 1);
	}

	get size(): number {
		return this.counts.size;
	}

	get exact(): boolean {
		return !this.overflowed;
	}

	entries(): Array<[K, number]> {
		return [...this.counts];
	}
}

/** Per-(account, claim) state: exactly one row, so the pass stays bounded. */
interface SeriesState {
	previous: ClaimObservationInput | null;
}

/** Per-claim accumulators. */
class ClaimAccumulator {
	rows = 0;
	firstObservedAt: number | null = null;
	lastObservedAt: number | null = null;
	accounts = new Set<string>();
	series = new Set<string>();

	nullUtilizationRows = 0;
	finiteReadings = 0;
	onGrid01 = 0;
	onGrid001 = 0;
	readonly values = new CappedCounter<number>(MAX_TRACKED_VALUES);

	transitions = 0;
	positiveIncrements = 0;
	minPositiveIncrement: number | null = null;
	readonly increments = new CappedCounter<number>(MAX_TRACKED_VALUES);

	stableResetTransitions = 0;
	stableResetNegatives = 0;
	giftDropsOrderingSuspect = 0;
	giftDropsUnexplained = 0;

	readonly bySource = new CappedCounter<string>(MAX_TRACKED_LABELS);
	readonly byStatus = new CappedCounter<string>(MAX_TRACKED_LABELS);
	readonly byHttpStatus = new CappedCounter<number>(MAX_TRACKED_LABELS);
}

/** A finite reading, or null — `0` is a reading and must survive this. */
function finiteUtilization(row: ClaimObservationInput): number | null {
	const value = row.utilization;
	return value !== null && Number.isFinite(value) ? value : null;
}

/** Whether `value` sits on a `1/step` grid within {@link GRID_TOLERANCE}. */
function onGrid(value: number, step: number): boolean {
	const scaled = value * step;
	return Math.abs(scaled - Math.round(scaled)) <= GRID_TOLERANCE;
}

/** Strict `(observedAt, requestId)` ordering — the caller's stated contract. */
function sortsAfter(
	current: ClaimObservationInput,
	previous: ClaimObservationInput,
): boolean {
	if (current.observedAt !== previous.observedAt) {
		return current.observedAt > previous.observedAt;
	}
	return current.requestId > previous.requestId;
}

/**
 * Whether both readings describe the SAME window instance.
 *
 * Requires two non-null resets that agree within the jitter tolerance. Two
 * NULLS deliberately fail: "we do not know when either window resets" is not
 * evidence that they are the same one, and treating it as such is exactly how a
 * missed rollover becomes a phantom credit in the negative-increment counts.
 */
function hasStableReset(
	previous: ClaimObservationInput,
	current: ClaimObservationInput,
): boolean {
	const a = previous.resetAt;
	const b = current.resetAt;
	if (a === null || b === null) return false;
	if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
	return Math.abs(a - b) <= RESET_JITTER_TOLERANCE_MS;
}

/**
 * Whether a drop between these two rows could be an artefact of arrival order.
 *
 * True only when BOTH hold: the requests STARTED in the opposite order to the
 * one they were observed in, and their lifetimes overlapped. Overlap on its own
 * says nothing about which reading is older, and the inversion is what makes the
 * later-observed row a candidate for carrying the EARLIER reading — enough to
 * disqualify the drop between them as evidence of anything.
 *
 * On well-formed rows (`requestStartedAt <= observedAt`) an inversion already
 * implies overlap, so the second term reads as redundant. It is not: the only
 * pairs it rejects are ones whose own timestamps are impossible, and a row that
 * claims to have started after its headers arrived must not buy its drop an
 * excuse.
 */
function isOrderingSuspect(
	previous: ClaimObservationInput,
	current: ClaimObservationInput,
): boolean {
	const inverted = current.requestStartedAt < previous.requestStartedAt;
	if (!inverted) return false;
	return (
		previous.requestStartedAt <= current.observedAt &&
		current.requestStartedAt <= previous.observedAt
	);
}

/** The most frequent values, most frequent first; ties broken by value. */
function topValues(counter: CappedCounter<number>): ClaimValueCount[] {
	return counter
		.entries()
		.sort((a, b) => b[1] - a[1] || a[0] - b[0])
		.slice(0, TOP_VALUES_K)
		.map(([value, count]) => ({ value, count }));
}

/** Label counts, most frequent first; ties broken by label for determinism. */
function labelCounts(counter: CappedCounter<string>): ClaimLabelCount[] {
	return counter
		.entries()
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([label, count]) => ({ label, count }));
}

/** Numeric label counts (HTTP status), rendered as strings for the wire. */
function numericLabelCounts(counter: CappedCounter<number>): ClaimLabelCount[] {
	return counter
		.entries()
		.sort((a, b) => b[1] - a[1] || a[0] - b[0])
		.map(([label, count]) => ({ label: String(label), count }));
}

/**
 * Median of a counted distribution, or null when it is empty OR truncated.
 *
 * Truncation is not a rounding problem: a capped tracker has dropped an unknown
 * slice of the distribution, and the median of what survived is not an estimate
 * of the median of the whole — it is a different number with no error bar. Null
 * says so.
 */
function medianOf(counter: CappedCounter<number>): number | null {
	if (!counter.exact) return null;
	const entries = counter.entries().sort((a, b) => a[0] - b[0]);
	let total = 0;
	for (const [, count] of entries) total += count;
	if (total === 0) return null;
	// Lower median for an even count — a mean of the two middles would invent a
	// value the series never contained, which is the wrong answer for a
	// quantized quantity.
	const target = Math.floor((total - 1) / 2);
	let seen = 0;
	for (const [value, count] of entries) {
		seen += count;
		if (seen > target) return value;
	}
	return null;
}

/** `numerator / denominator`, or null when there is no denominator. */
function share(numerator: number, denominator: number): number | null {
	return denominator > 0 ? numerator / denominator : null;
}

/**
 * Audit a claim-observation series.
 *
 * `rows` must be ordered by `(observedAt, requestId)`; see the module docs.
 * Consumed lazily, so a cursor over the full retention window never lands in
 * memory.
 */
export function auditClaimSeries(
	rows: Iterable<ClaimObservationInput>,
	range: ClaimAuditRange,
): ClaimAuditReport {
	const claims = new Map<string, ClaimAccumulator>();
	const seriesStates = new Map<string, SeriesState>();

	for (const row of rows) {
		let claim = claims.get(row.claim);
		if (!claim) {
			claim = new ClaimAccumulator();
			claims.set(row.claim, claim);
		}
		const seriesKey = `${row.accountId} ${row.claim}`;

		claim.rows++;
		claim.accounts.add(row.accountId);
		claim.series.add(seriesKey);
		if (
			claim.firstObservedAt === null ||
			row.observedAt < claim.firstObservedAt
		) {
			claim.firstObservedAt = row.observedAt;
		}
		if (
			claim.lastObservedAt === null ||
			row.observedAt > claim.lastObservedAt
		) {
			claim.lastObservedAt = row.observedAt;
		}
		claim.bySource.add(row.source);
		claim.byStatus.add(row.status);
		claim.byHttpStatus.add(row.httpStatus);

		const value = finiteUtilization(row);
		if (value === null) {
			claim.nullUtilizationRows++;
			// A row with no reading does NOT break the series: the next finite
			// reading is compared against the last finite one. Ending the series
			// here would silently discard a transition across a single dropped
			// header, which is one of the things the audit is meant to count.
			continue;
		}

		claim.finiteReadings++;
		claim.values.add(value);
		if (onGrid(value, 100)) claim.onGrid01++;
		if (onGrid(value, 1_000)) claim.onGrid001++;

		let state = seriesStates.get(seriesKey);
		if (!state) {
			state = { previous: null };
			seriesStates.set(seriesKey, state);
		}
		const previous = state.previous;
		state.previous = row;
		if (previous === null || !sortsAfter(row, previous)) continue;

		const previousValue = finiteUtilization(previous);
		if (previousValue === null) continue;

		claim.transitions++;
		const delta = value - previousValue;
		if (delta > 0) {
			claim.positiveIncrements++;
			claim.increments.add(delta);
			if (
				claim.minPositiveIncrement === null ||
				delta < claim.minPositiveIncrement
			) {
				claim.minPositiveIncrement = delta;
			}
		}

		if (!hasStableReset(previous, row)) continue;
		claim.stableResetTransitions++;
		if (delta >= 0) continue;
		claim.stableResetNegatives++;
		if (-delta < GIFT_DROP_THRESHOLD) continue;
		if (isOrderingSuspect(previous, row)) {
			claim.giftDropsOrderingSuspect++;
		} else {
			claim.giftDropsUnexplained++;
		}
	}

	const out: ClaimSeriesAudit[] = [];
	for (const [claimToken, acc] of [...claims].sort((a, b) =>
		a[0].localeCompare(b[0]),
	)) {
		const composition: ClaimComposition = {
			bySource: labelCounts(acc.bySource),
			byStatus: labelCounts(acc.byStatus),
			byHttpStatus: numericLabelCounts(acc.byHttpStatus),
		};
		const spanMs =
			acc.firstObservedAt !== null && acc.lastObservedAt !== null
				? acc.lastObservedAt - acc.firstObservedAt
				: 0;
		out.push({
			claim: claimToken,
			nSeries: acc.series.size,
			nAccounts: acc.accounts.size,
			rows: acc.rows,
			firstObservedAt: acc.firstObservedAt,
			lastObservedAt: acc.lastObservedAt,
			// Null rather than a rate over a zero span: one row, or many rows
			// sharing a millisecond, supports no rate at all — and dividing by the
			// AUDIT range instead would report a claim first seen yesterday as
			// having been nearly silent for 90 days.
			rowsPerDay: spanMs > 0 ? acc.rows / (spanMs / DAY_MS) : null,
			nullUtilizationRows: acc.nullUtilizationRows,
			nullUtilizationShare: share(acc.nullUtilizationRows, acc.rows),
			distinctValues: acc.values.size,
			distinctValuesExact: acc.values.exact,
			topValues: topValues(acc.values),
			onGrid01: acc.onGrid01,
			onGrid001: acc.onGrid001,
			gridShare01: share(acc.onGrid01, acc.finiteReadings),
			gridShare001: share(acc.onGrid001, acc.finiteReadings),
			transitions: acc.transitions,
			positiveIncrements: acc.positiveIncrements,
			minPositiveIncrement: acc.minPositiveIncrement,
			medianPositiveIncrement: medianOf(acc.increments),
			stableResetTransitions: acc.stableResetTransitions,
			stableResetNegatives: acc.stableResetNegatives,
			giftDrops: acc.giftDropsOrderingSuspect + acc.giftDropsUnexplained,
			giftDropsOrderingSuspect: acc.giftDropsOrderingSuspect,
			giftDropsUnexplained: acc.giftDropsUnexplained,
			composition,
		});
	}

	return { fromMs: range.fromMs, toMs: range.toMs, claims: out };
}
