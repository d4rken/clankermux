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
	getOverloadHoldBudgetMs,
	OVERLOAD_HOLD_MAX_CONCURRENT_PER_BUCKET,
	OVERLOAD_HOLD_MAX_MS,
	OVERLOAD_HOLD_MAX_MS_NO_REARM,
	resetOverloadHoldSlots,
	setOverloadHoldBudgetOverrideForTests,
	tryAcquireOverloadHoldSlot,
} from "../overload-hold";
import {
	ANTHROPIC_UPSTREAM_OVERLOAD_KEY,
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
			// Read by the all-accounts-failed terminal's collision guard. Absent
			// here until a test actually reached that terminal.
			hasRecord: mock(() => false),
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

/**
 * Wrap a per-test upstream handler so unrelated background fetches — the
 * models.dev pricing-catalog refresh fired by the usage finalizer's cost
 * lookup — never reach it. Without the shunt the catalog refresh lands
 * mid-test through the mocked `globalThis.fetch`, skewing exact
 * fetch-call-count assertions (order-dependent: only when no earlier test
 * file already warmed the in-process catalog), and a mocked 200 would poison
 * the on-disk pricing cache. The 500 makes pricing fall back to its bundled
 * data.
 */
function upstreamOnlyFetch(
	handler: (input: Request | string | URL) => Response | Promise<Response>,
): typeof globalThis.fetch {
	return mock(async (input: Request | string | URL) => {
		const url = input instanceof Request ? input.url : String(input);
		if (!url.includes("api.anthropic.com")) {
			return new Response("unavailable", { status: 500 });
		}
		return handler(input);
	}) as never;
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
		setOverloadHoldBudgetOverrideForTests(null);
	});

	it("holds a fully overload-gated request and serves it when the breaker expires", async () => {
		let fetchCalls = 0;
		globalThis.fetch = upstreamOnlyFetch(async () => {
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

	it("holds a cooldown at the breaker's own 300s cap instead of fast-failing it", async () => {
		// The budget (330s) now EXCEEDS MAX_PROVIDER_OVERLOAD_COOLDOWN_MS (300s),
		// so no fresh trip can be "beyond budget" any more — every overload is
		// waited out rather than bounced. Pin that inversion: it is the whole
		// point of the budget change, and a future budget cut would silently
		// undo it.
		let fetchCalls = 0;
		globalThis.fetch = upstreamOnlyFetch(async () => {
			fetchCalls++;
			return ok200(MODEL);
		}) as never;

		// Ask for far more than the cap; the breaker clamps it to 300s.
		const until = applyProviderOverloadCooldown(
			"anthropic",
			Date.now() + 60 * 60_000,
			MODEL,
		);
		expect(until - Date.now()).toBeLessThanOrEqual(5 * 60_000);
		expect(until - Date.now()).toBeGreaterThan(4 * 60_000);
		// That clamped deadline is inside the production budget → the request
		// must ENTER the hold, not take the immediate 529 terminal.
		expect(until - Date.now()).toBeLessThan(getOverloadHoldBudgetMs(true));

		const ctx = makeContext([makeAccount()]);
		const controller = new AbortController();
		const p = callHandleProxy(
			modelRequest(MODEL, controller.signal),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		// Give it time to enter the hold, then hang up rather than wait 5 minutes.
		await sleep(300);
		expect(
			getActiveOverloadHoldCount(getOverloadHoldSlotKey("anthropic", MODEL)),
		).toBe(1);
		controller.abort();
		const res = await p;
		expect(res.status).toBe(499);
		expect(fetchCalls).toBe(0);
	}, 10_000);

	it("holds a request whose remaining candidates were gated MID-LOOP", async () => {
		// Observed in production 2026-08-24 18:43:08. A request already walking
		// its candidate list when the breaker trips has its remaining candidates
		// dropped by the loop's late overload gate. That gate skips without
		// recording anything, so `overloadSuppressedAttempts` stays empty, the
		// post-loop hold never fires, and the request falls through to
		// ALL_ACCOUNTS_FAILED — a hard 503. Two requests one second later, which
		// found zero available candidates UP FRONT, were held and served 200s.
		// Same incident, same breaker, opposite outcomes, decided purely by
		// whether the loop had already started.
		//
		// The cooldown is SHORTER than the hold budget on purpose, and attempts
		// are identified BY ACCOUNT rather than counted. Two earlier versions of
		// this test passed for the wrong reason: one paired a 60s cooldown with a
		// 300ms budget, which the holdability check rejects outright; the next
		// counted calls, and was satisfied by the hold simply RE-ATTEMPTING the
		// account that had already failed, while the gated account it was
		// supposedly waiting for was never tried at all.
		//
		// The invariant that matters: `first` fails, and the account that serves
		// the request afterwards is `second` — the one the late gate skipped.
		// Distinct credentials so each attempt is attributable on the wire. NOT
		// via a ctx.provider override: `proxyWithAccount` resolves the REAL
		// provider per account (`getProvider(account.provider)`), so ctx.provider
		// is only a fallback and overriding it does nothing for these.
		const first = makeAccount({
			id: "acc-first",
			name: "First",
			api_key: "key-first",
		});
		const second = makeAccount({
			id: "acc-second",
			name: "Second",
			api_key: "key-second",
		});

		const ctx = makeContext([first, second]);

		let letSecondFinish: () => void = () => {};
		const releaseSecond = new Promise<void>((resolve) => {
			letSecondFinish = resolve;
		});

		const attempts: string[] = [];
		globalThis.fetch = upstreamOnlyFetch(async (input) => {
			const headers = input instanceof Request ? input.headers : new Headers();
			const key =
				headers.get("x-api-key") ??
				headers.get("authorization")?.replace(/^Bearer /, "") ??
				"unknown";
			const who =
				key === "key-first" ? "First" : key === "key-second" ? "Second" : key;
			attempts.push(who);
			if (who === "First") {
				// Fails ORDINARILY, so nothing records an overload suppression. It
				// must FAIL OVER rather than be forwarded — a non-2xx response goes
				// back to the client as-is and never reaches the end of the loop —
				// so throw, as the production attempts did. Meanwhile the breaker
				// trips, as it would from another request's 529, leaving `second`
				// to be dropped by the late gate.
				applyProviderOverloadCooldown("anthropic", Date.now() + 400, MODEL);
				throw new Error("upstream connection reset");
			}
			// Park the winning attempt until the test has observed the hold slot.
			// Polling occupancy alone can MISS a real hold: under preemption the
			// hold can acquire, attempt and release between two polls, failing a
			// test whose subject is working correctly. Holding the response open
			// makes the observation window deterministic.
			await releaseSecond;
			return ok200(MODEL);
		}) as never;

		// Do NOT await yet. A cooldown short enough to keep the test fast can
		// expire before the loop's second iteration under worker preemption, in
		// which case `second` is attempted directly and the sequence below passes
		// with no hold ever entered. Observing the slot while the request is
		// pending is what distinguishes the two.
		const pending = callHandleProxy(
			modelRequest(MODEL),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		const slotKey = getOverloadHoldSlotKey("anthropic", MODEL);
		// On failure, release the parked attempt AND let the request settle before
		// rethrowing. Releasing alone is not enough: if the hold was entered, its
		// own `finally` — which frees the slot and clears the idle re-arm
		// interval — cannot run until the request completes, and `afterEach`
		// resets counters but cannot clear a live interval. Without this a failing
		// assertion leaks a timer into the rest of the file.
		try {
			await waitFor(() => getActiveOverloadHoldCount(slotKey) > 0);
		} catch (err) {
			letSecondFinish();
			await pending.catch(() => {});
			throw err;
		}
		letSecondFinish();

		const res = await pending;
		expect(res.status).toBe(200);
		// Held through the cooldown, woke, and served from the account the gate
		// had skipped — NOT by retrying the one that already failed.
		expect(attempts).toEqual(["First", "Second"]);
		// And the slot is returned afterwards.
		expect(getActiveOverloadHoldCount(slotKey)).toBe(0);
	}, 15_000);

	it("does NOT hold for a gated candidate that could never serve the path", async () => {
		// The candidate list still contains accounts that would fail over on
		// routing grounds alone: per-account path validation runs inside
		// `proxyWithAccount`, AFTER this gate. A Codex account asked for
		// /v1/chat/completions is gated by an open bucket but could never have
		// served the request, so it is not evidence that an overload blocked
		// anything. Recording it would make the request wait out a cooldown that
		// cannot help it, turning an honest fast failure into a long hold.
		//
		// The codex bucket must trip DURING the loop, not before it: an
		// already-open bucket is removed by the pre-loop gate, which empties the
		// pool and routes to the zero-accounts terminal instead — a different
		// path that never reaches the late gate this test is about.
		const anthropic = makeAccount({ id: "acc-anthropic", name: "Anthropic" });
		const codex = makeAccount({
			id: "acc-codex",
			name: "Codex",
			provider: "codex",
			api_key: null,
			access_token: "at",
			refresh_token: "rt",
			expires_at: Date.now() + 3_600_000,
		});

		let calls = 0;
		globalThis.fetch = upstreamOnlyFetch(async () => {
			calls++;
			applyProviderOverloadCooldown("codex", Date.now() + 60_000, MODEL);
			throw new Error("upstream connection reset");
		}) as never;

		const ctx = makeContext([anthropic, codex]);
		const started = Date.now();
		// The honest generic terminal, which THROWS rather than returning a
		// response — the point is that it is reached at all, and promptly.
		await expect(
			callHandleProxy(
				new Request("https://proxy.local/v1/chat/completions", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model: MODEL,
						messages: [{ role: "user", content: "hello" }],
						max_tokens: 16,
					}),
				}),
				new URL("https://proxy.local/v1/chat/completions"),
				ctx,
			),
		).rejects.toThrow(/All accounts failed/);

		// PROMPT — no hold was entered for a bucket that could not have helped.
		// Only the Anthropic account was attempted; the gated Codex one was
		// skipped and, correctly, not recorded as overload evidence.
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(calls).toBe(1);
	}, 10_000);

	it("returns an immediate 529 when the cooldown is beyond the hold budget", async () => {
		let fetchCalls = 0;
		globalThis.fetch = upstreamOnlyFetch(async () => {
			fetchCalls++;
			return ok200(MODEL);
		}) as never;

		// The breaker clamps every trip to MAX_PROVIDER_OVERLOAD_COOLDOWN_MS
		// (300s), which is BELOW the real hold budget — so with production
		// values a fresh cooldown can never be beyond budget. Shrink the budget
		// instead of picking a cooldown that outruns it, so this stays a test of
		// the beyond-budget branch rather than of a particular constant.
		setOverloadHoldBudgetOverrideForTests(30_000);
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
		globalThis.fetch = upstreamOnlyFetch(async () => {
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
		globalThis.fetch = upstreamOnlyFetch(async () => {
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
		// Promptly — one probe-poll interval, nowhere near the hold budget.
		expect(Date.now() - holderServedBy).toBeLessThan(8_000);
	}, 15_000);

	it("exits the hold with the fresh Retry-After when the breaker re-trips beyond the remaining budget", async () => {
		let fetchCalls = 0;
		globalThis.fetch = upstreamOnlyFetch(async () => {
			fetchCalls++;
			return ok200(MODEL);
		}) as never;

		// Shrink the budget for the same reason as the beyond-budget test: a real
		// trip is clamped to 300s, which now FITS inside the production budget.
		setOverloadHoldBudgetOverrideForTests(30_000);
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
		globalThis.fetch = upstreamOnlyFetch(async () => {
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

	it("aborts a hung wake fetch at the remaining hold deadline and falls back to the synthetic 529 (not 499)", async () => {
		// Short budget so the remaining-budget abort is observable in test time;
		// production keeps the fixed 120s.
		setOverloadHoldBudgetOverrideForTests(2_000);
		let fetchCalls = 0;
		globalThis.fetch = upstreamOnlyFetch((input: Request | string | URL) => {
			fetchCalls++;
			// Hang forever unless aborted — models an upstream that accepts the
			// connection and never responds (makeProxyRequest's own timeout is 30
			// minutes, far beyond the hold budget).
			return new Promise<Response>((_, reject) => {
				const signal = input instanceof Request ? input.signal : undefined;
				signal?.addEventListener("abort", () =>
					reject(new DOMException("The operation was aborted.", "AbortError")),
				);
			});
		}) as never;

		// Breaker expires quickly → the hold wakes and attempts within budget.
		applyProviderOverloadCooldown("anthropic", Date.now() + 200, MODEL);
		const slotKey = getOverloadHoldSlotKey("anthropic", MODEL);
		const ctx = makeContext([makeAccount()]);

		const started = Date.now();
		const res = await callHandleProxy(
			modelRequest(MODEL),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// Budget abort must fall through to the synthetic 529 — never the 499
		// client-abort marker (the client is still connected).
		expect(res.status).toBe(529);
		expect(fetchCalls).toBe(1);
		// Ended around the ~2s budget, nowhere near the 30-min upstream timeout.
		expect(Date.now() - started).toBeLessThan(10_000);
		// Every hold slot was released on the way out.
		expect(getActiveOverloadHoldCount(slotKey)).toBe(0);
	}, 15_000);

	it("exits the hold after one round when a wake attempt fails with an ordinary (non-overload) error", async () => {
		// Modest budget so a REGRESSION (re-polling the broken candidate every
		// 1.5s) fails fast on the call-count assertion instead of timing out.
		setOverloadHoldBudgetOverrideForTests(6_000);
		let fetchCalls = 0;
		globalThis.fetch = upstreamOnlyFetch(async () => {
			fetchCalls++;
			return new Response(
				JSON.stringify({
					type: "error",
					error: { type: "authentication_error", message: "bad token" },
				}),
				{ status: 401, headers: { "content-type": "application/json" } },
			);
		}) as never;

		applyProviderOverloadCooldown("anthropic", Date.now() + 200, MODEL);
		const ctx = makeContext([makeAccount()]);

		const started = Date.now();
		const res = await callHandleProxy(
			modelRequest(MODEL),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// One wake round, ONE upstream attempt — a persistent 401 is not an
		// overload verdict to wait for, so the hold breaks out immediately.
		expect(fetchCalls).toBe(1);
		expect(res.status).toBe(529);
		expect(Date.now() - started).toBeLessThan(5_000);
	}, 15_000);

	it("serves a recovered combo slot with the slot's model override after a hold wake", async () => {
		const sentBodies: string[] = [];
		let fetchCalls = 0;
		globalThis.fetch = upstreamOnlyFetch(
			async (input: Request | string | URL) => {
				fetchCalls++;
				sentBodies.push(input instanceof Request ? await input.text() : "");
				return ok200("claude-haiku-4-5");
			},
		) as never;

		// Active combo for the requested (sonnet) family maps this account's
		// slot to Haiku — and the HAIKU bucket is what is overloaded, so the
		// account is gated out and the request enters the hold.
		const account = makeAccount();
		const ctx = makeContext([account]);
		(
			ctx.dbOps as unknown as {
				getActiveComboForFamily: () => Promise<unknown>;
			}
		).getActiveComboForFamily = mock(async () => ({
			name: "test-combo",
			slots: [
				{
					account_id: account.id,
					model: "claude-haiku-4-5",
					enabled: true,
					priority: 0,
				},
			],
		}));
		applyProviderOverloadCooldown(
			"anthropic",
			Date.now() + 400,
			"claude-haiku-4-5",
		);

		const res = await callHandleProxy(
			modelRequest("claude-sonnet-4-5"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(200);
		expect(fetchCalls).toBe(1);
		// The wake attempt must carry the combo slot's model override — not the
		// request's sonnet model.
		const sent = JSON.parse(sentBodies[0]) as { model: string };
		expect(sent.model).toBe("claude-haiku-4-5");
	}, 15_000);

	it("enforces ONE provider-wide holder cap when provider-wide and family buckets coexist", async () => {
		let fetchCalls = 0;
		globalThis.fetch = upstreamOnlyFetch(async () => {
			fetchCalls++;
			return ok200(MODEL);
		}) as never;

		// A family bucket lingers from an earlier family-scoped trip, then a
		// provider-wide trip lands (e.g. an unattributable 529).
		applyProviderOverloadCooldown("anthropic", Date.now() + 60_000, MODEL);
		applyProviderOverloadCooldown("anthropic", Date.now() + 60_000);
		// With a LIVE provider-wide bucket the slot key collapses to the
		// provider-wide key even for a family-resolvable request.
		expect(getOverloadHoldSlotKey("anthropic", MODEL)).toBe(
			ANTHROPIC_UPSTREAM_OVERLOAD_KEY,
		);

		// Saturate the ONE shared cap.
		for (let i = 0; i < OVERLOAD_HOLD_MAX_CONCURRENT_PER_BUCKET; i++) {
			expect(tryAcquireOverloadHoldSlot(ANTHROPIC_UPSTREAM_OVERLOAD_KEY)).toBe(
				true,
			);
		}
		const ctx = makeContext([makeAccount()]);

		const started = Date.now();
		const res = await callHandleProxy(
			modelRequest(MODEL),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// The 9th holder overflows to the immediate synthetic 529 — it does NOT
		// get a fresh 8-holder cap under the family key.
		expect(res.status).toBe(529);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(fetchCalls).toBe(0);
		expect(
			getActiveOverloadHoldCount(`${ANTHROPIC_UPSTREAM_OVERLOAD_KEY}:haiku`),
		).toBe(0);
	});

	it("holds at the suppressed-exhaustion terminal and serves once the probe reports recovery", async () => {
		let fetchCalls = 0;
		globalThis.fetch = upstreamOnlyFetch(async () => {
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

describe("overload hold budget selection", () => {
	afterEach(() => {
		setOverloadHoldBudgetOverrideForTests(null);
	});

	it("shortens the budget when the connection's idle timer cannot be re-armed", () => {
		// The no-re-arm budget must stay under Bun's 180s base idleTimeout: on
		// that path the socket is closed by US, so a longer budget would drop the
		// client mid-hold rather than serve it.
		expect(OVERLOAD_HOLD_MAX_MS_NO_REARM).toBeLessThan(180_000);
		expect(OVERLOAD_HOLD_MAX_MS).toBeGreaterThan(OVERLOAD_HOLD_MAX_MS_NO_REARM);

		expect(getOverloadHoldBudgetMs(true)).toBe(OVERLOAD_HOLD_MAX_MS);
		expect(getOverloadHoldBudgetMs(false)).toBe(OVERLOAD_HOLD_MAX_MS_NO_REARM);
		// Default is the re-armable path — the overwhelming majority of traffic.
		expect(getOverloadHoldBudgetMs()).toBe(OVERLOAD_HOLD_MAX_MS);
	});

	it("lets a test override win over both paths", () => {
		setOverloadHoldBudgetOverrideForTests(1_234);
		expect(getOverloadHoldBudgetMs(true)).toBe(1_234);
		expect(getOverloadHoldBudgetMs(false)).toBe(1_234);
	});
});
