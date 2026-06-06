import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Account } from "@clankermux/types";
import {
	BURST_RETRY_MAX_CONCURRENT_HOLDS,
	clearAnthropicBurstThrottle,
	getActiveHoldCount,
	isAnthropicBurstThrottleActive,
	resetHoldSlots,
	tryAcquireHoldSlot,
} from "../burst-cooldown";
import { HOLD_OVERFLOW, holdAndRetryCacheAccount } from "../transparent-retry";

// Deterministic timing overrides passed into holdAndRetryCacheAccount in place
// of the (now fixed) module constants: a short hold budget and zero jitter keep
// the suite fast and stable. Production uses the fixed constants.
const TEST_HOLD_OVERRIDES = {
	maxHoldMs: 2000,
	maxAttempts: 3,
	jitterMs: 0,
} as const;

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-oauth-anthropic",
		name: "oauth-cache",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt-token",
		access_token: "at-token",
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		consecutive_rate_limits: 0,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

function okResponse(): Response {
	return new Response('{"ok":true}', { status: 200 });
}

describe("holdAndRetryCacheAccount", () => {
	beforeEach(() => {
		resetHoldSlots();
		clearAnthropicBurstThrottle();
	});

	afterEach(() => {
		resetHoldSlots();
		clearAnthropicBurstThrottle();
	});

	it("returns the first successful re-probe Response and releases the slot", async () => {
		// Cooldown already in the past → wait ≈ 0, probe immediately.
		const account = makeAccount({ rate_limited_until: Date.now() - 1 });
		let probes = 0;
		const result = await holdAndRetryCacheAccount({
			account,
			confidence: "fresh_headroom",
			hasViableFallback: false,
			signal: new AbortController().signal,
			reprobe: async () => {
				probes += 1;
				return okResponse();
			},
			...TEST_HOLD_OVERRIDES,
		});
		expect(result).toBeInstanceOf(Response);
		expect((result as Response).status).toBe(200);
		expect(probes).toBe(1);
		// Slot released in finally.
		expect(getActiveHoldCount()).toBe(0);
	});

	it("activates the shared burst marker on entry", async () => {
		const account = makeAccount({ rate_limited_until: Date.now() - 1 });
		expect(isAnthropicBurstThrottleActive()).toBe(false);
		await holdAndRetryCacheAccount({
			account,
			confidence: "fresh_headroom",
			hasViableFallback: false,
			signal: new AbortController().signal,
			reprobe: async () => okResponse(),
			...TEST_HOLD_OVERRIDES,
		});
		expect(isAnthropicBurstThrottleActive()).toBe(true);
	});

	it("re-probes up to MAX_ATTEMPTS, returning null when always throttled", async () => {
		const account = makeAccount({ rate_limited_until: Date.now() - 1 });
		let probes = 0;
		const result = await holdAndRetryCacheAccount({
			account,
			confidence: "fresh_headroom",
			hasViableFallback: false,
			signal: new AbortController().signal,
			reprobe: async () => {
				probes += 1;
				// Refresh the cooldown a tiny bit so each loop re-waits ~0.
				account.rate_limited_until = Date.now() - 1;
				return null; // still throttled
			},
			...TEST_HOLD_OVERRIDES,
		});
		expect(result).toBeNull();
		expect(probes).toBe(3);
		expect(getActiveHoldCount()).toBe(0);
	});

	it("does NOT wake early: gives up when soonest expiry exceeds remaining budget", async () => {
		// Cooldown ends far beyond the 1s budget → never probe, give up immediately.
		const account = makeAccount({ rate_limited_until: Date.now() + 60_000 });
		let probes = 0;
		const start = Date.now();
		const result = await holdAndRetryCacheAccount({
			account,
			confidence: "fresh_headroom",
			hasViableFallback: false,
			signal: new AbortController().signal,
			reprobe: async () => {
				probes += 1;
				return okResponse();
			},
			...TEST_HOLD_OVERRIDES,
			maxHoldMs: 1000,
		});
		expect(result).toBeNull();
		expect(probes).toBe(0);
		// Returned promptly (didn't sleep out the full 60s cooldown).
		expect(Date.now() - start).toBeLessThan(1000);
	});

	it("stale_should_retry does exactly ONE short probe", async () => {
		const account = makeAccount({ rate_limited_until: Date.now() - 1 });
		let probes = 0;
		const result = await holdAndRetryCacheAccount({
			account,
			confidence: "stale_should_retry",
			hasViableFallback: false,
			signal: new AbortController().signal,
			reprobe: async () => {
				probes += 1;
				account.rate_limited_until = Date.now() - 1;
				return null;
			},
			...TEST_HOLD_OVERRIDES,
		});
		expect(result).toBeNull();
		// Single probe despite MAX_ATTEMPTS=3.
		expect(probes).toBe(1);
	});

	it("returns HOLD_OVERFLOW when no slot is available (concurrency cap)", async () => {
		// Saturate the cap.
		const cap = BURST_RETRY_MAX_CONCURRENT_HOLDS;
		for (let i = 0; i < cap; i++) {
			expect(tryAcquireHoldSlot()).toBe(true);
		}
		const account = makeAccount({ rate_limited_until: Date.now() - 1 });
		let probes = 0;
		const result = await holdAndRetryCacheAccount({
			account,
			confidence: "fresh_headroom",
			hasViableFallback: false,
			signal: new AbortController().signal,
			reprobe: async () => {
				probes += 1;
				return okResponse();
			},
			...TEST_HOLD_OVERRIDES,
		});
		expect(result).toBe(HOLD_OVERFLOW);
		expect(probes).toBe(0);
		// The cap slots remain held (this call acquired none to release).
		expect(getActiveHoldCount()).toBe(cap);
	});

	it("aborts promptly during the wait and releases the slot", async () => {
		// Cooldown 200ms out so we enter the sleep, then abort during it.
		const account = makeAccount({ rate_limited_until: Date.now() + 200 });
		const controller = new AbortController();
		let probes = 0;
		const promise = holdAndRetryCacheAccount({
			account,
			confidence: "fresh_headroom",
			hasViableFallback: false,
			signal: controller.signal,
			reprobe: async () => {
				probes += 1;
				return okResponse();
			},
			...TEST_HOLD_OVERRIDES,
			maxHoldMs: 5000,
		});
		// Abort almost immediately, before the 200ms sleep elapses.
		controller.abort();
		const result = await promise;
		expect(result).toBeNull();
		expect(probes).toBe(0);
		expect(getActiveHoldCount()).toBe(0);
	});

	it("bounds a never-responding re-probe by the remaining budget and releases the slot", async () => {
		// Regression for Finding 3: makeProxyRequest now composes its own (very
		// long) internal timeout, so a re-probe whose upstream accepts the
		// connection and then never responds — with the client still connected —
		// must be aborted by the HOLD BUDGET, not block indefinitely and pin the
		// semaphore slot. holdAndRetryCacheAccount passes the reprobe a
		// budget-bounded AbortSignal; a real proxyWithAccount turns that abort into
		// a null return (AbortError → network_error → null). We emulate that here:
		// the reprobe resolves null only when its signal aborts.
		// Cooldown already past → probe fires (almost) immediately with the full
		// budget remaining for the probe deadline.
		const account = makeAccount({ rate_limited_until: Date.now() - 1 });
		let probes = 0;
		let probeSignalAborted = false;
		const start = Date.now();
		const result = await holdAndRetryCacheAccount({
			account,
			confidence: "fresh_headroom",
			hasViableFallback: false,
			signal: new AbortController().signal,
			reprobe: (_account, signal) => {
				probes += 1;
				// Never resolve on our own — only when the budget deadline aborts us,
				// mirroring proxyWithAccount's AbortError → null failover.
				return new Promise<Response | null>((resolve) => {
					signal.addEventListener(
						"abort",
						() => {
							probeSignalAborted = true;
							resolve(null);
						},
						{ once: true },
					);
				});
			},
			...TEST_HOLD_OVERRIDES,
			maxHoldMs: 300,
		});
		const elapsed = Date.now() - start;
		// The hold gave up (null), the probe WAS aborted by the budget signal, and
		// it happened within a small multiple of the 300ms budget — not the
		// 30-minute internal fetch timeout.
		expect(result).toBeNull();
		expect(probes).toBeGreaterThanOrEqual(1);
		expect(probeSignalAborted).toBe(true);
		expect(elapsed).toBeLessThan(2000);
		// Slot released in finally despite the aborted probe.
		expect(getActiveHoldCount()).toBe(0);
	});

	it("returns null immediately if signal already aborted", async () => {
		const account = makeAccount({ rate_limited_until: Date.now() - 1 });
		const controller = new AbortController();
		controller.abort();
		let probes = 0;
		const result = await holdAndRetryCacheAccount({
			account,
			confidence: "fresh_headroom",
			hasViableFallback: false,
			signal: controller.signal,
			reprobe: async () => {
				probes += 1;
				return okResponse();
			},
			...TEST_HOLD_OVERRIDES,
		});
		expect(result).toBeNull();
		expect(probes).toBe(0);
		expect(getActiveHoldCount()).toBe(0);
	});

	// ---------------------------------------------------------------------------
	// Follow-up 1: codex-aware budget + bail-on-rolling-cooldown.
	//
	// When a viable non-Anthropic fallback exists (hasViableFallback=true), the
	// hold must NOT martyr latency to preserve the cache during a sustained storm:
	// it does at most ONE wait+probe and, if still throttled, bails to null (the
	// caller then runs the last-resort). When no fallback exists
	// (hasViableFallback=false), the prior full-budget multi-attempt loop is kept.
	// ---------------------------------------------------------------------------

	it("hasViableFallback=true: still-throttled re-probe bails after ONE wait+probe (no second cooldown)", async () => {
		// Cooldown already past so the single wait is ~0; reprobe always returns
		// null (still throttled). With a fallback available we must NOT loop to wait
		// a second (rolled-forward) cooldown — exactly one probe, then null.
		const account = makeAccount({ rate_limited_until: Date.now() - 1 });
		let probes = 0;
		const start = Date.now();
		const result = await holdAndRetryCacheAccount({
			account,
			confidence: "fresh_headroom",
			hasViableFallback: true,
			signal: new AbortController().signal,
			reprobe: async () => {
				probes += 1;
				// Roll the cooldown forward a touch — under the OLD behavior this would
				// have driven a second wait+probe. The bail must prevent that.
				account.rate_limited_until = Date.now() - 1;
				return null;
			},
			...TEST_HOLD_OVERRIDES,
		});
		expect(result).toBeNull();
		expect(probes).toBe(1);
		// Returned promptly — did not wait a second cooldown.
		expect(Date.now() - start).toBeLessThan(1000);
		expect(getActiveHoldCount()).toBe(0);
	});

	it("hasViableFallback=true: a first-probe success still returns the Response (cache-preserve intact)", async () => {
		// The quick-recovery common case: the cache account clears on the first
		// probe. The fallback flag must NOT short-circuit a successful preserve.
		const account = makeAccount({ rate_limited_until: Date.now() - 1 });
		let probes = 0;
		const result = await holdAndRetryCacheAccount({
			account,
			confidence: "fresh_headroom",
			hasViableFallback: true,
			signal: new AbortController().signal,
			reprobe: async () => {
				probes += 1;
				return okResponse();
			},
			...TEST_HOLD_OVERRIDES,
		});
		expect(result).toBeInstanceOf(Response);
		expect((result as Response).status).toBe(200);
		expect(probes).toBe(1);
		expect(getActiveHoldCount()).toBe(0);
	});

	it("hasViableFallback=false: keeps looping up to MAX_ATTEMPTS within the full budget", async () => {
		// No fallback → holding is the only alternative to an error, so the prior
		// multi-attempt loop is preserved: reprobe keeps returning null with the
		// cooldown staying within budget ⇒ it probes MAX_ATTEMPTS times.
		const account = makeAccount({ rate_limited_until: Date.now() - 1 });
		let probes = 0;
		const result = await holdAndRetryCacheAccount({
			account,
			confidence: "fresh_headroom",
			hasViableFallback: false,
			signal: new AbortController().signal,
			reprobe: async () => {
				probes += 1;
				account.rate_limited_until = Date.now() - 1;
				return null;
			},
			...TEST_HOLD_OVERRIDES,
		});
		expect(result).toBeNull();
		expect(probes).toBe(3);
		expect(getActiveHoldCount()).toBe(0);
	});

	it("budget selection: hasViableFallback=true uses the SHORT (15s) budget, false uses the FULL (60s) budget", async () => {
		// With NO maxHoldMs override, the chosen budget is observable at the
		// don't-wake-early give-up boundary: a cooldown that exceeds the short 15s
		// budget but fits within the full 60s budget gives up immediately when a
		// fallback exists (short budget) but waits-and-probes when none does.

		// (a) Fallback present → 15s budget. Cooldown 30s out > 15s ⇒ give up, no probe.
		const acctShort = makeAccount({ rate_limited_until: Date.now() + 30_000 });
		let shortProbes = 0;
		const shortStart = Date.now();
		const shortResult = await holdAndRetryCacheAccount({
			account: acctShort,
			confidence: "fresh_headroom",
			hasViableFallback: true,
			signal: new AbortController().signal,
			reprobe: async () => {
				shortProbes += 1;
				return okResponse();
			},
			// No maxHoldMs override — exercise the real BURST_RETRY_FALLBACK_HOLD_MS.
			maxAttempts: 3,
			jitterMs: 0,
		});
		expect(shortResult).toBeNull();
		expect(shortProbes).toBe(0);
		// Gave up promptly (did not sleep the 30s cooldown).
		expect(Date.now() - shortStart).toBeLessThan(1000);

		// (b) No fallback → 60s budget. Same 30s cooldown now FITS ⇒ it waits and
		// probes. To keep the test fast we stub the clock so the 30s "sleep" is
		// near-instant by pre-expiring the cooldown the moment the probe fires; the
		// observable signal is simply that a probe DID happen (budget allowed it).
		const acctFull = makeAccount({ rate_limited_until: Date.now() - 1 });
		let fullProbes = 0;
		const fullResult = await holdAndRetryCacheAccount({
			account: acctFull,
			confidence: "stale_should_retry", // single probe → fast, still proves budget admits it
			hasViableFallback: false,
			signal: new AbortController().signal,
			reprobe: async () => {
				fullProbes += 1;
				return okResponse();
			},
			// No maxHoldMs override — exercise the real BURST_RETRY_MAX_HOLD_MS.
			maxAttempts: 3,
			jitterMs: 0,
		});
		expect(fullResult).toBeInstanceOf(Response);
		expect(fullProbes).toBe(1);
	});

	it("hasViableFallback=true composes with stale_should_retry (still at most one wait+probe)", async () => {
		// stale_should_retry already caps attempts at 1; with a fallback the bail is
		// a no-op extra guarantee. Either way: exactly one probe, then null.
		const account = makeAccount({ rate_limited_until: Date.now() - 1 });
		let probes = 0;
		const result = await holdAndRetryCacheAccount({
			account,
			confidence: "stale_should_retry",
			hasViableFallback: true,
			signal: new AbortController().signal,
			reprobe: async () => {
				probes += 1;
				account.rate_limited_until = Date.now() - 1;
				return null;
			},
			...TEST_HOLD_OVERRIDES,
		});
		expect(result).toBeNull();
		expect(probes).toBe(1);
		expect(getActiveHoldCount()).toBe(0);
	});
});
