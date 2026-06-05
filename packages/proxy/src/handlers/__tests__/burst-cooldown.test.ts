import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	clearAnthropicBurstThrottle,
	getActiveHoldCount,
	getAnthropicBurstThrottleUntil,
	isAnthropicBurstThrottleActive,
	markAnthropicBurstThrottle,
	releaseHoldSlot,
	resetHoldSlots,
	tryAcquireHoldSlot,
} from "../burst-cooldown";

// Env vars read by the burst-marker / semaphore accessors. Saved and restored
// around each test so a stray host value can't leak into a default assertion
// and tests can't pollute one another — mirrors constants.test.ts.
const BURST_ENV_VARS = [
	"CCFLARE_BURST_RETRY_MARKER_MS",
	"CCFLARE_BURST_RETRY_MAX_CONCURRENT",
] as const;

describe("burst cooldown", () => {
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of BURST_ENV_VARS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		clearAnthropicBurstThrottle();
		resetHoldSlots();
	});

	afterEach(() => {
		for (const key of BURST_ENV_VARS) {
			if (saved[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = saved[key];
			}
		}
		clearAnthropicBurstThrottle();
		resetHoldSlots();
	});

	describe("Anthropic-OAuth burst marker", () => {
		it("is inactive before any mark", () => {
			const now = 1_700_000_000_000;
			expect(getAnthropicBurstThrottleUntil(now)).toBeNull();
			expect(isAnthropicBurstThrottleActive(now)).toBe(false);
		});

		it("set ⇒ active until expiry; after expiry ⇒ null/false", () => {
			// Default marker lifetime is 60_000ms (TIME_CONSTANTS.BURST_RETRY_MARKER_MS).
			const now = 1_700_000_000_000;
			markAnthropicBurstThrottle(now);

			const until = getAnthropicBurstThrottleUntil(now);
			expect(until).toBe(now + 60_000);
			expect(isAnthropicBurstThrottleActive(now)).toBe(true);

			// Still active just before expiry.
			expect(isAnthropicBurstThrottleActive(now + 59_999)).toBe(true);

			// At/after expiry ⇒ inactive (lazy clear).
			expect(getAnthropicBurstThrottleUntil(now + 60_000)).toBeNull();
			expect(isAnthropicBurstThrottleActive(now + 60_001)).toBe(false);
		});

		it("lazily clears expired state on read", () => {
			const now = 1_700_000_000_000;
			markAnthropicBurstThrottle(now);

			// Reading past expiry clears the marker, so a subsequent earlier-now read
			// also reports inactive (state was wiped, not merely time-gated).
			expect(getAnthropicBurstThrottleUntil(now + 120_000)).toBeNull();
			expect(getAnthropicBurstThrottleUntil(now)).toBeNull();
		});

		it("clear ⇒ inactive even within the active window", () => {
			const now = 1_700_000_000_000;
			markAnthropicBurstThrottle(now);
			expect(isAnthropicBurstThrottleActive(now)).toBe(true);

			clearAnthropicBurstThrottle();
			expect(getAnthropicBurstThrottleUntil(now)).toBeNull();
			expect(isAnthropicBurstThrottleActive(now)).toBe(false);
		});

		it("extends (never shortens) an existing marker", () => {
			const now = 1_700_000_000_000;
			markAnthropicBurstThrottle(now);
			// A later mark pushes the deadline forward.
			markAnthropicBurstThrottle(now + 10_000);
			expect(getAnthropicBurstThrottleUntil(now)).toBe(now + 70_000);

			// An earlier mark (e.g. concurrent request with a slightly stale clock)
			// does NOT pull the deadline back in.
			markAnthropicBurstThrottle(now + 5_000);
			expect(getAnthropicBurstThrottleUntil(now)).toBe(now + 70_000);
		});

		it("respects getBurstRetryMarkerMs() via the env override", () => {
			process.env.CCFLARE_BURST_RETRY_MARKER_MS = "30000";
			const now = 1_700_000_000_000;
			markAnthropicBurstThrottle(now);

			expect(getAnthropicBurstThrottleUntil(now)).toBe(now + 30_000);
			expect(isAnthropicBurstThrottleActive(now + 29_999)).toBe(true);
			expect(isAnthropicBurstThrottleActive(now + 30_000)).toBe(false);
		});
	});

	describe("hold-slot concurrency semaphore", () => {
		it("acquires up to the cap (default 8) returning true, then false at cap", () => {
			// Default cap is TIME_CONSTANTS.BURST_RETRY_MAX_CONCURRENT_HOLDS = 8.
			for (let i = 0; i < 8; i++) {
				expect(tryAcquireHoldSlot()).toBe(true);
			}
			expect(getActiveHoldCount()).toBe(8);
			// At cap ⇒ next acquire fails and does not change the count.
			expect(tryAcquireHoldSlot()).toBe(false);
			expect(getActiveHoldCount()).toBe(8);
		});

		it("release frees a slot for re-acquisition", () => {
			for (let i = 0; i < 8; i++) {
				tryAcquireHoldSlot();
			}
			expect(tryAcquireHoldSlot()).toBe(false);

			releaseHoldSlot();
			expect(getActiveHoldCount()).toBe(7);
			// One slot freed ⇒ exactly one more acquire succeeds, then back at cap.
			expect(tryAcquireHoldSlot()).toBe(true);
			expect(getActiveHoldCount()).toBe(8);
			expect(tryAcquireHoldSlot()).toBe(false);
		});

		it("never decrements below 0", () => {
			expect(getActiveHoldCount()).toBe(0);
			releaseHoldSlot();
			releaseHoldSlot();
			expect(getActiveHoldCount()).toBe(0);

			// And acquire still works normally after over-release.
			expect(tryAcquireHoldSlot()).toBe(true);
			expect(getActiveHoldCount()).toBe(1);
		});

		it("reset clears all held slots", () => {
			tryAcquireHoldSlot();
			tryAcquireHoldSlot();
			expect(getActiveHoldCount()).toBe(2);

			resetHoldSlots();
			expect(getActiveHoldCount()).toBe(0);
		});

		it("respects getBurstRetryMaxConcurrentHolds() via the env override", () => {
			process.env.CCFLARE_BURST_RETRY_MAX_CONCURRENT = "2";
			expect(tryAcquireHoldSlot()).toBe(true);
			expect(tryAcquireHoldSlot()).toBe(true);
			// Cap is 2 now ⇒ the third acquire fails.
			expect(tryAcquireHoldSlot()).toBe(false);
			expect(getActiveHoldCount()).toBe(2);
		});

		it("reads the cap at acquire time (env raised mid-flight frees capacity)", () => {
			process.env.CCFLARE_BURST_RETRY_MAX_CONCURRENT = "1";
			expect(tryAcquireHoldSlot()).toBe(true);
			expect(tryAcquireHoldSlot()).toBe(false);

			// Raising the cap without re-importing the module lets a further acquire
			// through — the cap is NOT cached at module load.
			process.env.CCFLARE_BURST_RETRY_MAX_CONCURRENT = "3";
			expect(tryAcquireHoldSlot()).toBe(true);
			expect(tryAcquireHoldSlot()).toBe(true);
			expect(tryAcquireHoldSlot()).toBe(false);
			expect(getActiveHoldCount()).toBe(3);
		});
	});
});
