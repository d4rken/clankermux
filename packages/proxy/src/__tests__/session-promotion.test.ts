import { beforeEach, describe, expect, it } from "bun:test";
import {
	IDLE_GAP_FOR_PROMOTION_MS,
	MAX_PROMOTION_TRACKER_ENTRIES,
	PROMOTE_AFTER_TURNS,
} from "../bridge-policy";
import { sessionPromotionTracker } from "../session-promotion";

const MIN_TOKENS = 100_000;
const BIG = 200_000;
const SMALL = 50_000;

beforeEach(() => {
	sessionPromotionTracker.setEnabled(true);
	sessionPromotionTracker.clear();
});

describe("sessionPromotionTracker.observeAndShouldInject", () => {
	it("promotes a session after PROMOTE_AFTER_TURNS turns", () => {
		let now = 1_000;
		// First PROMOTE_AFTER_TURNS-1 turns: not yet established.
		for (let i = 0; i < PROMOTE_AFTER_TURNS - 1; i++) {
			expect(
				sessionPromotionTracker.observeAndShouldInject(
					"s1",
					now,
					BIG,
					MIN_TOKENS,
				),
			).toBe(false);
			expect(sessionPromotionTracker.isPromoted("s1")).toBe(false);
			now += 1_000; // tiny gap, well under idle threshold
		}
		// The PROMOTE_AFTER_TURNS-th turn promotes.
		expect(
			sessionPromotionTracker.observeAndShouldInject(
				"s1",
				now,
				BIG,
				MIN_TOKENS,
			),
		).toBe(true);
		expect(sessionPromotionTracker.isPromoted("s1")).toBe(true);
	});

	it("promotes on an idle gap before reaching the turn count", () => {
		// Turn 1: establishes lastSeenTs, not promoted.
		expect(
			sessionPromotionTracker.observeAndShouldInject(
				"s2",
				10_000,
				BIG,
				MIN_TOKENS,
			),
		).toBe(false);
		expect(sessionPromotionTracker.isPromoted("s2")).toBe(false);
		// Turn 2 after a long idle gap → promote (still below PROMOTE_AFTER_TURNS).
		const later = 10_000 + IDLE_GAP_FOR_PROMOTION_MS;
		expect(
			sessionPromotionTracker.observeAndShouldInject(
				"s2",
				later,
				BIG,
				MIN_TOKENS,
			),
		).toBe(true);
		expect(sessionPromotionTracker.isPromoted("s2")).toBe(true);
	});

	it("is sticky once promoted (stays promoted on later small/fast turns)", () => {
		// Drive to promotion via turns.
		let now = 0;
		for (let i = 0; i < PROMOTE_AFTER_TURNS; i++) {
			sessionPromotionTracker.observeAndShouldInject(
				"s3",
				now,
				BIG,
				MIN_TOKENS,
			);
			now += 1_000;
		}
		expect(sessionPromotionTracker.isPromoted("s3")).toBe(true);
		// A subsequent fast, big turn still returns true (sticky) ...
		expect(
			sessionPromotionTracker.observeAndShouldInject(
				"s3",
				now,
				BIG,
				MIN_TOKENS,
			),
		).toBe(true);
		expect(sessionPromotionTracker.isPromoted("s3")).toBe(true);
	});

	it("returns false until promoted even for big sessions", () => {
		expect(
			sessionPromotionTracker.observeAndShouldInject("s4", 0, BIG, MIN_TOKENS),
		).toBe(false);
	});

	it("returns false when estimatedTokens < minTokens even if promoted", () => {
		let now = 0;
		for (let i = 0; i < PROMOTE_AFTER_TURNS; i++) {
			sessionPromotionTracker.observeAndShouldInject(
				"s5",
				now,
				BIG,
				MIN_TOKENS,
			);
			now += 1_000;
		}
		expect(sessionPromotionTracker.isPromoted("s5")).toBe(true);
		// Promoted but small context → no injection.
		expect(
			sessionPromotionTracker.observeAndShouldInject(
				"s5",
				now,
				SMALL,
				MIN_TOKENS,
			),
		).toBe(false);
	});

	it("returns true when both promoted and big enough", () => {
		let now = 0;
		let last = false;
		for (let i = 0; i < PROMOTE_AFTER_TURNS; i++) {
			last = sessionPromotionTracker.observeAndShouldInject(
				"s6",
				now,
				BIG,
				MIN_TOKENS,
			);
			now += 1_000;
		}
		expect(last).toBe(true);
	});

	it("keeps sessions independent", () => {
		let now = 0;
		for (let i = 0; i < PROMOTE_AFTER_TURNS; i++) {
			sessionPromotionTracker.observeAndShouldInject("a", now, BIG, MIN_TOKENS);
			now += 1_000;
		}
		expect(sessionPromotionTracker.isPromoted("a")).toBe(true);
		// "b" untouched.
		expect(sessionPromotionTracker.isPromoted("b")).toBe(false);
		expect(
			sessionPromotionTracker.observeAndShouldInject("b", now, BIG, MIN_TOKENS),
		).toBe(false);
	});
});

