import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getBurstRetryMaxConcurrentHolds } from "@clankermux/core";
import type { Account } from "@clankermux/types";
import {
	clearAnthropicBurstThrottle,
	getActiveHoldCount,
	isAnthropicBurstThrottleActive,
	resetHoldSlots,
	tryAcquireHoldSlot,
} from "../burst-cooldown";
import { HOLD_OVERFLOW, holdAndRetryCacheAccount } from "../transparent-retry";

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
		// Keep waits short and deterministic for the test run.
		process.env.CCFLARE_BURST_RETRY_MAX_HOLD_MS = "2000";
		process.env.CCFLARE_BURST_RETRY_MAX_ATTEMPTS = "3";
		process.env.CCFLARE_BURST_RETRY_JITTER_MS = "0";
		process.env.CCFLARE_BURST_RETRY_MAX_CONCURRENT = "8";
	});

	afterEach(() => {
		resetHoldSlots();
		clearAnthropicBurstThrottle();
		delete process.env.CCFLARE_BURST_RETRY_MAX_HOLD_MS;
		delete process.env.CCFLARE_BURST_RETRY_MAX_ATTEMPTS;
		delete process.env.CCFLARE_BURST_RETRY_JITTER_MS;
		delete process.env.CCFLARE_BURST_RETRY_MAX_CONCURRENT;
	});

	it("returns the first successful re-probe Response and releases the slot", async () => {
		// Cooldown already in the past → wait ≈ 0, probe immediately.
		const account = makeAccount({ rate_limited_until: Date.now() - 1 });
		let probes = 0;
		const result = await holdAndRetryCacheAccount({
			account,
			confidence: "fresh_headroom",
			signal: new AbortController().signal,
			reprobe: async () => {
				probes += 1;
				return okResponse();
			},
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
			signal: new AbortController().signal,
			reprobe: async () => okResponse(),
		});
		expect(isAnthropicBurstThrottleActive()).toBe(true);
	});

	it("re-probes up to MAX_ATTEMPTS, returning null when always throttled", async () => {
		process.env.CCFLARE_BURST_RETRY_MAX_ATTEMPTS = "3";
		const account = makeAccount({ rate_limited_until: Date.now() - 1 });
		let probes = 0;
		const result = await holdAndRetryCacheAccount({
			account,
			confidence: "fresh_headroom",
			signal: new AbortController().signal,
			reprobe: async () => {
				probes += 1;
				// Refresh the cooldown a tiny bit so each loop re-waits ~0.
				account.rate_limited_until = Date.now() - 1;
				return null; // still throttled
			},
		});
		expect(result).toBeNull();
		expect(probes).toBe(3);
		expect(getActiveHoldCount()).toBe(0);
	});

	it("does NOT wake early: gives up when soonest expiry exceeds remaining budget", async () => {
		process.env.CCFLARE_BURST_RETRY_MAX_HOLD_MS = "1000";
		// Cooldown ends far beyond the 1s budget → never probe, give up immediately.
		const account = makeAccount({ rate_limited_until: Date.now() + 60_000 });
		let probes = 0;
		const start = Date.now();
		const result = await holdAndRetryCacheAccount({
			account,
			confidence: "fresh_headroom",
			signal: new AbortController().signal,
			reprobe: async () => {
				probes += 1;
				return okResponse();
			},
		});
		expect(result).toBeNull();
		expect(probes).toBe(0);
		// Returned promptly (didn't sleep out the full 60s cooldown).
		expect(Date.now() - start).toBeLessThan(1000);
	});

	it("stale_should_retry does exactly ONE short probe", async () => {
		process.env.CCFLARE_BURST_RETRY_MAX_ATTEMPTS = "3";
		const account = makeAccount({ rate_limited_until: Date.now() - 1 });
		let probes = 0;
		const result = await holdAndRetryCacheAccount({
			account,
			confidence: "stale_should_retry",
			signal: new AbortController().signal,
			reprobe: async () => {
				probes += 1;
				account.rate_limited_until = Date.now() - 1;
				return null;
			},
		});
		expect(result).toBeNull();
		// Single probe despite MAX_ATTEMPTS=3.
		expect(probes).toBe(1);
	});

	it("returns HOLD_OVERFLOW when no slot is available (concurrency cap)", async () => {
		// Saturate the cap.
		const cap = getBurstRetryMaxConcurrentHolds();
		for (let i = 0; i < cap; i++) {
			expect(tryAcquireHoldSlot()).toBe(true);
		}
		const account = makeAccount({ rate_limited_until: Date.now() - 1 });
		let probes = 0;
		const result = await holdAndRetryCacheAccount({
			account,
			confidence: "fresh_headroom",
			signal: new AbortController().signal,
			reprobe: async () => {
				probes += 1;
				return okResponse();
			},
		});
		expect(result).toBe(HOLD_OVERFLOW);
		expect(probes).toBe(0);
		// The cap slots remain held (this call acquired none to release).
		expect(getActiveHoldCount()).toBe(cap);
	});

	it("aborts promptly during the wait and releases the slot", async () => {
		process.env.CCFLARE_BURST_RETRY_MAX_HOLD_MS = "5000";
		// Cooldown 200ms out so we enter the sleep, then abort during it.
		const account = makeAccount({ rate_limited_until: Date.now() + 200 });
		const controller = new AbortController();
		let probes = 0;
		const promise = holdAndRetryCacheAccount({
			account,
			confidence: "fresh_headroom",
			signal: controller.signal,
			reprobe: async () => {
				probes += 1;
				return okResponse();
			},
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
		process.env.CCFLARE_BURST_RETRY_MAX_HOLD_MS = "300";
		process.env.CCFLARE_BURST_RETRY_MAX_ATTEMPTS = "3";
		// Cooldown already past → probe fires (almost) immediately with the full
		// budget remaining for the probe deadline.
		const account = makeAccount({ rate_limited_until: Date.now() - 1 });
		let probes = 0;
		let probeSignalAborted = false;
		const start = Date.now();
		const result = await holdAndRetryCacheAccount({
			account,
			confidence: "fresh_headroom",
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
			signal: controller.signal,
			reprobe: async () => {
				probes += 1;
				return okResponse();
			},
		});
		expect(result).toBeNull();
		expect(probes).toBe(0);
		expect(getActiveHoldCount()).toBe(0);
	});
});
