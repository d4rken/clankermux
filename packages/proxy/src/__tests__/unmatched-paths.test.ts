import { describe, expect, it } from "bun:test";
import { UnmatchedPathTracker } from "../unmatched-paths";

function makeClock(start = 1_000): {
	now: () => number;
	advance: (ms: number) => void;
} {
	let t = start;
	return {
		now: () => t,
		advance: (ms) => {
			t += ms;
		},
	};
}

describe("UnmatchedPathTracker", () => {
	it("counts repeat sightings of one path", () => {
		const tracker = new UnmatchedPathTracker();
		tracker.record("/workspace/a");
		tracker.record("/workspace/a");
		expect(tracker.list()).toEqual([
			expect.objectContaining({ path: "/workspace/a", count: 2 }),
		]);
	});

	it("lists most recently seen first", () => {
		const clock = makeClock();
		const tracker = new UnmatchedPathTracker(clock.now);
		tracker.record("/workspace/a");
		clock.advance(10);
		tracker.record("/workspace/b");
		expect(tracker.list().map((e) => e.path)).toEqual([
			"/workspace/b",
			"/workspace/a",
		]);
	});

	it("keeps a path in active use alive against a burst of one-off paths", () => {
		// A repeat sighting refreshes recency, not just the count, so the path an
		// operator most needs to see cannot be evicted by noise.
		const tracker = new UnmatchedPathTracker();
		tracker.record("/workspace/keepme");
		for (let i = 0; i < 60; i++) {
			tracker.record(`/workspace/noise-${i}`);
			tracker.record("/workspace/keepme");
		}
		expect(tracker.list().some((e) => e.path === "/workspace/keepme")).toBe(
			true,
		);
	});

	it("is bounded", () => {
		const tracker = new UnmatchedPathTracker();
		for (let i = 0; i < 200; i++) tracker.record(`/workspace/p-${i}`);
		expect(tracker.list().length).toBeLessThanOrEqual(50);
	});

	it("ignores an empty path and an implausibly long one", () => {
		const tracker = new UnmatchedPathTracker();
		tracker.record("");
		tracker.record(`/${"a".repeat(600)}`);
		expect(tracker.list()).toEqual([]);
	});

	it("clears, because a rules change makes every entry a stale complaint", () => {
		const tracker = new UnmatchedPathTracker();
		tracker.record("/workspace/a");
		tracker.clear();
		expect(tracker.list()).toEqual([]);
	});
});
