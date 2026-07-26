import { describe, expect, it } from "bun:test";
import type { CapacitySignal } from "@clankermux/types";
import {
	isAbsorbablePeer,
	LIVENESS_RESERVE_HEADROOM_PCT,
	LIVENESS_RESERVE_RELEASE_HORIZON_MS,
	resolvePoolLivenessDemotion,
} from "../pool-liveness-gate";

const NOW = 1_000_000_000_000;

// Capacity builder mirroring family-reservation-gate.test.ts. Full headroom by
// default so each test opts into exactly the constrained axis it is about.
const capacity = (overrides: Partial<CapacitySignal> = {}): CapacitySignal => ({
	minHeadroom: 100,
	sessionHeadroom: 100,
	soonestResetMs: null,
	bindingUtilization: 0,
	weeklyResetMs: null,
	bindingWeeklyResetMs: null,
	weeklyHeadroom: 100,
	sessionResetMs: null,
	extraUsageUtilization: null,
	...overrides,
});

/** A weekly reset comfortably beyond the release horizon (reserve is ACTIVE). */
const farWeeklyReset = NOW + LIVENESS_RESERVE_RELEASE_HORIZON_MS + 3_600_000;

/** Capacity of an account inside the reserve band with a far weekly reset. */
const reservedCapacity = (weeklyHeadroom = 5) =>
	capacity({ weeklyHeadroom, bindingWeeklyResetMs: farWeeklyReset });

describe("resolvePoolLivenessDemotion", () => {
	it("demotes when every rule holds (the whole point of the gate)", () => {
		expect(resolvePoolLivenessDemotion(reservedCapacity(), 1, NOW)).toBe(true);
	});

	// Rule 1 — capacity must exist.
	it("keeps when capacity is null (stale/unknown → fail open)", () => {
		expect(resolvePoolLivenessDemotion(null, 3, NOW)).toBe(false);
	});

	// Rule 2 — weekly headroom must be a finite number.
	it("keeps when weeklyHeadroom is not finite (fail open)", () => {
		expect(
			resolvePoolLivenessDemotion(
				capacity({
					weeklyHeadroom: Number.NaN,
					bindingWeeklyResetMs: farWeeklyReset,
				}),
				3,
				NOW,
			),
		).toBe(false);
	});

	// Rule 3 — must actually be inside the reserve band.
	it("keeps when weekly headroom is at or above the reserve threshold", () => {
		expect(
			resolvePoolLivenessDemotion(
				reservedCapacity(LIVENESS_RESERVE_HEADROOM_PCT),
				3,
				NOW,
			),
		).toBe(false);
		expect(
			resolvePoolLivenessDemotion(
				reservedCapacity(LIVENESS_RESERVE_HEADROOM_PCT + 20),
				3,
				NOW,
			),
		).toBe(false);
	});

	// Rule 4 — pool-aware: with nobody to hand traffic to, this account is needed.
	it("keeps when there is no absorbable peer (nothing to fail over to)", () => {
		expect(resolvePoolLivenessDemotion(reservedCapacity(), 0, NOW)).toBe(false);
	});

	// Rule 5 — the release horizon needs a known binding weekly reset.
	it("keeps when the binding weekly reset is unknown (fail open)", () => {
		expect(
			resolvePoolLivenessDemotion(
				capacity({ weeklyHeadroom: 5, bindingWeeklyResetMs: null }),
				3,
				NOW,
			),
		).toBe(false);
	});

	// Rule 6 — release the reserve before the weekly resets so the tail is spent.
	it("keeps once the binding weekly reset is inside the release horizon", () => {
		// Exactly at the horizon: `>` is strict, so this already releases.
		expect(
			resolvePoolLivenessDemotion(
				capacity({
					weeklyHeadroom: 5,
					bindingWeeklyResetMs: NOW + LIVENESS_RESERVE_RELEASE_HORIZON_MS,
				}),
				3,
				NOW,
			),
		).toBe(false);
		// Well inside the horizon.
		expect(
			resolvePoolLivenessDemotion(
				capacity({
					weeklyHeadroom: 5,
					bindingWeeklyResetMs: NOW + 60_000,
				}),
				3,
				NOW,
			),
		).toBe(false);
		// A reset already in the past also releases.
		expect(
			resolvePoolLivenessDemotion(
				capacity({ weeklyHeadroom: 5, bindingWeeklyResetMs: NOW - 60_000 }),
				3,
				NOW,
			),
		).toBe(false);
	});

	it("uses the BINDING weekly reset, not the earliest weekly reset", () => {
		// An unrelated, healthier weekly window resets in a minute; the BINDING one
		// is far away. The reserve must stay active.
		expect(
			resolvePoolLivenessDemotion(
				capacity({
					weeklyHeadroom: 5,
					weeklyResetMs: NOW + 60_000,
					bindingWeeklyResetMs: farWeeklyReset,
				}),
				1,
				NOW,
			),
		).toBe(true);
	});
});

