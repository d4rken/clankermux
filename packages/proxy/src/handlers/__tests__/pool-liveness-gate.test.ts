import { describe, expect, it } from "bun:test";
import type { CapacitySignal } from "@clankermux/types";
import {
	isAbsorbablePeer,
	LIVENESS_DESIGN_SLOPE_PCT_PER_HOUR,
	LIVENESS_RELEASE_HORIZON_MAX_MS,
	LIVENESS_RELEASE_HORIZON_MIN_MS,
	LIVENESS_RESERVE_HEADROOM_PCT,
	LIVENESS_RESERVE_PROTECTED_HEADROOM_PCT,
	resolveLivenessReserveThreshold,
	resolvePoolLivenessDemotion,
} from "../pool-liveness-gate";

const NOW = 1_000_000_000_000;
const HOUR = 3_600_000;

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

/** The non-protected tier's threshold — the default the old single tier had. */
const NON_PROTECTED = resolveLivenessReserveThreshold(false);
const PROTECTED = resolveLivenessReserveThreshold(true);

/**
 * A weekly reset comfortably beyond ANY release horizon this gate can compute
 * (the 36h max clamp is the ceiling), so the reserve is ACTIVE.
 */
const farWeeklyReset = NOW + LIVENESS_RELEASE_HORIZON_MAX_MS + HOUR;

/** Capacity of an account inside the reserve band with a far weekly reset. */
const reservedCapacity = (weeklyHeadroom = 5) =>
	capacity({ weeklyHeadroom, bindingWeeklyResetMs: farWeeklyReset });

/** Gate options: non-protected tier, no slope evidence (static fallback). */
const opts = (
	overrides: {
		reserveThresholdPct?: number;
		weeklySlopePctPerHour?: number | null;
	} = {},
) => ({
	reserveThresholdPct: NON_PROTECTED,
	weeklySlopePctPerHour: null,
	...overrides,
});

describe("resolveLivenessReserveThreshold", () => {
	it("is the ONE source of the per-tier threshold", () => {
		expect(resolveLivenessReserveThreshold(false)).toBe(
			LIVENESS_RESERVE_HEADROOM_PCT,
		);
		expect(resolveLivenessReserveThreshold(true)).toBe(
			LIVENESS_RESERVE_PROTECTED_HEADROOM_PCT,
		);
	});

	it("exposes the documented constant values", () => {
		expect(LIVENESS_RESERVE_HEADROOM_PCT).toBe(20);
		expect(LIVENESS_RESERVE_PROTECTED_HEADROOM_PCT).toBe(10);
		expect(LIVENESS_RELEASE_HORIZON_MIN_MS).toBe(12 * HOUR);
		expect(LIVENESS_RELEASE_HORIZON_MAX_MS).toBe(36 * HOUR);
		expect(LIVENESS_DESIGN_SLOPE_PCT_PER_HOUR).toBe(0.66);
	});
});

