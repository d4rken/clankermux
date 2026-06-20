/**
 * Integration tests for the context-window hold feature.
 *
 * When the only accounts excluded from the pool are Codex accounts (too small
 * for the request) AND there are non-Codex accounts that are merely
 * rate-limited, the proxy holds the connection and retries once the rate-limit
 * expires — rather than immediately returning a 400 context_window_exceeded.
 *
 * Budget: 120s (CW_HOLD_MAX_MS, matching the burst-retry hold budget).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";

mock.module("../inline-worker", () => ({ EMBEDDED_WORKER_CODE: "" }));

async function callHandleProxy(req: Request, url: URL, ctx: ProxyContext) {
	const { handleProxy } = await import("../proxy");
	return handleProxy(req, url, ctx);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "account",
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

// gpt-5.5 window = 272K, gate threshold = floor(272K * 0.97) = 263840; the
// last-resort (unmargined) ceiling is the full 272000.
// A request estimated above 272000 tokens exceeds even the true Codex window.
function makeLargeRequest(signal?: AbortSignal): Request {
	const neededChars = Math.ceil((350_000 - 16) * 3.0);
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-opus-4-7",
			messages: [{ role: "user", content: "x".repeat(neededChars) }],
			max_tokens: 16,
		}),
		signal,
	});
}

// A request whose gate estimate (contentChars/3.0 + min(max_tokens,4000)) lands
// in the relax band (263840, 272000]: the margined gate excludes the Codex
// account, but the unmargined last-resort admits it. Target ≈ 268,000.
function makeRelaxBandRequest(signal?: AbortSignal): Request {
	const neededChars = Math.ceil((268_000 - 16) * 3.0);
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-opus-4-7",
			messages: [{ role: "user", content: "x".repeat(neededChars) }],
			max_tokens: 16,
		}),
		signal,
	});
}

// Simple context for tests that don't need proxyWithAccount to succeed.
function makeSimpleContext(accounts: Account[]): ProxyContext {
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
			getActiveComboForFamily: mock(async () => null),
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
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		requestRecorder: { recordSynthetic: mock(() => {}) } as never,
	};
}

// Full context for tests where proxyWithAccount must successfully proxy a request.
function makeFullContext(accounts: Account[]): ProxyContext {
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

function ok200() {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			model: "claude-opus-4-7",
			stop_reason: "end_turn",
			usage: { input_tokens: 10, output_tokens: 5 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("context-window hold", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
	});

	it("returns 400 immediately when only Codex is available and no non-Codex accounts exist", async () => {
		const codex = makeAccount({
			id: "codex-1",
			name: "Codex",
			provider: "codex",
			api_key: "cx-key",
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});
		const ctx = makeSimpleContext([codex]);

		const response = await callHandleProxy(
			makeLargeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(400);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("context_window_exceeded");
	});

	it("returns 400 immediately when rate-limited non-Codex account's cooldown exceeds the hold budget", async () => {
		// CW_HOLD_MAX_MS = 120s; 200s cooldown > 120s budget → skip hold entirely.
		const codex = makeAccount({
			id: "codex-1",
			name: "Codex",
			provider: "codex",
			api_key: "cx-key",
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});
		const anthropic = makeAccount({
			id: "opus-1",
			name: "Opus",
			provider: "anthropic",
			// 200s cooldown — beyond the 120s hold budget
			rate_limited_until: Date.now() + 200_000,
		});
		const ctx = makeSimpleContext([codex, anthropic]);

		const start = Date.now();
		const response = await callHandleProxy(
			makeLargeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		const elapsed = Date.now() - start;

		// Must return immediately (no sleep): elapsed well under 1s
		expect(elapsed).toBeLessThan(500);
		expect(response.status).toBe(400);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("context_window_exceeded");
	});

	it("holds connection and retries once a rate-limited account's cooldown expires", async () => {
		const codex = makeAccount({
			id: "codex-1",
			name: "Codex",
			provider: "codex",
			api_key: "cx-key",
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});
		// Anthropic account rate-limited for a short time — within budget
		const anthropic = makeAccount({
			id: "opus-1",
			name: "Opus",
			provider: "anthropic",
			rate_limited_until: Date.now() + 50,
		});
		const ctx = makeFullContext([codex, anthropic]);

		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url.includes("api.anthropic.com")) return ok200();
				return originalFetch(input as never, init);
			},
		);

		const response = await callHandleProxy(
			makeLargeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(200);
	});

	it("returns 499 when the client disconnects during the hold wait", async () => {
		const codex = makeAccount({
			id: "codex-1",
			name: "Codex",
			provider: "codex",
			api_key: "cx-key",
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});
		// Long cooldown so the sleep is definitely running when we abort
		const anthropic = makeAccount({
			id: "opus-1",
			name: "Opus",
			provider: "anthropic",
			rate_limited_until: Date.now() + 5_000,
		});
		const ctx = makeSimpleContext([codex, anthropic]);

		// Abort the signal 100ms after the request starts
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);

		const response = await callHandleProxy(
			makeLargeRequest(controller.signal),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(499);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("client_closed_request");
	});

	it("does not hold for paused non-Codex accounts (only waits for rate-limited ones)", async () => {
		const codex = makeAccount({
			id: "codex-1",
			name: "Codex",
			provider: "codex",
			api_key: "cx-key",
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});
		// Anthropic account paused (not rate-limited) — should not be waited for
		const anthropic = makeAccount({
			id: "opus-1",
			name: "Opus",
			provider: "anthropic",
			paused: true,
			pause_reason: "manual",
			rate_limited_until: null,
		});
		const ctx = makeSimpleContext([codex, anthropic]);

		const start = Date.now();
		const response = await callHandleProxy(
			makeLargeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		const elapsed = Date.now() - start;

		// No wait: paused accounts are not eligible for the CW hold
		expect(elapsed).toBeLessThan(500);
		expect(response.status).toBe(400);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("context_window_exceeded");
	});

	// ── Last-resort relaxation (E) ──────────────────────────────────────────
	it("last-resort: attempts the excluded Codex account when it is the only option and the request fits the true window", async () => {
		// Relax-band request (gate excludes at 0.97 margin, but it fits the full
		// 272k window). With Codex the only account and nothing to hold for, the
		// last-resort path must ATTEMPT Codex upstream rather than pre-rejecting.
		const codex = makeAccount({
			id: "codex-1",
			name: "Codex",
			provider: "codex",
			access_token: "cx-token",
			refresh_token: "cx-refresh",
			expires_at: Date.now() + 3_600_000,
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});
		const ctx = makeFullContext([codex]);

		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return ok200();
		}) as never;

		const response = await callHandleProxy(
			makeRelaxBandRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// E attempted the upstream Codex call (the gate would have skipped it).
		expect(fetchCount).toBeGreaterThanOrEqual(1);
		// And the response is NOT the pre-emptive size 400.
		if (response.status === 400) {
			const body = (await response.json()) as Record<string, unknown>;
			const error = body.error as Record<string, unknown>;
			expect(error.type).not.toBe("context_window_exceeded");
		}
	});

	it("last-resort: still returns 400 (no upstream attempt) when the request exceeds even the true window", async () => {
		const codex = makeAccount({
			id: "codex-1",
			name: "Codex",
			provider: "codex",
			access_token: "cx-token",
			refresh_token: "cx-refresh",
			expires_at: Date.now() + 3_600_000,
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});
		const ctx = makeFullContext([codex]);

		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return ok200();
		}) as never;

		const response = await callHandleProxy(
			makeLargeRequest(), // ~350k, exceeds the full 272k window
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// The unmargined check also fails → E never attempts upstream.
		expect(fetchCount).toBe(0);
		expect(response.status).toBe(400);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("context_window_exceeded");
	});

	it("last-resort: an upstream Codex 429 does NOT become a misleading size 400", async () => {
		// The request fits the true window (relax band) and E attempts Codex, but
		// Codex returns 429 → proxyWithAccount yields null. That's an availability
		// failure, not a size problem, so the terminal must NOT be
		// context_window_exceeded (it falls through to pool_exhausted).
		const codex = makeAccount({
			id: "codex-1",
			name: "Codex",
			provider: "codex",
			access_token: "cx-token",
			refresh_token: "cx-refresh",
			expires_at: Date.now() + 3_600_000,
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});
		const ctx = makeFullContext([codex]);

		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return new Response(
				JSON.stringify({ error: { message: "rate limited" } }),
				{
					status: 429,
					headers: { "content-type": "application/json" },
				},
			);
		}) as never;

		const response = await callHandleProxy(
			makeRelaxBandRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(fetchCount).toBeGreaterThanOrEqual(1); // E attempted upstream
		// Unpinned path → falls through to pool_exhausted (503), the honest,
		// retryable terminal — never the misleading size 400.
		expect(response.status).toBe(503);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("pool_exhausted");
	});

	it("last-resort: a client disconnect mid-attempt returns client_closed_request, not a fall-through terminal", async () => {
		const codex = makeAccount({
			id: "codex-1",
			name: "Codex",
			provider: "codex",
			access_token: "cx-token",
			refresh_token: "cx-refresh",
			expires_at: Date.now() + 3_600_000,
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});
		const ctx = makeFullContext([codex]);

		const controller = new AbortController();
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			// Simulate the client disconnecting while the E attempt is in flight.
			controller.abort();
			throw new DOMException("The operation was aborted.", "AbortError");
		}) as never;

		const response = await callHandleProxy(
			makeRelaxBandRequest(controller.signal),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(fetchCount).toBeGreaterThanOrEqual(1); // E attempted before the abort
		expect(response.status).toBe(499);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("client_closed_request");
	});

	it("last-resort: checks the combo slot's smaller window, not the family default", async () => {
		// Account default opus→gpt-5.5 (272k), combo slot overrides to
		// gpt-5.3-codex-spark (128k). A ~150k request is excluded by the gate and
		// also exceeds spark's FULL 128k window → the unmargined check must reject
		// (using the override, not the 272k family default) and NOT attempt Codex.
		const codex = makeAccount({
			id: "codex-combo",
			name: "Codex-combo",
			provider: "codex",
			access_token: "cx-token",
			refresh_token: "cx-refresh",
			expires_at: Date.now() + 3_600_000,
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});
		const ctx = makeFullContext([codex]);
		(
			ctx.dbOps as unknown as {
				getActiveComboForFamily: ReturnType<typeof mock>;
			}
		).getActiveComboForFamily = mock(async () => ({
			name: "test-combo",
			slots: [
				{
					account_id: "codex-combo",
					model: "gpt-5.3-codex-spark",
					enabled: true,
				},
			],
		}));

		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return ok200();
		}) as never;

		// ~150k estimate: > spark's 128k window, but < gpt-5.5's 272k. If E wrongly
		// used the family default it would attempt; with the override it must not.
		const neededChars = Math.ceil((150_000 - 16) * 3.0);
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "claude-opus-4-7",
				messages: [{ role: "user", content: "x".repeat(neededChars) }],
				max_tokens: 16,
			}),
		});

		const response = await callHandleProxy(
			req,
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(fetchCount).toBe(0); // override window rejected → no upstream attempt
		expect(response.status).toBe(400);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("context_window_exceeded");
		expect(error.message as string).toContain("gpt-5.3-codex-spark");
	});
});