describe("isAbsorbablePeer", () => {
	it("counts a peer with capacity at/above the reserve threshold", () => {
		expect(
			isAbsorbablePeer(
				capacity({ minHeadroom: LIVENESS_RESERVE_HEADROOM_PCT }),
				false,
				false,
			),
		).toBe(true);
	});

	it("does not count a peer with null (stale/unknown) capacity", () => {
		expect(isAbsorbablePeer(null, false, false)).toBe(false);
	});

	it("does not count a peer whose minHeadroom is not finite", () => {
		expect(
			isAbsorbablePeer(capacity({ minHeadroom: Number.NaN }), false, false),
		).toBe(false);
	});

	it("does not count a peer below the reserve threshold", () => {
		expect(
			isAbsorbablePeer(
				capacity({ minHeadroom: LIVENESS_RESERVE_HEADROOM_PCT - 0.01 }),
				false,
				false,
			),
		).toBe(false);
	});

	it("uses minHeadroom, not weeklyHeadroom — a spent 5h peer cannot absorb", () => {
		// Plenty of weekly quota but its 5h session is spent: this is precisely the
		// failover case the reserve exists to survive, so it must not count.
		expect(
			isAbsorbablePeer(
				capacity({ minHeadroom: 0, sessionHeadroom: 0, weeklyHeadroom: 90 }),
				false,
				false,
			),
		).toBe(false);
	});

	it("does not count a peer the family-reservation gate is holding", () => {
		expect(isAbsorbablePeer(capacity(), true, false)).toBe(false);
	});

	it("does not count a peer that owes a capacity-restored recovery probe", () => {
		expect(isAbsorbablePeer(capacity(), false, true)).toBe(false);
	});
});

describe("liveness reserve boundary (no dead zone at exactly the threshold)", () => {
	it("reserves at 9.99% and absorbs at 10.0% — the band is exactly complementary", () => {
		const justBelow = LIVENESS_RESERVE_HEADROOM_PCT - 0.01;

		// 9.99% weekly headroom → inside the reserve band (demoted).
		expect(
			resolvePoolLivenessDemotion(reservedCapacity(justBelow), 1, NOW),
		).toBe(true);
		// ...and NOT absorbable as a peer.
		expect(
			isAbsorbablePeer(capacity({ minHeadroom: justBelow }), false, false),
		).toBe(false);

		// Exactly 10% → outside the reserve band (kept)...
		expect(
			resolvePoolLivenessDemotion(
				reservedCapacity(LIVENESS_RESERVE_HEADROOM_PCT),
				1,
				NOW,
			),
		).toBe(false);
		// ...and absorbable as a peer. Nothing falls between the two tests.
		expect(
			isAbsorbablePeer(
				capacity({ minHeadroom: LIVENESS_RESERVE_HEADROOM_PCT }),
				false,
				false,
			),
		).toBe(true);
	});
});
