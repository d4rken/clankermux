import { beforeEach, describe, expect, test } from "bun:test";
import {
	DESTICK_AFTER_ACTIVE_TURNS,
	IDLE_GAP_FOR_PROMOTION_MS,
	PROMOTE_AFTER_TURNS,
} from "./bridge-policy";
import { sessionPromotionTracker } from "./session-promotion";

const MIN = 100_000;
const BIG = 150_000;
const SMALL = 10_000;

beforeEach(() => {
	// The singleton persists between tests; reset all state.
	sessionPromotionTracker.setMode("off");
	sessionPromotionTracker.clear();
});

describe("static mode", () => {
	beforeEach(() => {
		sessionPromotionTracker.setMode("static");
	});

	test("promotes when estTokens >= minTokens (returns true, isPromoted true)", () => {
		expect(
			sessionPromotionTracker.observeAndShouldInject("s", 0, BIG, MIN),
		).toBe(true);
		expect(sessionPromotionTracker.isPromoted("s")).toBe(true);
	});

	test("does NOT promote when below min", () => {
		expect(
			sessionPromotionTracker.observeAndShouldInject("s", 0, SMALL, MIN),
		).toBe(false);
		expect(sessionPromotionTracker.isPromoted("s")).toBe(false);
	});

	test("sticky once promoted even if a later turn is below min", () => {
		expect(
			sessionPromotionTracker.observeAndShouldInject("s", 0, BIG, MIN),
		).toBe(true);
		// A later below-min turn: still promoted (sticky), still injects.
		expect(
			sessionPromotionTracker.observeAndShouldInject("s", 1000, SMALL, MIN),
		).toBe(true);
		expect(sessionPromotionTracker.isPromoted("s")).toBe(true);
	});
});

describe("dynamic mode", () => {
	beforeEach(() => {
		sessionPromotionTracker.setMode("dynamic");
	});

	test("promotes on the PROMOTE_AFTER_TURNS-th turn when tokens clear min", () => {
		let now = 0;
		// First PROMOTE_AFTER_TURNS - 1 turns are not promoted (no idle gap, not established).
		for (let i = 0; i < PROMOTE_AFTER_TURNS - 1; i++) {
			expect(
				sessionPromotionTracker.observeAndShouldInject("s", now, BIG, MIN),
			).toBe(false);
			now += 1000;
		}
		// The PROMOTE_AFTER_TURNS-th turn establishes promotion.
		expect(
			sessionPromotionTracker.observeAndShouldInject("s", now, BIG, MIN),
		).toBe(true);
		expect(sessionPromotionTracker.isPromoted("s")).toBe(true);
	});

	test("promotes earlier on an idle gap >= IDLE_GAP_FOR_PROMOTION_MS", () => {
		// Turn 1: not promoted.
		expect(
			sessionPromotionTracker.observeAndShouldInject("s", 0, BIG, MIN),
		).toBe(false);
		// Turn 2 with a long idle gap → promoted even before PROMOTE_AFTER_TURNS.
		expect(
			sessionPromotionTracker.observeAndShouldInject(
				"s",
				IDLE_GAP_FOR_PROMOTION_MS,
				BIG,
				MIN,
			),
		).toBe(true);
		expect(sessionPromotionTracker.isPromoted("s")).toBe(true);
	});

	test("returns false (no inject) when promoted but estTokens < minTokens", () => {
		// Promote via idle gap.
		sessionPromotionTracker.observeAndShouldInject("s", 0, BIG, MIN);
		const injected = sessionPromotionTracker.observeAndShouldInject(
			"s",
			IDLE_GAP_FOR_PROMOTION_MS,
			SMALL,
			MIN,
		);
		expect(injected).toBe(false);
		// Still promoted though.
		expect(sessionPromotionTracker.isPromoted("s")).toBe(true);
	});
});

