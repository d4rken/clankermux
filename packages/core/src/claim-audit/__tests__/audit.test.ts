/**
 * The standing claim-series audit, against synthetic rows with known answers.
 *
 * The audit is descriptive, so most of these tests are arithmetic. The ones
 * that are not are the classification rules, and each of them exists because
 * the naive version of the rule produces a confident wrong number:
 *
 *  - two NULL resets read as "the same window", turning a missed rollover into
 *    a phantom credit;
 *  - a drop between two overlapping, out-of-order requests read as a real drop;
 *  - a grid test written as exact equality reporting 0.07 as off the 0.01 grid;
 *  - a median taken from a truncated tracker, which is a different number with
 *    no error bar rather than an approximate one.
 */
import { describe, expect, it } from "bun:test";
import {
	auditClaimSeries,
	GIFT_DROP_THRESHOLD,
	MAX_TRACKED_VALUES,
	TOP_VALUES_K,
} from "../audit";
import type { ClaimObservationInput } from "../types";

const T0 = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const RANGE = { fromMs: T0 - 90 * DAY, toMs: T0 + 90 * DAY };

let seq = 0;

/**
 * One row. `observedAt` is a millisecond OFFSET from T0 so the fixtures read as
 * a timeline; ids ascend with insertion so the `(observedAt, requestId)`
 * contract holds without every fixture spelling one out.
 */
function row(
	over: Partial<ClaimObservationInput> & { at: number },
): ClaimObservationInput {
	const { at, ...rest } = over;
	seq++;
	return {
		accountId: "acct-a",
		claim: "5h",
		requestId: `req-${String(seq).padStart(4, "0")}`,
		observedAt: T0 + at,
		requestStartedAt: T0 + at - 1_000,
		httpStatus: 200,
		source: "client",
		status: "allowed",
		utilization: 0.1,
		resetAt: T0 + 5 * 60 * 60 * 1000,
		...rest,
	};
}

function auditOne(rows: ClaimObservationInput[]) {
	const report = auditClaimSeries(rows, RANGE);
	expect(report.claims).toHaveLength(1);
	return report.claims[0];
}

