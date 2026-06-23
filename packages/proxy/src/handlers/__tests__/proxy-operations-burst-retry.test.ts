import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { usageCache } from "@clankermux/providers";
import type { Account, RequestMeta } from "@clankermux/types";
import { clearProviderOverloadCooldown } from "../../provider-overload-cooldown";
import {
	clearAnthropicBurstThrottle,
	isAnthropicBurstThrottleActive,
} from "../burst-cooldown";
import {
	type ProxyAttemptOutcome,
	proxyWithAccount,
} from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

// OAuth-Anthropic account fixture: provider "anthropic" + a refresh token + a
// valid (future) access token so getValidAccessToken returns it without a
// network refresh. getProvider("anthropic") returns undefined in the test
// environment (no provider registry registration), so ctx.provider drives the
// provider behaviour and we can fully control parseRateLimit/processResponse.
function makeOAuthAnthropicAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-oauth",
		name: "oauth-cache",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt-token",
		access_token: "at-token",
		expires_at: Date.now() + 3_600_000,
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

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-burst-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeRequestBody(model = "claude-sonnet-4-5") {
	const body = JSON.stringify({
		model,
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 10,
	});
	return new TextEncoder().encode(body).buffer;
}

function makeProxyContext(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(
				(_accountId: string, _until: number, _reason: string) =>
					Promise.resolve(1),
			),
			markAccountRateLimitedDeadlineOnly: mock(
				(_accountId: string, _until: number, _reason: string) =>
					Promise.resolve(),
			),
			saveRequest: mock((..._args: unknown[]) => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			updateAccountRateLimitMeta: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
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
		config: { getStorePayloads: () => true } as never,
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

function makeRequest(body: ArrayBuffer, signal?: AbortSignal) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
		signal,
	});
}

function rl429Response(headers: Record<string, string> = {}) {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "Too many requests" },
		}),
		{
			status: 429,
			headers: { "content-type": "application/json", ...headers },
		},
	);
}