describe("dynamic de-stick", () => {
	beforeEach(() => {
		sessionPromotionTracker.setMode("dynamic");
	});

	test("demotes after DESTICK_AFTER_ACTIVE_TURNS consecutive non-idle turns", () => {
		let now = 0;
		// Promote via idle gap.
		sessionPromotionTracker.observeAndShouldInject("s", now, BIG, MIN);
		now += IDLE_GAP_FOR_PROMOTION_MS;
		sessionPromotionTracker.observeAndShouldInject("s", now, BIG, MIN);
		expect(sessionPromotionTracker.isPromoted("s")).toBe(true);

		// Now hammer it with consecutive non-idle (small-gap) turns.
		for (let i = 0; i < DESTICK_AFTER_ACTIVE_TURNS; i++) {
			now += 1000; // small gap, non-idle
			sessionPromotionTracker.observeAndShouldInject("s", now, BIG, MIN);
		}
		expect(sessionPromotionTracker.isPromoted("s")).toBe(false);
	});

	test("an idle gap before reaching the threshold resets the streak (no demotion)", () => {
		let now = 0;
		// Promote.
		sessionPromotionTracker.observeAndShouldInject("s", now, BIG, MIN);
		now += IDLE_GAP_FOR_PROMOTION_MS;
		sessionPromotionTracker.observeAndShouldInject("s", now, BIG, MIN);
		expect(sessionPromotionTracker.isPromoted("s")).toBe(true);

		// Almost reach the threshold with non-idle turns.
		for (let i = 0; i < DESTICK_AFTER_ACTIVE_TURNS - 1; i++) {
			now += 1000;
			sessionPromotionTracker.observeAndShouldInject("s", now, BIG, MIN);
		}
		expect(sessionPromotionTracker.isPromoted("s")).toBe(true);

		// An idle gap resets the active streak.
		now += IDLE_GAP_FOR_PROMOTION_MS;
		sessionPromotionTracker.observeAndShouldInject("s", now, BIG, MIN);
		expect(sessionPromotionTracker.isPromoted("s")).toBe(true);

		// Now another (DESTICK_AFTER_ACTIVE_TURNS - 1) non-idle turns: still promoted,
		// streak hasn't reached the threshold again.
		for (let i = 0; i < DESTICK_AFTER_ACTIVE_TURNS - 1; i++) {
			now += 1000;
			sessionPromotionTracker.observeAndShouldInject("s", now, BIG, MIN);
		}
		expect(sessionPromotionTracker.isPromoted("s")).toBe(true);
	});
});

describe("dynamic establishedOnce latch", () => {
	beforeEach(() => {
		sessionPromotionTracker.setMode("dynamic");
	});

	test("after de-stick, non-idle turns over PROMOTE_AFTER_TURNS do NOT re-promote; only a fresh idle gap does", () => {
		let now = 0;
		// Promote via idle gap.
		sessionPromotionTracker.observeAndShouldInject("s", now, BIG, MIN);
		now += IDLE_GAP_FOR_PROMOTION_MS;
		sessionPromotionTracker.observeAndShouldInject("s", now, BIG, MIN);
		expect(sessionPromotionTracker.isPromoted("s")).toBe(true);

		// De-stick via consecutive non-idle turns.
		for (let i = 0; i < DESTICK_AFTER_ACTIVE_TURNS; i++) {
			now += 1000;
			sessionPromotionTracker.observeAndShouldInject("s", now, BIG, MIN);
		}
		expect(sessionPromotionTracker.isPromoted("s")).toBe(false);

		// Many more non-idle turns (turnCount now well over PROMOTE_AFTER_TURNS):
		// establishedOnce latch prevents the "turns" trigger from re-promoting.
		for (let i = 0; i < PROMOTE_AFTER_TURNS + 5; i++) {
			now += 1000;
			expect(
				sessionPromotionTracker.observeAndShouldInject("s", now, BIG, MIN),
			).toBe(false);
		}
		expect(sessionPromotionTracker.isPromoted("s")).toBe(false);

		// A fresh idle gap re-promotes.
		now += IDLE_GAP_FOR_PROMOTION_MS;
		expect(
			sessionPromotionTracker.observeAndShouldInject("s", now, BIG, MIN),
		).toBe(true);
		expect(sessionPromotionTracker.isPromoted("s")).toBe(true);
	});
});

describe("mode switching", () => {
	test("off mode: observe returns false and isPromoted false", () => {
		sessionPromotionTracker.setMode("off");
		expect(
			sessionPromotionTracker.observeAndShouldInject("s", 0, BIG, MIN),
		).toBe(false);
		expect(sessionPromotionTracker.isPromoted("s")).toBe(false);
	});

	test('setMode("off") clears state', () => {
		sessionPromotionTracker.setMode("static");
		sessionPromotionTracker.observeAndShouldInject("s", 0, BIG, MIN);
		expect(sessionPromotionTracker.getSize()).toBe(1);
		sessionPromotionTracker.setMode("off");
		expect(sessionPromotionTracker.getSize()).toBe(0);
		expect(sessionPromotionTracker.isPromoted("s")).toBe(false);
	});

	test("setEnabled alias maps to dynamic/off", () => {
		sessionPromotionTracker.setEnabled(true);
		// dynamic: idle gap promotes.
		sessionPromotionTracker.observeAndShouldInject("s", 0, BIG, MIN);
		expect(
			sessionPromotionTracker.observeAndShouldInject(
				"s",
				IDLE_GAP_FOR_PROMOTION_MS,
				BIG,
				MIN,
			),
		).toBe(true);
		sessionPromotionTracker.setEnabled(false);
		expect(sessionPromotionTracker.isPromoted("s")).toBe(false);
		expect(sessionPromotionTracker.getSize()).toBe(0);
	});

	test("getPromotedCount reflects promoted entries", () => {
		sessionPromotionTracker.setMode("static");
		sessionPromotionTracker.observeAndShouldInject("a", 0, BIG, MIN); // promoted
		sessionPromotionTracker.observeAndShouldInject("b", 0, SMALL, MIN); // not promoted
		expect(sessionPromotionTracker.getPromotedCount()).toBe(1);
	});
});
