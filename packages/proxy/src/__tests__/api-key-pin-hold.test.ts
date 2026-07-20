/**
 * Integration tests for the pin-transient hold.
 *
 * A client API key pinned to a provider class (or a specific account) must NOT
 * fast-fail `503 pinned_no_available_account` when every pin-allowed account is
 * on a TRANSIENT cooldown (a per-account 429 or a provider-wide 529 overload)
 * that will clear within the hold budget. Instead the proxy holds the connection
 * and re-probes — re-selection re-enforces the pin, so a disallowed account is
 * never served. A long 5h/7d usage-window wall (recovery beyond budget) still
 * fast-fails, which is correct.
 *
 * Budget: PIN_HOLD_MAX_MS (120s, matching the CW / burst-retry holds).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";

mock.module("../inline-worker", () => ({ EMBEDDED_WORKER_CODE: "" }));

const API_KEY_ID = "key-1";

async function callHandleProxy(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	apiKeyId: string | null = API_KEY_ID,
) {
	const { handleProxy } = await import("../proxy");
	return handleProxy(req, url, ctx, apiKeyId, "test-key");
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
		codex_auto_apply_reset_credits_enabled: false,
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

// A normal-sized /v1/messages request (nothing to do with the context window).
function makeRequest(signal?: AbortSignal): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-opus-4-7",
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 16,
		}),
		signal,
	});
}

const strategySelect = (accs: Account[]) => {
	const now = Date.now();
	return accs.filter(
		(acc) =>
			!acc.paused && (!acc.rate_limited_until || acc.rate_limited_until <= now),
	);
};

// Pin config returned by getApiKeyPin.
type PinCfg = {
	pinnedAccountId: string | null;
	pinnedProviders: string[] | null;
};

function makeSimpleContext(accounts: Account[], pin: PinCfg): ProxyContext {
	return {
		strategy: { select: strategySelect } as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getAccount: mock(
				async (id: string) => accounts.find((a) => a.id === id) ?? null,
			),
			getActiveComboForFamily: mock(async () => null),
			getApiKeyPin: mock(async () => ({ malformed: false, ...pin })),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getCacheWarmingEnabled: () => false,
			getCacheWarmingMinTokens: () => 100_000,
			getStorePayloads: () => false,
		} as never,
		provider: { name: "anthropic", canHandle: () => true } as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		requestRecorder: { recordSynthetic: mock(() => {}) } as never,
	};
}

function makeFullContext(accounts: Account[], pin: PinCfg): ProxyContext {
	return {
		strategy: { select: strategySelect } as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getAccount: mock(
				async (id: string) => accounts.find((a) => a.id === id) ?? null,
			),
			getActiveComboForFamily: mock(async () => null),
			getApiKeyPin: mock(async () => ({ malformed: false, ...pin })),
			markAccountRateLimited: mock(async () => 1),
			markAccountRateLimitedDeadlineOnly: mock(async () => {}),
			saveRequest: mock(async () => {}),
			updateAccountUsage: mock(async () => {}),
			updateAccountRateLimitMeta: mock(async () => {}),
			updateRequestUsage: mock(async () => {}),
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

const CLASS_PIN: PinCfg = {
	pinnedAccountId: null,
	pinnedProviders: ["anthropic"],
};

describe("pin-transient hold", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const u = input instanceof Request ? input.url : String(input);
				if (u.includes("api.anthropic.com")) return ok200();
				return originalFetch(input as never, init);
			},
		);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
	});

	it("holds and serves once a transiently rate-limited pinned account recovers", async () => {
		const anthropic = makeAccount({
			id: "opus-1",
			name: "Opus",
			provider: "anthropic",
			rate_limited_until: Date.now() + 200,
		});
		const ctx = makeFullContext([anthropic], CLASS_PIN);

		const response = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(200);
	});

	it("holds and serves for a 529-overloaded pinned account (upstream_529 reset)", async () => {
		// Faithful to the reported incident: the 529 set rate_limited_until with
		// reason upstream_529_overloaded_with_reset on every anthropic account.
		const anthropic = makeAccount({
			id: "opus-1",
			name: "Opus",
			provider: "anthropic",
			rate_limited_until: Date.now() + 200,
			rate_limited_reason: "upstream_529_overloaded_with_reset",
		});
		const ctx = makeFullContext([anthropic], CLASS_PIN);

		const response = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(200);
	});

	it("fast-fails 503 when the pinned account is on a long cooldown beyond the hold budget", async () => {
		const anthropic = makeAccount({
			id: "opus-1",
			name: "Opus",
			provider: "anthropic",
			// Well beyond PIN_HOLD_MAX_MS (120s) — a real 5h/7d wall.
			rate_limited_until: Date.now() + 400_000,
		});
		const ctx = makeSimpleContext([anthropic], CLASS_PIN);

		const start = Date.now();
		const response = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(500);
		expect(response.status).toBe(503);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("pinned_no_available_account");
	});

	it("never routes a pinned key to a disallowed (codex) account, even on a long wall", async () => {
		const anthropic = makeAccount({
			id: "opus-1",
			name: "Opus",
			provider: "anthropic",
			rate_limited_until: Date.now() + 400_000,
		});
		const codex = makeAccount({
			id: "codex-1",
			name: "Codex",
			provider: "codex",
			api_key: "cx-key",
		});
		const ctx = makeSimpleContext([anthropic, codex], CLASS_PIN);

		const response = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// Fail closed to the pinned terminal — must NOT borrow the codex account.
		expect(response.status).toBe(503);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("pinned_no_available_account");
	});

	it("returns 499 when the client disconnects during the pin hold", async () => {
		const anthropic = makeAccount({
			id: "opus-1",
			name: "Opus",
			provider: "anthropic",
			// Long enough that the sleep is running when we abort (still within budget).
			rate_limited_until: Date.now() + 5_000,
		});
		const ctx = makeSimpleContext([anthropic], CLASS_PIN);

		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);

		const response = await callHandleProxy(
			makeRequest(controller.signal),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(499);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("client_closed_request");
	});

	it("holds and serves for a specific-account pin that is transiently cooled", async () => {
		const anthropic = makeAccount({
			id: "opus-1",
			name: "Opus",
			provider: "anthropic",
			rate_limited_until: Date.now() + 200,
		});
		const ctx = makeFullContext([anthropic], {
			pinnedAccountId: "opus-1",
			pinnedProviders: null,
		});

		const response = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(200);
	});
});
