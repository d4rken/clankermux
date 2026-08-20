import { describe, expect, it } from "bun:test";
import { MAIN_CONNECTION_BUSY_TIMEOUT_MS } from "../database-operations";
import {
	bucketLabel,
	formatLockContention,
	LOCK_HISTOGRAM_BOUNDS_MS,
	LockContentionStats,
	SLOT_HOLD_LONG_MS,
	SLOW_OPERATION_MS,
} from "../lock-contention-stats";

describe("LockContentionStats", () => {
	it("straddles the main-connection busy timeout with a bucket boundary", () => {
		// So the shape either side of the timeout is legible. This separates
		// DURATIONS only — a cold read and a sub-timeout lock wait of the same
		// length still share a bucket, and no bucketing can tell them apart.
		expect(LOCK_HISTOGRAM_BOUNDS_MS).toContain(MAIN_CONNECTION_BUSY_TIMEOUT_MS);
	});

	it("keeps the long-hold threshold equal to the main busy timeout", () => {
		// slotHoldLong counts holds long enough to have exhausted a main-thread
		// write's whole busy budget. If these drift apart it stops meaning even
		// that. (A write arriving late in such a hold waits only the remainder,
		// so this is a "could have", never a confirmed park.)
		expect(SLOT_HOLD_LONG_MS).toBe(MAIN_CONNECTION_BUSY_TIMEOUT_MS);
	});

	it("separates just-under from just-over the busy timeout", () => {
		const stats = new LockContentionStats();
		const t = MAIN_CONNECTION_BUSY_TIMEOUT_MS;
		stats.recordOperation(t - 1);
		stats.recordOperation(t);
		stats.recordOperation(t + 1);

		const snap = stats.snapshot();
		const boundaryIndex = LOCK_HISTOGRAM_BOUNDS_MS.indexOf(t);
		// t - 1 falls in the bucket ending at the timeout; t and t + 1 fall in
		// the next one up (bucket bounds are exclusive upper bounds).
		expect(snap.buckets[boundaryIndex]).toBe(1);
		expect(snap.buckets[boundaryIndex + 1]).toBe(2);
	});

	it("counts slow operations and tracks the worst one by name", () => {
		const stats = new LockContentionStats();
		stats.recordOperation(5, "fast");
		stats.recordOperation(SLOW_OPERATION_MS, "slow-a");
		stats.recordOperation(SLOW_OPERATION_MS + 300, "slow-b");

		const snap = stats.snapshot();
		expect(snap.operations).toBe(3);
		expect(snap.slowOperations).toBe(2);
		expect(snap.slowMs).toBe(SLOW_OPERATION_MS * 2 + 300);
		expect(snap.maxMs).toBe(SLOW_OPERATION_MS + 300);
		expect(snap.maxOperation).toBe("slow-b");
	});

	it("routes an over-long operation into the overflow bucket", () => {
		const stats = new LockContentionStats();
		const last = LOCK_HISTOGRAM_BOUNDS_MS[LOCK_HISTOGRAM_BOUNDS_MS.length - 1];
		stats.recordOperation(last * 10);

		const snap = stats.snapshot();
		expect(snap.buckets).toHaveLength(LOCK_HISTOGRAM_BOUNDS_MS.length + 1);
		expect(snap.buckets[LOCK_HISTOGRAM_BOUNDS_MS.length]).toBe(1);
	});

	it("ignores non-finite and negative durations instead of poisoning the interval", () => {
		const stats = new LockContentionStats();
		stats.recordOperation(Number.NaN);
		stats.recordOperation(Number.POSITIVE_INFINITY);
		stats.recordOperation(-1);
		stats.recordOperation(42);

		const snap = stats.snapshot();
		expect(snap.operations).toBe(1);
		expect(snap.maxMs).toBe(42);
	});

	it("counts busy retries, exhaustion and classifier gaps separately", () => {
		const stats = new LockContentionStats();
		stats.recordBusyOccurrence();
		stats.recordBusyOccurrence();
		stats.recordBusyExhausted();
		stats.recordClassifierGap();

		const snap = stats.snapshot();
		expect(snap.busyOccurrences).toBe(2);
		expect(snap.busyExhausted).toBe(1);
		expect(snap.classifierGap).toBe(1);
	});

	it("snapshot leaves the accumulator intact, drain resets it", () => {
		const stats = new LockContentionStats();
		stats.recordOperation(300, "op");
		stats.recordBusyOccurrence();

		expect(stats.snapshot().operations).toBe(1);
		expect(stats.snapshot().operations).toBe(1);

		const drained = stats.drain();
		expect(drained.operations).toBe(1);
		expect(drained.busyOccurrences).toBe(1);

		const after = stats.snapshot();
		expect(after.operations).toBe(0);
		expect(after.busyOccurrences).toBe(0);
		expect(after.maxMs).toBe(0);
		expect(after.maxOperation).toBeNull();
		expect(after.buckets.every((b) => b === 0)).toBe(true);
	});

	it("returns a copy of the buckets so callers cannot mutate the accumulator", () => {
		const stats = new LockContentionStats();
		stats.recordOperation(5);

		const snap = stats.snapshot();
		snap.buckets[0] = 999;

		expect(stats.snapshot().buckets[0]).toBe(1);
	});

	it("labels buckets with their range and marks the overflow", () => {
		expect(bucketLabel(0)).toBe(`0-${LOCK_HISTOGRAM_BOUNDS_MS[0]}`);
		expect(bucketLabel(1)).toBe(
			`${LOCK_HISTOGRAM_BOUNDS_MS[0]}-${LOCK_HISTOGRAM_BOUNDS_MS[1]}`,
		);
		expect(bucketLabel(LOCK_HISTOGRAM_BOUNDS_MS.length)).toBe(
			`${LOCK_HISTOGRAM_BOUNDS_MS[LOCK_HISTOGRAM_BOUNDS_MS.length - 1]}+`,
		);
	});
});

describe("formatLockContention", () => {
	it("omits empty buckets but keeps every populated one", () => {
		const stats = new LockContentionStats();
		stats.recordOperation(5);
		stats.recordOperation(MAIN_CONNECTION_BUSY_TIMEOUT_MS + 1);

		const line = formatLockContention(stats.snapshot());
		expect(line).toContain(`0-${LOCK_HISTOGRAM_BOUNDS_MS[0]}=1`);
		expect(line).toContain("ops=2");

		// Only the histogram half suppresses empties. The counters before the
		// "|" are always printed, including at zero — a zero has to stay visible
		// to be read as the lower bound it is, rather than as a missing field.
		const histogram = line.split(" | ")[1] ?? "";
		expect(histogram).not.toBe("");
		for (const entry of histogram.split(" ")) {
			expect(entry.endsWith("=0")).toBe(false);
		}
		// Exactly the two buckets that received a sample.
		expect(histogram.split(" ")).toHaveLength(2);
	});

	it("renders counters even when no operation was recorded", () => {
		const stats = new LockContentionStats();
		stats.recordBusyOccurrence();

		const line = formatLockContention(stats.snapshot());
		expect(line).toContain("ops=0");
		expect(line).toContain("busyOccurrences=1");
		expect(line).not.toContain("maxOp=");
	});
});
