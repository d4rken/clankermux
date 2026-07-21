/**
 * Integration tests for the transparent overload hold (Stage D).
 *
 * When EVERY candidate for a request is overload-gated (the zero-available
 * terminal) or every attempt was suppressed behind an in-flight half-open
 * probe (the suppressed-exhaustion terminal), the proxy no longer bounces a
 * synthetic 529 straight to the client. It holds the live connection —
 * bounded by OVERLOAD_HOLD_MAX_MS and capped per overload bucket — and serves
 * the request when the family recovers. Beyond-budget cooldowns, holder-cap
 * overflow, and budget expiry keep the existing synthetic-529 shape.
 */

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from "bun:test";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import {
	getActiveOverloadHoldCount,
	OVERLOAD_HOLD_MAX_CONCURRENT_PER_BUCKET,
	resetOverloadHoldSlots,
	tryAcquireOverloadHoldSlot,
} from "../overload-hold";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
	completeProviderOverloadProbe,
	getOverloadHoldSlotKey,
	inspectProviderOverload,
	type OverloadProbeToken,
	tryAcquireProviderOverloadProbe,
} from "../provider-overload-cooldown";

async function callHandleProxy(req: Request, url: URL, ctx: ProxyContext) {
	const { handleProxy } = await import("../proxy");
	return handleProxy(req, url, ctx);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "Main-me",
		provider: "anthropic",
		api_key: "test-key",
		refresh_token: null,
		access_token: null,
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
		codex_auto_apply_reset_credits_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	} as Account;
}

function makeContext(accounts: Account[]): ProxyContext {
	return {
		strategy: {
			select: (accs: Account[]) => {
				const now = Date.now();
				return accs.filter(
					(acc) =>
						!acc.paused &&
						(!acc.rate_limited_until || acc.rate_limited_until <= now),
				);
			},
		} as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getAccount: mock(
				async (id: string) => accounts.find((a) => a.id === id) ?? null,
			),
			getActiveComboForFamily: mock(async () => null),
			markAccountRateLimited: mock(async () => 1),
			markAccountRateLimitedDeadlineOnly: mock(async () => {}),
			saveRequest: mock(async () => {}),
			updateAccountUsage: mock(async () => {}),
			updateAccountRateLimitMeta: mock(async () => {}),
			resetConsecutiveRateLimits: mock(async () => {}),
			getAdapter: mock(() => ({
				run: mock(async () => {}),
				get: mock(async () => null),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getCacheWarmingEnabled: () => false,
			getCacheWarmingMinTokens: () => 100_000,
			getStorePayloads: () => false,
		} as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://api.anthropic.com/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
		requestRecorder: {
			begin: mock(() => {}),
			captureResponseChunk: mock(() => {}),
			finishTransport: mock(() => {}),
			attachUsageSummary: mock(() => {}),
			markUsageUnavailable: mock(() => {}),
			recordSynthetic: mock(() => {}),
			sweep: mock(() => {}),
			dispose: mock(() => {}),
		} as never,
	};
}

function modelRequest(model: string, signal?: AbortSignal): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
		signal,
	});
}

function ok200(model: string) {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			model,
			stop_reason: "end_turn",
			usage: { input_tokens: 10, output_tokens: 5 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `cond` is true (bounded) — avoids racy fixed sleeps. */
async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitFor: condition not met within timeout");
		}
		await sleep(5);
	}
}

const MODEL = "claude-haiku-4-5";

/** Trip the anthropic:haiku bucket, then wait for it to become half-open. */
async function tripToHalfOpen(): Promise<void> {
	applyProviderOverloadCooldown("anthropic", Date.now() + 5, MODEL);
	await sleep(15);
	expect(inspectProviderOverload("anthropic", MODEL).state).toBe("half-open");
}

/** Lease the half-open bucket's probe as an external (non-request) holder. */
function leaseProbeExternally(): OverloadProbeToken {
	const admission = tryAcquireProviderOverloadProbe("anthropic", MODEL);
	if (!admission.admitted || !admission.token) {
		throw new Error("expected an admitted probe with a token");
	}
	return admission.token;
}