describe("resolvePoolLivenessDemotion", () => {
	it("demotes when every rule holds (the whole point of the gate)", () => {
		expect(
			resolvePoolLivenessDemotion(reservedCapacity(), 1, NOW, opts()),
		).toBe(true);
	});

	// Rule 1 — capacity must exist.
	it("keeps when capacity is null (stale/unknown → fail open)", () => {
		expect(resolvePoolLivenessDemotion(null, 3, NOW, opts())).toBe(false);
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
				opts(),
			),
		).toBe(false);
	});

	// Rule 3 — must actually be inside the reserve band.
	it("keeps when weekly headroom is at or above the reserve threshold", () => {
		expect(
			resolvePoolLivenessDemotion(
				reservedCapacity(NON_PROTECTED),
				3,
				NOW,
				opts(),
			),
		).toBe(false);
		expect(
			resolvePoolLivenessDemotion(
				reservedCapacity(NON_PROTECTED + 20),
				3,
				NOW,
				opts(),
			),
		).toBe(false);
	});

	// Rule 4 — pool-aware: with nobody to hand traffic to, this account is needed.
	it("keeps when there is no absorbable peer (nothing to fail over to)", () => {
		expect(
			resolvePoolLivenessDemotion(reservedCapacity(), 0, NOW, opts()),
		).toBe(false);
	});

	// Rule 5 — the release horizon needs a known binding weekly reset.
	it("keeps when the binding weekly reset is unknown (fail open)", () => {
		expect(
			resolvePoolLivenessDemotion(
				capacity({ weeklyHeadroom: 5, bindingWeeklyResetMs: null }),
				3,
				NOW,
				opts(),
			),
		).toBe(false);
		expect(
			resolvePoolLivenessDemotion(
				capacity({ weeklyHeadroom: 5, bindingWeeklyResetMs: Number.NaN }),
				3,
				NOW,
				opts(),
			),
		).toBe(false);
	});

	// Rule 6 — release the reserve before the weekly resets so the tail is spent.
	it("keeps once the binding weekly reset is inside the release horizon", () => {
		// At the horizon: the comparison is `<=`, so a reset exactly at (here: one
		// whole ms inside, avoiding a float-boundary assertion) already releases.
		const staticHorizon =
			(NON_PROTECTED / LIVENESS_DESIGN_SLOPE_PCT_PER_HOUR) * HOUR;
		expect(
			resolvePoolLivenessDemotion(
				capacity({
					weeklyHeadroom: 5,
					bindingWeeklyResetMs: NOW + Math.floor(staticHorizon),
				}),
				3,
				NOW,
				opts(),
			),
		).toBe(false);
		// One ms past it, the reserve is still active.
		expect(
			resolvePoolLivenessDemotion(
				capacity({
					weeklyHeadroom: 5,
					bindingWeeklyResetMs: NOW + Math.ceil(staticHorizon),
				}),
				3,
				NOW,
				opts(),
			),
		).toBe(true);
		// Well inside the horizon.
		expect(
			resolvePoolLivenessDemotion(
				capacity({ weeklyHeadroom: 5, bindingWeeklyResetMs: NOW + 60_000 }),
				3,
				NOW,
				opts(),
			),
		).toBe(false);
		// A reset already in the past also releases.
		expect(
			resolvePoolLivenessDemotion(
				capacity({ weeklyHeadroom: 5, bindingWeeklyResetMs: NOW - 60_000 }),
				3,
				NOW,
				opts(),
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
				opts(),
			),
		).toBe(true);
	});
});

describe("per-tier reserve band", () => {
	it("demotes a NON-protected request at 15% weekly headroom but KEEPS a protected one", () => {
		const cap = reservedCapacity(15);
		expect(
			resolvePoolLivenessDemotion(
				cap,
				1,
				NOW,
				opts({ reserveThresholdPct: NON_PROTECTED }),
			),
		).toBe(true);
		// Fable may spend into the 10–20% band; only below 10% is it held back.
		expect(
			resolvePoolLivenessDemotion(
				cap,
				1,
				NOW,
				opts({ reserveThresholdPct: PROTECTED }),
			),
		).toBe(false);
	});

	it("demotes a protected request only below the protected threshold", () => {
		expect(
			resolvePoolLivenessDemotion(
				reservedCapacity(5),
				1,
				NOW,
				opts({ reserveThresholdPct: PROTECTED }),
			),
		).toBe(true);
	});

	it("keeps the band complementary WITHIN each tier (no dead zone)", () => {
		for (const threshold of [PROTECTED, NON_PROTECTED]) {
			const justBelow = threshold - 0.01;

			// Just below the tier threshold → reserved…
			expect(
				resolvePoolLivenessDemotion(
					reservedCapacity(justBelow),
					1,
					NOW,
					opts({ reserveThresholdPct: threshold }),
				),
			).toBe(true);
			// …and NOT absorbable as a peer at that tier.
			expect(
				isAbsorbablePeer(
					capacity({ minHeadroom: justBelow }),
					false,
					false,
					threshold,
				),
			).toBe(false);

			// Exactly at the threshold → kept…
			expect(
				resolvePoolLivenessDemotion(
					reservedCapacity(threshold),
					1,
					NOW,
					opts({ reserveThresholdPct: threshold }),
				),
			).toBe(false);
			// …and absorbable. Nothing falls between the two.
			expect(
				isAbsorbablePeer(
					capacity({ minHeadroom: threshold }),
					false,
					false,
					threshold,
				),
			).toBe(true);
		}
	});
});