describe("auditClaimSeries — census", () => {
	it("states the span it covers even when nothing was captured", () => {
		const report = auditClaimSeries([], RANGE);
		expect(report).toEqual({
			fromMs: RANGE.fromMs,
			toMs: RANGE.toMs,
			claims: [],
		});
	});

	it("counts rows, series and accounts per claim", () => {
		const report = auditClaimSeries(
			[
				row({ at: 0, claim: "5h", accountId: "a" }),
				row({ at: 1_000, claim: "5h", accountId: "b" }),
				row({ at: 2_000, claim: "7d", accountId: "a" }),
				row({ at: 3_000, claim: "5h", accountId: "a" }),
			],
			RANGE,
		);

		expect(report.claims.map((c) => c.claim)).toEqual(["5h", "7d"]);
		const fiveHour = report.claims[0];
		expect(fiveHour.rows).toBe(3);
		expect(fiveHour.nAccounts).toBe(2);
		expect(fiveHour.nSeries).toBe(2);
		expect(report.claims[1].rows).toBe(1);
	});

	it("counts a null utilization as a row with no reading", () => {
		const claim = auditOne([
			row({ at: 0, utilization: 0.1 }),
			row({ at: 1_000, utilization: null }),
			row({ at: 2_000, utilization: Number.NaN }),
			row({ at: 3_000, utilization: 0.2 }),
		]);

		expect(claim.rows).toBe(4);
		expect(claim.nullUtilizationRows).toBe(2);
		expect(claim.nullUtilizationShare).toBe(0.5);
		// A reading of ZERO is a reading — the census must not fold it into null.
		const withZero = auditOne([row({ at: 0, utilization: 0 })]);
		expect(withZero.nullUtilizationRows).toBe(0);
		expect(withZero.distinctValues).toBe(1);
	});

	it("does not end a series at a row with no reading", () => {
		// The next finite reading is compared against the last finite one. Ending
		// the series would silently drop a transition across one missing header —
		// which is one of the things the audit exists to count.
		const claim = auditOne([
			row({ at: 0, utilization: 0.1 }),
			row({ at: 1_000, utilization: null }),
			row({ at: 2_000, utilization: 0.3 }),
		]);

		expect(claim.transitions).toBe(1);
		expect(claim.positiveIncrements).toBe(1);
		expect(claim.minPositiveIncrement).toBeCloseTo(0.2, 12);
	});

	it("reports rows per day over the OBSERVED span, not the audit range", () => {
		// A claim first seen two days ago has existed for two days, not for the 180
		// the range covers.
		const claim = auditOne([
			row({ at: 0 }),
			row({ at: DAY }),
			row({ at: 2 * DAY }),
			row({ at: 2 * DAY + 1 }),
		]);

		expect(claim.firstObservedAt).toBe(T0);
		expect(claim.lastObservedAt).toBe(T0 + 2 * DAY + 1);
		expect(claim.rowsPerDay).toBeCloseTo(2, 3);
	});

	it("has no rate at all for a single row", () => {
		// Null, never 0: one row over a zero span supports no rate.
		expect(auditOne([row({ at: 0 })]).rowsPerDay).toBeNull();
	});

	it("composes the captured rows by source, status and HTTP status", () => {
		const claim = auditOne([
			row({ at: 0, source: "client", status: "allowed", httpStatus: 200 }),
			row({ at: 1_000, source: "client", status: "allowed", httpStatus: 200 }),
			row({
				at: 2_000,
				source: "keepalive",
				status: "allowed",
				httpStatus: 200,
			}),
			row({ at: 3_000, source: "client", status: "rejected", httpStatus: 429 }),
		]);

		expect(claim.composition.bySource).toEqual([
			{ label: "client", count: 3 },
			{ label: "keepalive", count: 1 },
		]);
		expect(claim.composition.byStatus).toEqual([
			{ label: "allowed", count: 3 },
			{ label: "rejected", count: 1 },
		]);
		expect(claim.composition.byHttpStatus).toEqual([
			{ label: "200", count: 3 },
			{ label: "429", count: 1 },
		]);
	});
});

describe("auditClaimSeries — value census and grids", () => {
	it("counts distinct values and reports the most frequent ones", () => {
		const claim = auditOne([
			row({ at: 0, utilization: 0.1 }),
			row({ at: 1_000, utilization: 0.1 }),
			row({ at: 2_000, utilization: 0.1 }),
			row({ at: 3_000, utilization: 0.2 }),
			row({ at: 4_000, utilization: 0.2 }),
			row({ at: 5_000, utilization: 0.3 }),
		]);

		expect(claim.distinctValues).toBe(3);
		expect(claim.distinctValuesExact).toBe(true);
		expect(claim.topValues).toEqual([
			{ value: 0.1, count: 3 },
			{ value: 0.2, count: 2 },
			{ value: 0.3, count: 1 },
		]);
	});

	it("never serializes an unbounded value set", () => {
		// A pathological series must not turn the audit into a second copy of the
		// table. It truncates, says so, and the distinct count becomes a floor.
		const rows: ClaimObservationInput[] = [];
		for (let i = 0; i < MAX_TRACKED_VALUES + 500; i++) {
			rows.push(row({ at: i, utilization: i / 1e7 }));
		}
		const claim = auditOne(rows);

		expect(claim.distinctValues).toBe(MAX_TRACKED_VALUES);
		expect(claim.distinctValuesExact).toBe(false);
		expect(claim.topValues.length).toBeLessThanOrEqual(TOP_VALUES_K);
	});

	it("recognises the 0.01 grid despite binary floating point", () => {
		// 0.07 * 100 is 7.000000000000001. An exact test would report a value
		// plainly on the grid as off it.
		const claim = auditOne([
			row({ at: 0, utilization: 0.07 }),
			row({ at: 1_000, utilization: 0.29 }),
			row({ at: 2_000, utilization: 0.941 }),
		]);

		expect(claim.onGrid01).toBe(2);
		expect(claim.gridShare01).toBeCloseTo(2 / 3, 12);
		// The finer grid contains the coarser one.
		expect(claim.onGrid001).toBe(3);
		expect(claim.gridShare001).toBe(1);
	});

	it("has no grid share when nothing was readable", () => {
		const claim = auditOne([
			row({ at: 0, utilization: null }),
			row({ at: 1_000, utilization: null }),
		]);

		expect(claim.gridShare01).toBeNull();
		expect(claim.gridShare001).toBeNull();
	});
});