describe("transparent overload hold", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeAll(async () => {
		// Warm the proxy module graph so the first in-test request doesn't spend
		// its concurrency window inside the dynamic import.
		await import("../proxy");
	});

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
		resetOverloadHoldSlots();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
		resetOverloadHoldSlots();
	});

	it("holds a fully overload-gated request and serves it when the breaker expires", async () => {
		let fetchCalls = 0;
		globalThis.fetch = mock(async () => {
			fetchCalls++;
			return ok200(MODEL);
		}) as never;

		// Open for ~400ms — well within the hold budget.
		applyProviderOverloadCooldown("anthropic", Date.now() + 400, MODEL);
		const ctx = makeContext([makeAccount()]);
		const recordSynthetic = (
			ctx.requestRecorder as { recordSynthetic: ReturnType<typeof mock> }
		).recordSynthetic;

		const res = await callHandleProxy(
			modelRequest(MODEL),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// Served transparently after the breaker expired — no synthetic 529.
		expect(res.status).toBe(200);
		expect(fetchCalls).toBe(1);
		expect(recordSynthetic).not.toHaveBeenCalled();
		expect(inspectProviderOverload("anthropic", MODEL).state).toBe("closed");
	}, 10_000);

	it("returns an immediate 529 when the cooldown is beyond the hold budget", async () => {
		let fetchCalls = 0;
		globalThis.fetch = mock(async () => {
			fetchCalls++;
			return ok200(MODEL);
		}) as never;

		// 200s out — beyond the 120s budget → no hold, current behavior.
		applyProviderOverloadCooldown("anthropic", Date.now() + 200_000, MODEL);
		const ctx = makeContext([makeAccount()]);

		const started = Date.now();
		const res = await callHandleProxy(
			modelRequest(MODEL),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(529);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(fetchCalls).toBe(0);
		const retryAfter = Number(res.headers.get("Retry-After"));
		expect(retryAfter).toBeGreaterThan(150);
		expect(retryAfter).toBeLessThanOrEqual(200);
	});

	it("overflows to an immediate 529 when the bucket's holder cap is saturated", async () => {
		let fetchCalls = 0;
		globalThis.fetch = mock(async () => {
			fetchCalls++;
			return ok200(MODEL);
		}) as never;

		// Within-budget cooldown (would hold) …
		applyProviderOverloadCooldown("anthropic", Date.now() + 60_000, MODEL);
		// … but the bucket's slots are all taken.
		const slotKey = getOverloadHoldSlotKey("anthropic", MODEL);
		for (let i = 0; i < OVERLOAD_HOLD_MAX_CONCURRENT_PER_BUCKET; i++) {
			expect(tryAcquireOverloadHoldSlot(slotKey)).toBe(true);
		}
		const ctx = makeContext([makeAccount()]);

		const started = Date.now();
		const res = await callHandleProxy(
			modelRequest(MODEL),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(529);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(fetchCalls).toBe(0);
		// The overflowed request must not have leaked a slot.
		expect(getActiveOverloadHoldCount(slotKey)).toBe(
			OVERLOAD_HOLD_MAX_CONCURRENT_PER_BUCKET,
		);
	});

	it("a holder behind an in-flight probe serves promptly when the probe recovers", async () => {
		let fetchCalls = 0;
		let releaseProbe: (r: Response) => void = () => {};
		const probeGate = new Promise<Response>((resolve) => {
			releaseProbe = resolve;
		});
		globalThis.fetch = mock(async () => {
			fetchCalls++;
			if (fetchCalls === 1) return probeGate;
			return ok200(MODEL);
		}) as never;

		await tripToHalfOpen();
		const ctx = makeContext([makeAccount()]);

		// Request 1 becomes the probe and parks in the upstream fetch.
		const p1 = callHandleProxy(
			modelRequest(MODEL),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		await waitFor(() => fetchCalls === 1);

		// Request 2 is suppressed by admission and enters the hold (no upstream
		// hit, no immediate 529).
		const p2 = callHandleProxy(
			modelRequest(MODEL),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		await sleep(100);
		expect(fetchCalls).toBe(1);

		// Probe succeeds → bucket closes → the holder wakes and serves.
		const holderServedBy = Date.now();
		releaseProbe(ok200(MODEL));
		const res1 = await p1;
		expect(res1.status).toBe(200);
		const res2 = await p2;
		expect(res2.status).toBe(200);
		expect(fetchCalls).toBe(2);
		// Promptly — one probe-poll interval, nowhere near the 120s budget.
		expect(Date.now() - holderServedBy).toBeLessThan(8_000);
	}, 15_000);

	it("exits the hold with the fresh Retry-After when the breaker re-trips beyond the remaining budget", async () => {
		let fetchCalls = 0;
		globalThis.fetch = mock(async () => {
			fetchCalls++;
			return ok200(MODEL);
		}) as never;

		await tripToHalfOpen();
		// An external holder owns the probe, so the request's attempts are
		// suppressed and it holds.
		const token = leaseProbeExternally();
		const ctx = makeContext([makeAccount()]);

		const p = callHandleProxy(
			modelRequest(MODEL),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		await sleep(300);
		// Concurrent re-trip lands a cooldown far beyond the remaining budget.
		applyProviderOverloadCooldown("anthropic", Date.now() + 200_000, MODEL);

		const res = await p;
		expect(res.status).toBe(529);
		expect(fetchCalls).toBe(0);
		// Retry-After reflects the FRESH ~200s cooldown, not the stale pre-hold
		// deadline.
		const retryAfter = Number(res.headers.get("Retry-After"));
		expect(retryAfter).toBeGreaterThan(150);
		expect(retryAfter).toBeLessThanOrEqual(200);
		// Late completion of the invalidated lease is a harmless no-op.
		completeProviderOverloadProbe(token, "abandoned");
	}, 15_000);

	it("releases the hold slot when the client aborts mid-hold", async () => {
		let fetchCalls = 0;
		globalThis.fetch = mock(async () => {
			fetchCalls++;
			return ok200(MODEL);
		}) as never;

		applyProviderOverloadCooldown("anthropic", Date.now() + 60_000, MODEL);
		const slotKey = getOverloadHoldSlotKey("anthropic", MODEL);
		const ctx = makeContext([makeAccount()]);

		const controller = new AbortController();
		const p = callHandleProxy(
			modelRequest(MODEL, controller.signal),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		await waitFor(() => getActiveOverloadHoldCount(slotKey) === 1);
		controller.abort();

		const res = await p;
		expect(res.status).toBe(499);
		expect(fetchCalls).toBe(0);
		// The slot is released, so a subsequent request can hold.
		expect(getActiveOverloadHoldCount(slotKey)).toBe(0);
		expect(tryAcquireOverloadHoldSlot(slotKey)).toBe(true);
	}, 10_000);

	it("holds at the suppressed-exhaustion terminal and serves once the probe reports recovery", async () => {
		let fetchCalls = 0;
		globalThis.fetch = mock(async () => {
			fetchCalls++;
			return ok200(MODEL);
		}) as never;

		await tripToHalfOpen();
		const token = leaseProbeExternally();
		const ctx = makeContext([makeAccount()]);

		// Every attempt is suppressed behind the external probe → the request
		// exhausts the loop suppressed-only and holds instead of 529ing.
		const p = callHandleProxy(
			modelRequest(MODEL),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		await sleep(200);
		expect(fetchCalls).toBe(0);

		// The external probe reports recovery → bucket closes → the holder's
		// next poll attempt is admitted and serves.
		completeProviderOverloadProbe(token, "recovered");
		const res = await p;
		expect(res.status).toBe(200);
		expect(fetchCalls).toBe(1);
	}, 15_000);
});