describe("burn-aware release horizon", () => {
	/** Reserve is active iff the binding reset lies beyond the release horizon. */
	const demotesWithResetIn = (
		resetInMs: number,
		weeklyHeadroom: number,
		slope: number | null,
		threshold = NON_PROTECTED,
	) =>
		resolvePoolLivenessDemotion(
			capacity({ weeklyHeadroom, bindingWeeklyResetMs: NOW + resetInMs }),
			1,
			NOW,
			{ reserveThresholdPct: threshold, weeklySlopePctPerHour: slope },
		);

	it("sizes the horizon on the observed slope (a ~20% tail at 1.13 %/h ⇒ ~17.6h)", () => {
		// The band is `< 20`, so the deepest non-protected tail is just under 20%:
		// 19.9 / 1.13 ≈ 17.61h — inside it the reserve releases, beyond it it holds.
		expect(demotesWithResetIn(17 * HOUR, 19.9, 1.13)).toBe(false);
		expect(demotesWithResetIn(18 * HOUR, 19.9, 1.13)).toBe(true);
	});

	it("pegs a tiny positive slope at the 36h max clamp", () => {
		// 19.9 / 0.01 = 1990h, far past the clamp: a well-reserved account's own
		// slope collapses, so bounded early release is deliberate.
		expect(demotesWithResetIn(35 * HOUR, 19.9, 0.01)).toBe(false);
		expect(demotesWithResetIn(37 * HOUR, 19.9, 0.01)).toBe(true);
	});

	it("enforces the 12h floor for an implausibly fast burn", () => {
		// 5 / 100 = 0.05h — the floor keeps a spike from collapsing the horizon.
		expect(demotesWithResetIn(11 * HOUR, 5, 100)).toBe(false);
		expect(demotesWithResetIn(13 * HOUR, 5, 100)).toBe(true);
	});

	it("falls back to the tier-scaled static horizon when the slope is absent", () => {
		// Non-protected: 20 / 0.66 ≈ 30.3h.
		expect(demotesWithResetIn(30 * HOUR, 5, null)).toBe(false);
		expect(demotesWithResetIn(31 * HOUR, 5, null)).toBe(true);
		// Protected: 10 / 0.66 ≈ 15.2h.
		expect(demotesWithResetIn(15 * HOUR, 5, null, PROTECTED)).toBe(false);
		expect(demotesWithResetIn(16 * HOUR, 5, null, PROTECTED)).toBe(true);
	});

	it("falls back to the static horizon for a flat/negative or non-finite slope", () => {
		for (const slope of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(demotesWithResetIn(30 * HOUR, 5, slope)).toBe(false);
			expect(demotesWithResetIn(31 * HOUR, 5, slope)).toBe(true);
		}
	});

	it("shortens the horizon under pool pressure (a high slope holds the reserve longer)", () => {
		// The same reset instant: with a fast burn (18 / 1.5 = 12h) the account still
		// has time to drain, so the reserve keeps holding; with no evidence the
		// 30.3h static horizon has already released it. This is the pool-pressure
		// behavior the design relies on.
		expect(demotesWithResetIn(20 * HOUR, 18, 1.5)).toBe(true);
		expect(demotesWithResetIn(20 * HOUR, 18, null)).toBe(false);
	});
});