function ok200Response() {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			model: "claude-sonnet-4-5",
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("proxyWithAccount — transparent burst-retry early intercept", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
		clearAnthropicBurstThrottle();
		usageCache.delete("acc-oauth");
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
		clearAnthropicBurstThrottle();
		usageCache.delete("acc-oauth");
	});

	it("intercepts a transient 429 (x-should-retry) and records retryable_429 WITHOUT cycling model fallbacks", async () => {
		const fetchCalls: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const req = input instanceof Request ? input : new Request(String(input));
			const bodyText = await req.text().catch(() => "{}");
			const body = JSON.parse(bodyText || "{}");
			fetchCalls.push(body.model ?? "unknown");
			return rl429Response({ "x-should-retry": "true" });
		});

		const outcomes: ProxyAttemptOutcome[] = [];
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			// Account WITH model fallbacks configured — must NOT be cycled.
			makeOAuthAnthropicAccount({
				model_mappings: JSON.stringify({ sonnet: "claude-sonnet-4-5" }),
				model_fallbacks: JSON.stringify({ sonnet: "claude-haiku-4-5" }),
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			{ onOutcome: (o) => outcomes.push(o) },
		);

		expect(result).toBeNull();
		// Exactly ONE upstream call — the early intercept fired before model cycling.
		expect(fetchCalls).toHaveLength(1);
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0].kind).toBe("retryable_429");
		if (outcomes[0].kind === "retryable_429") {
			expect(outcomes[0].confidence).toBe("stale_should_retry");
		}
	});

	it("Finding 1: the shared burst marker is active IMMEDIATELY after the intercept returns (before any hold begins)", async () => {
		// The marker must be set SYNCHRONOUSLY at classification time inside
		// proxyWithAccount — not later in holdAndRetryCacheAccount — so a concurrent
		// affinity request can't see the cache account cooled while the marker is
		// still inactive and divert to a sibling. We assert it here purely on the
		// proxyWithAccount return (no hold orchestrator involved).
		expect(isAnthropicBurstThrottleActive()).toBe(false);
		globalThis.fetch = mock(async () =>
			rl429Response({ "x-should-retry": "true" }),
		);

		const outcomes: ProxyAttemptOutcome[] = [];
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeOAuthAnthropicAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			{ onOutcome: (o) => outcomes.push(o) },
		);

		expect(result).toBeNull();
		expect(outcomes.at(-1)?.kind).toBe("retryable_429");
		// Marker active the instant the intercept returns — no hold has run.
		expect(isAnthropicBurstThrottleActive()).toBe(true);
	});

	it("Finding 6: stale/absent usage triggers ONE refreshNow, then classifies on the refreshed capacity (fresh_headroom)", async () => {
		// No usage cached for acc-oauth (deleted in beforeEach) ⇒ getFreshCapacity
		// returns null. The intercept must call refreshNow ONCE; we stub it to
		// "succeed" by seeding fresh, positive 5h headroom into the cache (as a real
		// successful fetch would) and returning true. Classification then runs on
		// the refreshed capacity → fresh_headroom (NOT the stale_should_retry hint).
		let refreshCalls = 0;
		const refreshSpy = mock(async (accountId: string) => {
			refreshCalls += 1;
			usageCache.set(accountId, {
				five_hour: {
					utilization: 30,
					resets_at: new Date(Date.now() + 3_600_000).toISOString(),
				},
				seven_day: {
					utilization: 10,
					resets_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
				},
			} as never);
			return true;
		});
		const originalRefreshNow = usageCache.refreshNow.bind(usageCache);
		usageCache.refreshNow = refreshSpy as typeof usageCache.refreshNow;

		try {
			globalThis.fetch = mock(async () =>
				// NOTE: no x-should-retry header — so a stale-usage path that did NOT
				// refresh would classify as non-retryable. A fresh_headroom outcome
				// therefore proves the refresh ran AND drove the classification.
				rl429Response(),
			);

			const outcomes: ProxyAttemptOutcome[] = [];
			const bodyBuffer = makeRequestBody();
			const req = makeRequest(bodyBuffer);
			const result = await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeOAuthAnthropicAccount(),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				{ onOutcome: (o) => outcomes.push(o) },
			);

			expect(result).toBeNull();
			// Exactly one refresh attempt.
			expect(refreshCalls).toBe(1);
			// Classified retryable on the REFRESHED capacity (fresh headroom), not on
			// the absent x-should-retry hint.
			expect(outcomes.at(-1)?.kind).toBe("retryable_429");
			const last = outcomes.at(-1);
			if (last?.kind === "retryable_429") {
				expect(last.confidence).toBe("fresh_headroom");
			}
		} finally {
			usageCache.refreshNow = originalRefreshNow;
		}
	});

	it("does NOT intercept a hard-limit-status 429 (falls through to normal failover, hard_429)", async () => {
		globalThis.fetch = mock(async () =>
			rl429Response({
				"anthropic-ratelimit-unified-status": "rate_limited",
				"x-should-retry": "true",
			}),
		);

		const outcomes: ProxyAttemptOutcome[] = [];
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeOAuthAnthropicAccount(), // no fallbacks
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			{ onOutcome: (o) => outcomes.push(o) },
		);

		expect(result).toBeNull();
		// Hard-limit status is NOT hold-eligible → recorded as hard_429.
		expect(outcomes.at(-1)?.kind).toBe("hard_429");
	});

	it("does NOT intercept a 429 on a non-OAuth-Anthropic (console) account", async () => {
		globalThis.fetch = mock(async () =>
			rl429Response({ "x-should-retry": "true" }),
		);

		const outcomes: ProxyAttemptOutcome[] = [];
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const ctx = makeProxyContext();
		(ctx as { provider: typeof ctx.provider }).provider = {
			...ctx.provider,
			name: "claude-console-api",
		} as typeof ctx.provider;
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeOAuthAnthropicAccount({
				provider: "claude-console-api",
				api_key: "sk-ant-test",
				refresh_token: "",
				access_token: null,
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			{ onOutcome: (o) => outcomes.push(o) },
		);

		expect(result).toBeNull();
		// Not OAuth-Anthropic → no retryable_429; classified hard_429 (no fallbacks).
		expect(outcomes.at(-1)?.kind).toBe("hard_429");
	});
});

describe("proxyWithAccount — reprobe mode", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("reprobe 429 leaves consecutive_rate_limits + rate_limited_at intact and returns null", async () => {
		globalThis.fetch = mock(async () => rl429Response({ "retry-after": "30" }));

		const account = makeOAuthAnthropicAccount({
			consecutive_rate_limits: 2,
			rate_limited_at: 111, // sentinel — must not change
			rate_limited_until: Date.now() + 5_000,
		});
		const ctx = makeProxyContext();
		const outcomes: ProxyAttemptOutcome[] = [];
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			{ reprobe: true, onOutcome: (o) => outcomes.push(o) },
		);

		expect(result).toBeNull();
		expect(outcomes.at(-1)?.kind).toBe("retryable_429");
		// Re-probe semantics: streak + anchor untouched.
		expect(account.consecutive_rate_limits).toBe(2);
		expect(account.rate_limited_at).toBe(111);
		// markAccountRateLimited (the DB streak increment) must NOT have fired.
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock
		>;
		expect(markMock.mock.calls).toHaveLength(0);
	});

	it("reprobe success (200) forwards the response", async () => {
		globalThis.fetch = mock(async () => ok200Response());

		const account = makeOAuthAnthropicAccount({
			rate_limited_until: Date.now() + 5_000,
		});
		const ctx = makeProxyContext();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			{ reprobe: true },
		);

		expect(result).not.toBeNull();
		expect(result?.status).toBe(200);
	});
});
