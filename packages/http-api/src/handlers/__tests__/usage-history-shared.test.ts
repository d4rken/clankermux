/**
 * Tests for the shaping primitives both snapshot-history endpoints share:
 * the bucket grid and the carry-forward walk, including how a reading taken
 * BEFORE the range start is treated at the range's left edge.
 */
import { describe, expect, it } from "bun:test";
import { buildBucketGrid, walkCarry } from "../usage-history-shared";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
/** An hour-aligned base so "11:00", "11:36", "11:37" read literally. */
const BASE = Math.floor(1_700_000_000_000 / HOUR) * HOUR;
const at = (h: number, m = 0): number => BASE + h * HOUR + m * MINUTE;

describe("buildBucketGrid", () => {
	it("is empty when there is no evidence at all", () => {
		expect(
			buildBucketGrid({
				sinceMs: at(11),
				bucketMs: HOUR,
				nowMs: at(13),
				firstEvidenceMs: null,
			}),
		).toEqual([]);
	});

	it("runs from floor(since) through floor(now), inclusive", () => {
		expect(
			buildBucketGrid({
				sinceMs: at(11, 37),
				bucketMs: HOUR,
				nowMs: at(13, 20),
				firstEvidenceMs: at(11, 37),
			}),
		).toEqual([at(11), at(12), at(13)]);
	});

	it("starts at the first evidence when it is later than the range start", () => {
		expect(
			buildBucketGrid({
				sinceMs: at(9),
				bucketMs: HOUR,
				nowMs: at(13),
				firstEvidenceMs: at(12, 5),
			}),
		).toEqual([at(12), at(13)]);
	});
});

describe("walkCarry", () => {
	describe("predecessor carry at the range's left edge", () => {
		it("does not hold a predecessor whose window rolled before the range began", () => {
			// Range starts partway through the first bucket (11:37; bucket 11:00).
			// The last pre-range reading reset at 11:36 — after the bucket start
			// but before the range start — so nothing was in force at 11:37 and the
			// first bucket must hold no value.
			const grid = [at(11), at(12), at(13)];
			const held = walkCarry(
				grid,
				new Map(),
				{ pct: 40, reset: at(11, 36), sampledAt: at(10, 50) },
				5 * HOUR,
				at(11, 37),
			);

			expect(held.has(at(11))).toBe(false);
			expect(held.size).toBe(0);
		});

		it("holds a predecessor still in force at the range start until its reset", () => {
			const grid = [at(11), at(12), at(13)];
			const held = walkCarry(
				grid,
				new Map(),
				{ pct: 40, reset: at(11, 50), sampledAt: at(10, 50) },
				5 * HOUR,
				at(11, 37),
			);

			expect(held.get(at(11))).toBe(40);
			expect(held.has(at(12))).toBe(false);
			expect(held.has(at(13))).toBe(false);
		});
	});
});