describe("sessionPromotionTracker.isPromoted", () => {
	it("returns false for an absent session", () => {
		expect(sessionPromotionTracker.isPromoted("nope")).toBe(false);
	});
});

describe("sessionPromotionTracker eviction / bounds", () => {
	it("evict() removes a single session", () => {
		sessionPromotionTracker.observeAndShouldInject("e1", 0, BIG, MIN_TOKENS);
		expect(sessionPromotionTracker.getSize()).toBe(1);
		sessionPromotionTracker.evict("e1");
		expect(sessionPromotionTracker.getSize()).toBe(0);
		expect(sessionPromotionTracker.isPromoted("e1")).toBe(false);
	});

	it("caps the map at MAX_PROMOTION_TRACKER_ENTRIES, LRU-evicting the oldest lastSeenTs", () => {
		// Insert one over the cap, each with a strictly increasing timestamp so
		// the first-inserted ("key-0") has the oldest lastSeenTs.
		for (let i = 0; i <= MAX_PROMOTION_TRACKER_ENTRIES; i++) {
			sessionPromotionTracker.observeAndShouldInject(
				`key-${i}`,
				i + 1, // monotonically increasing now
				BIG,
				MIN_TOKENS,
			);
		}
		expect(sessionPromotionTracker.getSize()).toBe(
			MAX_PROMOTION_TRACKER_ENTRIES,
		);
		// Oldest (key-0) was evicted; re-observing it re-adds (and stays at cap by
		// evicting the next-oldest, key-1).
		expect(sessionPromotionTracker.isPromoted("key-0")).toBe(false);
		sessionPromotionTracker.observeAndShouldInject(
			"key-0",
			MAX_PROMOTION_TRACKER_ENTRIES + 100,
			BIG,
			MIN_TOKENS,
		);
		// Still at cap (re-adding key-0 evicted the now-oldest, key-1).
		expect(sessionPromotionTracker.getSize()).toBe(
			MAX_PROMOTION_TRACKER_ENTRIES,
		);
	});

	it("evicts the oldest lastSeenTs (LRU), not the newest, when over cap", () => {
		// Promote "old" at an early timestamp so its state is observable.
		let now = 1;
		for (let i = 0; i < PROMOTE_AFTER_TURNS; i++) {
			sessionPromotionTracker.observeAndShouldInject(
				"old",
				now,
				BIG,
				MIN_TOKENS,
			);
			now += 1; // keep "old" the oldest lastSeenTs
		}
		expect(sessionPromotionTracker.isPromoted("old")).toBe(true);
		// Fill the rest of the cap with newer-timestamped sessions, then overflow.
		for (let i = 0; i < MAX_PROMOTION_TRACKER_ENTRIES; i++) {
			sessionPromotionTracker.observeAndShouldInject(
				`fill-${i}`,
				1_000 + i, // all newer than "old"
				BIG,
				MIN_TOKENS,
			);
		}
		expect(sessionPromotionTracker.getSize()).toBe(
			MAX_PROMOTION_TRACKER_ENTRIES,
		);
		// "old" had the oldest lastSeenTs → evicted; a newer fill survives.
		expect(sessionPromotionTracker.isPromoted("old")).toBe(false);
		expect(
			sessionPromotionTracker.isPromoted(
				`fill-${MAX_PROMOTION_TRACKER_ENTRIES - 1}`,
			),
		).toBe(false); // present but only 1 turn → not promoted
		expect(sessionPromotionTracker.getSize()).toBe(
			MAX_PROMOTION_TRACKER_ENTRIES,
		);
	});
});

describe("sessionPromotionTracker.setEnabled", () => {
	it("clears the map and no-ops observe/isPromoted when disabled", () => {
		let now = 0;
		for (let i = 0; i < PROMOTE_AFTER_TURNS; i++) {
			sessionPromotionTracker.observeAndShouldInject(
				"d1",
				now,
				BIG,
				MIN_TOKENS,
			);
			now += 1_000;
		}
		expect(sessionPromotionTracker.isPromoted("d1")).toBe(true);
		sessionPromotionTracker.setEnabled(false);
		expect(sessionPromotionTracker.getSize()).toBe(0);
		expect(sessionPromotionTracker.isPromoted("d1")).toBe(false);
		// observe is a no-op returning false while disabled.
		expect(
			sessionPromotionTracker.observeAndShouldInject(
				"d2",
				now,
				BIG,
				MIN_TOKENS,
			),
		).toBe(false);
		expect(sessionPromotionTracker.getSize()).toBe(0);
	});
});