describe("auditClaimSeries — increments", () => {
	it("summarises the positive increments", () => {
		const claim = auditOne([
			row({ at: 0, utilization: 0.1 }),
			row({ at: 1_000, utilization: 0.11 }),
			row({ at: 2_000, utilization: 0.14 }),
			row({ at: 3_000, utilization: 0.2 }),
		]);

		expect(claim.transitions).toBe(3);
		expect(claim.positiveIncrements).toBe(3);
		expect(claim.minPositiveIncrement).toBeCloseTo(0.01, 12);
		// Lower median of {0.01, 0.03, 0.06}.
		expect(claim.medianPositiveIncrement).toBeCloseTo(0.03, 12);
	});

	it("has no increment statistics when nothing ever rose", () => {
		const claim = auditOne([
			row({ at: 0, utilization: 0.3 }),
			row({ at: 1_000, utilization: 0.3 }),
			row({ at: 2_000, utilization: 0.2 }),
		]);

		expect(claim.positiveIncrements).toBe(0);
		expect(claim.minPositiveIncrement).toBeNull();
		expect(claim.medianPositiveIncrement).toBeNull();
	});

	it("never compares across accounts", () => {
		// Two accounts' readings interleaved. Comparing them would manufacture
		// transitions that never happened to either series.
		const claim = auditOne([
			row({ at: 0, accountId: "a", utilization: 0.1 }),
			row({ at: 1_000, accountId: "b", utilization: 0.9 }),
			row({ at: 2_000, accountId: "a", utilization: 0.2 }),
			row({ at: 3_000, accountId: "b", utilization: 0.95 }),
		]);

		expect(claim.transitions).toBe(2);
		expect(claim.positiveIncrements).toBe(2);
		expect(claim.minPositiveIncrement).toBeCloseTo(0.05, 12);
	});
});

