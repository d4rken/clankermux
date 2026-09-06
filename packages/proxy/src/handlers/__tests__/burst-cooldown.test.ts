import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Logger } from "@clankermux/logger";
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

describe("burst cooldown", () => {
	beforeEach(() => {
		clearAnthropicBurstThrottle();
		resetHoldSlots();
	});

	afterEach(() => {
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
			// Default marker lifetime is 120_000ms (BURST_RETRY_MARKER_MS in
			// burst-cooldown.ts), measured from upstream evidence, not hold entry.
			const now = 1_700_000_000_000;
			markAnthropicBurstThrottle(now);

			const until = getAnthropicBurstThrottleUntil(now);
			expect(until).toBe(now + 120_000);
			expect(isAnthropicBurstThrottleActive(now)).toBe(true);

			// Still active just before expiry.
			expect(isAnthropicBurstThrottleActive(now + 119_999)).toBe(true);

			// At/after expiry ⇒ inactive (lazy clear).
			expect(getAnthropicBurstThrottleUntil(now + 120_000)).toBeNull();
			expect(isAnthropicBurstThrottleActive(now + 120_001)).toBe(false);
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
			// A later mark pushes the deadline forward (now + 10_000 + 120_000).
			markAnthropicBurstThrottle(now + 10_000);
			expect(getAnthropicBurstThrottleUntil(now)).toBe(now + 130_000);

			// An earlier mark (e.g. concurrent request with a slightly stale clock)
			// does NOT pull the deadline back in.
			markAnthropicBurstThrottle(now + 5_000);
			expect(getAnthropicBurstThrottleUntil(now)).toBe(now + 130_000);
		});

		it("respects the injectable markerMs override", () => {
			const now = 1_700_000_000_000;
			markAnthropicBurstThrottle(now, 30_000);

			expect(getAnthropicBurstThrottleUntil(now)).toBe(now + 30_000);
			expect(isAnthropicBurstThrottleActive(now + 29_999)).toBe(true);
			expect(isAnthropicBurstThrottleActive(now + 30_000)).toBe(false);
		});

		it("logs one warning per activation and bounded summaries with observation counts", () => {
			const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
			const info = spyOn(Logger.prototype, "info").mockImplementation(() => {});
			try {
				const now = 1_700_000_000_000;
				markAnthropicBurstThrottle(now);
				for (let i = 1; i < 30; i++) {
					markAnthropicBurstThrottle(now + i * 1_000);
				}
				expect(warn).toHaveBeenCalledTimes(1);
				expect(info).not.toHaveBeenCalled();
				markAnthropicBurstThrottle(now + 30_000);
				expect(info).toHaveBeenCalledTimes(1);
				expect(info.mock.calls[0]?.[0]).toContain(
					"observations=31, newObservations=30",
				);
				// Backdated concurrent evidence cannot reopen the summary interval.
				markAnthropicBurstThrottle(now + 29_000);
				markAnthropicBurstThrottle(now + 59_999);
				expect(info).toHaveBeenCalledTimes(1);
				markAnthropicBurstThrottle(now + 60_000);
				expect(info).toHaveBeenCalledTimes(2);
				expect(info.mock.calls[1]?.[0]).toContain(
					"observations=34, newObservations=3",
				);
				expect(warn).toHaveBeenCalledTimes(1);
				expect(getAnthropicBurstThrottleUntil(now + 60_000)).toBe(
					now + 180_000,
				);
				// Lazy expiry emits one final summary, including unsummarized marks.
				markAnthropicBurstThrottle(now + 61_000);
				expect(isAnthropicBurstThrottleActive(now + 181_000)).toBe(false);
				expect(isAnthropicBurstThrottleActive(now + 181_001)).toBe(false);
				expect(info).toHaveBeenCalledTimes(3);
				expect(info.mock.calls[2]?.[0]).toContain(
					"expired; observations=35, newObservations=1",
				);
				expect(info.mock.calls[2]?.[0]).toContain("sibling diversion restored");
				markAnthropicBurstThrottle(now + 182_000);
				expect(warn).toHaveBeenCalledTimes(2);
				expect(warn.mock.calls[1]?.[0]).toContain("observations=1");
			} finally {
				warn.mockRestore();
				info.mockRestore();
			}
		});

		it("reactivation preserves prior counts without claiming recovery and resets new summary counts", () => {
			const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
			const info = spyOn(Logger.prototype, "info").mockImplementation(() => {});
			try {
				const now = 1_700_000_000_000;
				markAnthropicBurstThrottle(now, 100);
				markAnthropicBurstThrottle(now + 50, 100);
				markAnthropicBurstThrottle(now + 150);
				expect(warn).toHaveBeenCalledTimes(2);
				expect(info).toHaveBeenCalledTimes(1);
				expect(info.mock.calls[0]?.[0]).toContain(
					"expired before fresh evidence; observations=2, newObservations=1",
				);
				expect(info.mock.calls[0]?.[0]).not.toContain(
					"sibling diversion restored",
				);
				expect(getAnthropicBurstThrottleUntil(now + 150)).toBe(now + 120_150);
				expect(warn.mock.calls[1]?.[0]).toContain("observations=1");
				clearAnthropicBurstThrottle();
				markAnthropicBurstThrottle(now + 200);
				expect(warn).toHaveBeenCalledTimes(3);
				markAnthropicBurstThrottle(now + 30_200);
				expect(info).toHaveBeenCalledTimes(2);
				expect(info.mock.calls[1]?.[0]).toContain(
					"observations=2, newObservations=1",
				);
			} finally {
				warn.mockRestore();
				info.mockRestore();
			}
		});
	});

	describe("hold-slot concurrency semaphore", () => {
		it("acquires up to the cap (default 8) returning true, then false at cap", () => {
			// Default cap is BURST_RETRY_MAX_CONCURRENT_HOLDS = 8 (burst-cooldown.ts).
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

		it("respects an injectable maxConcurrentHolds override", () => {
			expect(tryAcquireHoldSlot(2)).toBe(true);
			expect(tryAcquireHoldSlot(2)).toBe(true);
			// Cap is 2 ⇒ the third acquire fails.
			expect(tryAcquireHoldSlot(2)).toBe(false);
			expect(getActiveHoldCount()).toBe(2);
		});

		it("reads the cap at acquire time (a raised cap frees capacity)", () => {
			expect(tryAcquireHoldSlot(1)).toBe(true);
			expect(tryAcquireHoldSlot(1)).toBe(false);

			// A higher cap passed to a later acquire lets a further acquire through —
			// the cap is evaluated per call, not cached.
			expect(tryAcquireHoldSlot(3)).toBe(true);
			expect(tryAcquireHoldSlot(3)).toBe(true);
			expect(tryAcquireHoldSlot(3)).toBe(false);
			expect(getActiveHoldCount()).toBe(3);
		});
	});
});