describe("isAbsorbablePeer", () => {
	it("counts a peer with capacity at/above the deciding account's threshold", () => {
		expect(
			isAbsorbablePeer(
				capacity({ minHeadroom: NON_PROTECTED }),
				false,
				false,
				NON_PROTECTED,
			),
		).toBe(true);
	});

	it("does not count a peer with null (stale/unknown) capacity", () => {
		expect(isAbsorbablePeer(null, false, false, NON_PROTECTED)).toBe(false);
	});

	it("does not count a peer whose minHeadroom is not finite", () => {
		expect(
			isAbsorbablePeer(
				capacity({ minHeadroom: Number.NaN }),
				false,
				false,
				NON_PROTECTED,
			),
		).toBe(false);
	});

	it("does not count a peer below the threshold", () => {
		expect(
			isAbsorbablePeer(
				capacity({ minHeadroom: NON_PROTECTED - 0.01 }),
				false,
				false,
				NON_PROTECTED,
			),
		).toBe(false);
	});

	it("judges peers by the DECIDING account's tier", () => {
		// 15% headroom: absorbable for a protected decision (threshold 10), not for
		// a non-protected one (threshold 20).
		const peer = capacity({ minHeadroom: 15 });
		expect(isAbsorbablePeer(peer, false, false, PROTECTED)).toBe(true);
		expect(isAbsorbablePeer(peer, false, false, NON_PROTECTED)).toBe(false);
	});

	it("uses minHeadroom, not weeklyHeadroom — a spent 5h peer cannot absorb", () => {
		// Plenty of weekly quota but its 5h session is spent: this is precisely the
		// failover case the reserve exists to survive, so it must not count.
		expect(
			isAbsorbablePeer(
				capacity({ minHeadroom: 0, sessionHeadroom: 0, weeklyHeadroom: 90 }),
				false,
				false,
				NON_PROTECTED,
			),
		).toBe(false);
	});

	it("does not count a peer the family-reservation gate is holding", () => {
		expect(isAbsorbablePeer(capacity(), true, false, NON_PROTECTED)).toBe(
			false,
		);
	});

	it("does not count a peer that owes a capacity-restored recovery probe", () => {
		expect(isAbsorbablePeer(capacity(), false, true, NON_PROTECTED)).toBe(
			false,
		);
	});
});

describe("incident replay: fail-open while the pool is degraded", () => {
	it("keeps every account while all peers are below the threshold, and resumes demoting once one recovers", () => {
		// Three accounts, all inside the reserve band with far weekly resets (the
		// weekly tail is what binds, so minHeadroom tracks it): nobody can absorb,
		// so rule 4 fails the reserve open for each of them.
		const degraded = (headroom: number) =>
			capacity({
				minHeadroom: headroom,
				weeklyHeadroom: headroom,
				bindingWeeklyResetMs: farWeeklyReset,
			});
		const pool = [
			{ id: "a", cap: degraded(4) },
			{ id: "b", cap: degraded(6) },
			{ id: "c", cap: degraded(8) },
		];
		const absorbablePeers = (
			self: string,
			accounts: Array<{ id: string; cap: CapacitySignal }>,
		) =>
			accounts.filter(
				(p) =>
					p.id !== self && isAbsorbablePeer(p.cap, false, false, NON_PROTECTED),
			).length;

		for (const account of pool) {
			expect(
				resolvePoolLivenessDemotion(
					account.cap,
					absorbablePeers(account.id, pool),
					NOW,
					opts(),
				),
			).toBe(false);
		}

		// "c" recovers past the threshold (weekly reset landed): the other two are
		// reserved again, and the healthy one keeps serving.
		const recovered = [
			pool[0],
			pool[1],
			{ id: "c", cap: capacity({ minHeadroom: 90, weeklyHeadroom: 90 }) },
		];
		expect(
			resolvePoolLivenessDemotion(
				recovered[0].cap,
				absorbablePeers("a", recovered),
				NOW,
				opts(),
			),
		).toBe(true);
		expect(
			resolvePoolLivenessDemotion(
				recovered[1].cap,
				absorbablePeers("b", recovered),
				NOW,
				opts(),
			),
		).toBe(true);
		expect(
			resolvePoolLivenessDemotion(
				recovered[2].cap,
				absorbablePeers("c", recovered),
				NOW,
				opts(),
			),
		).toBe(false);
	});
});