describe("auditClaimSeries — stable-reset negatives", () => {
	const RESET_A = T0 + 5 * 60 * 60 * 1000;
	const RESET_B = T0 + 10 * 60 * 60 * 1000;

	it("counts a drop only when both readings name the SAME window", () => {
		const claim = auditOne([
			row({ at: 0, utilization: 0.9, resetAt: RESET_A }),
			// Same window (within jitter) and a drop — counted.
			row({ at: 1_000, utilization: 0.8, resetAt: RESET_A + 30_000 }),
			// A different window: the drop is a rollover, not a credit.
			row({ at: 2_000, utilization: 0.1, resetAt: RESET_B }),
		]);

		expect(claim.transitions).toBe(2);
		expect(claim.stableResetTransitions).toBe(1);
		expect(claim.stableResetNegatives).toBe(1);
	});

	it("does NOT treat two null resets as a stable window", () => {
		// "We do not know when either window resets" is not evidence that they are
		// the same one. Counting it as stable is how a missed rollover becomes a
		// phantom credit.
		const claim = auditOne([
			row({ at: 0, utilization: 0.9, resetAt: null }),
			row({ at: 1_000, utilization: 0.1, resetAt: null }),
		]);

		expect(claim.transitions).toBe(1);
		expect(claim.stableResetTransitions).toBe(0);
		expect(claim.stableResetNegatives).toBe(0);
		expect(claim.giftDrops).toBe(0);
	});

	it("does not treat one null reset as stable either", () => {
		const claim = auditOne([
			row({ at: 0, utilization: 0.9, resetAt: RESET_A }),
			row({ at: 1_000, utilization: 0.1, resetAt: null }),
		]);

		expect(claim.stableResetTransitions).toBe(0);
	});

	it("counts a gift-sized drop, and only above the threshold", () => {
		const claim = auditOne([
			row({ at: 0, utilization: 0.9, resetAt: RESET_A }),
			// Below the threshold: a negative, but not a gift.
			row({ at: 1_000, utilization: 0.88, resetAt: RESET_A }),
			// Exactly at it: a gift.
			row({
				at: 2_000,
				utilization: 0.88 - GIFT_DROP_THRESHOLD,
				resetAt: RESET_A,
			}),
		]);

		expect(claim.stableResetNegatives).toBe(2);
		expect(claim.giftDrops).toBe(1);
		expect(claim.giftDropsUnexplained).toBe(1);
		expect(claim.giftDropsOrderingSuspect).toBe(0);
	});

	it("blames arrival order only when the requests inverted AND overlapped", () => {
		// Observed second, but STARTED first and still in flight when the other
		// was observed: the later row may carry the older reading.
		const claim = auditOne([
			row({
				at: 0,
				utilization: 0.9,
				resetAt: RESET_A,
				requestStartedAt: T0 - 1_000,
			}),
			row({
				at: 1_000,
				utilization: 0.5,
				resetAt: RESET_A,
				requestStartedAt: T0 - 5_000,
			}),
		]);

		expect(claim.giftDrops).toBe(1);
		expect(claim.giftDropsOrderingSuspect).toBe(1);
		expect(claim.giftDropsUnexplained).toBe(0);
	});

	it("does not blame arrival order when the starts ran in order", () => {
		// The later-observed request also started later, so nothing suggests it
		// carries the older reading. The drop is unexplained, not excused.
		const claim = auditOne([
			row({
				at: 10_000,
				utilization: 0.9,
				resetAt: RESET_A,
				requestStartedAt: T0 + 9_000,
			}),
			row({
				at: 20_000,
				utilization: 0.5,
				resetAt: RESET_A,
				requestStartedAt: T0 + 15_000,
			}),
		]);

		expect(claim.giftDrops).toBe(1);
		expect(claim.giftDropsOrderingSuspect).toBe(0);
		expect(claim.giftDropsUnexplained).toBe(1);
	});

	it("requires overlap as well, so inconsistent timestamps are not excused", () => {
		// With well-formed rows (start <= observed) an inverted start ALWAYS
		// implies overlap, which is why the overlap term looks redundant. It is
		// not: the only rows that fail it are ones whose own timestamps are
		// impossible, and those must not buy an excuse for their drop.
		const claim = auditClaimSeries(
			[
				{
					...row({ at: 0, utilization: 0.9, resetAt: RESET_A }),
					// Claims to have started long AFTER its headers arrived.
					requestStartedAt: T0 + 100_000,
					observedAt: T0 + 10_000,
				},
				{
					...row({ at: 0, utilization: 0.5, resetAt: RESET_A }),
					requestStartedAt: T0 + 50_000,
					observedAt: T0 + 20_000,
				},
			],
			RANGE,
		).claims[0];

		expect(claim.giftDrops).toBe(1);
		expect(claim.giftDropsOrderingSuspect).toBe(0);
		expect(claim.giftDropsUnexplained).toBe(1);
	});
});

describe("auditClaimSeries — ordering contract", () => {
	it("forms no transition from an out-of-order row", () => {
		// The caller orders by (observedAt, requestId). A row that arrives out of
		// order does not pair — a spurious transition would be worse than none.
		const first = row({ at: 10_000, utilization: 0.5 });
		const stale = {
			...row({ at: 0, utilization: 0.1 }),
			requestId: "req-zzzz",
		};
		const claim = auditOne([first, stale]);

		expect(claim.rows).toBe(2);
		expect(claim.transitions).toBe(0);
	});

	it("breaks a same-millisecond tie by request id, deterministically", () => {
		const a: ClaimObservationInput = {
			...row({ at: 0, utilization: 0.1 }),
			requestId: "req-a",
			observedAt: T0,
		};
		const b: ClaimObservationInput = {
			...row({ at: 0, utilization: 0.4 }),
			requestId: "req-b",
			observedAt: T0,
		};

		const forward = auditOne([a, b]);
		expect(forward.transitions).toBe(1);
		expect(forward.positiveIncrements).toBe(1);
		expect(forward.minPositiveIncrement).toBeCloseTo(0.3, 12);
	});
});
