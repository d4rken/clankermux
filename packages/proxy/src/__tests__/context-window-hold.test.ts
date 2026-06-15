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

// gpt-5.5 window = 272K, threshold = floor(272K * 0.85) = 231200
// A request estimated above 231200 tokens exceeds the Codex window.
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
			getSystemPromptCacheTtl1h: () => false,
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
			getSystemPromptCacheTtl1h: () => false,
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
});
