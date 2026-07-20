import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { usageCache } from "@clankermux/providers";
import type { Account, RequestMeta } from "@clankermux/types";
import { clearProviderOverloadCooldown } from "../../provider-overload-cooldown";
import { clearAnthropicBurstThrottle } from "../burst-cooldown";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

/**
 * Regression tests for the stale `rate_limit_status` chip: the 429 cooldown
 * short-circuit paths in proxy-operations (`return await fail(...)`) never
 * reached processProxyResponse/updateAccountMetadata, so the 429's
 * `anthropic-ratelimit-unified-status` header was never persisted and the
 * dashboard chip froze at the last successful response's status (e.g.
 * `allowed_warning` while `rate_limited_until` was active).
 *
 * Each test drives one short-circuit site and asserts
 * dbOps.updateAccountRateLimitMeta is called with the header-derived
 * status/reset/remaining (NOT the locally computed cooldownUntil).
 */

// OAuth-Anthropic account fixture (mirrors proxy-operations-burst-retry.test.ts).
// getProvider("anthropic") returns undefined in the test environment, so
// ctx.provider drives provider behaviour, including parseRateLimit.
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

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-status-1",
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

type MetaCall = {
	accountId: string;
	status: string;
	resetTime: number | null;
	remaining: number | undefined;
};

function makeProxyContext() {
	const metaCalls: MetaCall[] = [];
	const ctx = {
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
			updateAccountRateLimitMeta: mock(
				(
					accountId: string,
					status: string,
					resetTime: number | null,
					remaining: number | undefined,
				) => {
					metaCalls.push({ accountId, status, resetTime, remaining });
					return Promise.resolve();
				},
			),
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
			// Header-only parse mirroring AnthropicProvider's unified headers.
			parseRateLimit: (response: Response) => {
				const statusHeader =
					response.headers.get("anthropic-ratelimit-unified-status") ??
					undefined;
				const resetHeader = response.headers.get(
					"anthropic-ratelimit-unified-reset",
				);
				const remainingHeader = response.headers.get(
					"anthropic-ratelimit-unified-remaining",
				);
				return {
					isRateLimited: response.status === 429,
					resetTime: resetHeader ? Number(resetHeader) * 1000 : undefined,
					statusHeader,
					remaining: remainingHeader ? Number(remainingHeader) : undefined,
				};
			},
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
	} as unknown as ProxyContext;
	return { ctx, metaCalls };
}

function makeRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
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

const RESET_EPOCH_SEC = Math.floor((Date.now() + 90 * 60_000) / 1000);

describe("proxyWithAccount — 429 unified-status persistence on cooldown short-circuits", () => {
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

	it("no-model-fallbacks 429 path persists the unified-status header (model_fallback_429 site)", async () => {
		// Hard-limit unified status: the burst-retry early intercept declines
		// (non-retryable), so the flow reaches the no-fallback hard_429 path.
		globalThis.fetch = mock(async () =>
			rl429Response({
				"anthropic-ratelimit-unified-status": "rate_limited",
				"anthropic-ratelimit-unified-reset": String(RESET_EPOCH_SEC),
				"anthropic-ratelimit-unified-remaining": "0",
			}),
		);

		const { ctx, metaCalls } = makeProxyContext();
		const bodyBuffer = makeRequestBody();
		const result = await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			makeOAuthAnthropicAccount(), // no model fallbacks
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		expect(metaCalls).toHaveLength(1);
		expect(metaCalls[0]).toEqual({
			accountId: "acc-oauth",
			status: "rate_limited",
			// Provider-parsed reset header (window semantics) — NOT the locally
			// computed backoff cooldownUntil.
			resetTime: RESET_EPOCH_SEC * 1000,
			remaining: 0,
		});
	});

	it("burst-retry early intercept persists the unified-status header (transient model_fallback_429 site)", async () => {
		// Transient burst 429: soft status + x-should-retry → intercept fires
		// and short-circuits with retryable_429 BEFORE model cycling.
		globalThis.fetch = mock(async () =>
			rl429Response({
				"x-should-retry": "true",
				"anthropic-ratelimit-unified-status": "allowed_warning",
				"anthropic-ratelimit-unified-reset": String(RESET_EPOCH_SEC),
				"anthropic-ratelimit-unified-remaining": "3",
			}),
		);

		const { ctx, metaCalls } = makeProxyContext();
		const bodyBuffer = makeRequestBody();
		const result = await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			makeOAuthAnthropicAccount({
				model_mappings: JSON.stringify({ sonnet: "claude-sonnet-4-5" }),
				model_fallbacks: JSON.stringify({ sonnet: "claude-haiku-4-5" }),
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		expect(metaCalls).toHaveLength(1);
		expect(metaCalls[0]).toEqual({
			accountId: "acc-oauth",
			status: "allowed_warning",
			resetTime: RESET_EPOCH_SEC * 1000,
			remaining: 3,
		});
	});

	it("all-models-exhausted 429 path persists the unified-status header (all_models_exhausted_429 site)", async () => {
		// Hard status on every attempt: intercept declines, model fallbacks are
		// cycled and exhausted, landing on the all_models_exhausted_429 site.
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return rl429Response({
				"anthropic-ratelimit-unified-status": "rate_limited",
				"anthropic-ratelimit-unified-reset": String(RESET_EPOCH_SEC),
				"anthropic-ratelimit-unified-remaining": "0",
			});
		});

		const { ctx, metaCalls } = makeProxyContext();
		const bodyBuffer = makeRequestBody();
		const result = await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			makeOAuthAnthropicAccount({
				model_mappings: JSON.stringify({ sonnet: "claude-sonnet-4-5" }),
				model_fallbacks: JSON.stringify({ sonnet: "claude-haiku-4-5" }),
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		expect(fetchCount).toBeGreaterThan(1); // model list actually cycled
		expect(metaCalls).toHaveLength(1);
		expect(metaCalls[0]).toEqual({
			accountId: "acc-oauth",
			status: "rate_limited",
			resetTime: RESET_EPOCH_SEC * 1000,
			remaining: 0,
		});
	});

	it("reprobe 429 does NOT persist the unified-status header (deliberate omission)", async () => {
		// The re-probe contract (applyRateLimitCooldown with { reprobe: true } in
		// rate-limit-cooldown.ts) enqueues no DB writes; persistRateLimitStatusMeta
		// is deliberately omitted at the reprobe short-circuit site. Lock that in:
		// a 429 carrying the unified-status header during a re-probe must NOT
		// touch updateAccountRateLimitMeta.
		globalThis.fetch = mock(async () =>
			rl429Response({
				"anthropic-ratelimit-unified-status": "rate_limited",
				"anthropic-ratelimit-unified-reset": String(RESET_EPOCH_SEC),
				"anthropic-ratelimit-unified-remaining": "0",
			}),
		);

		const { ctx, metaCalls } = makeProxyContext();
		const bodyBuffer = makeRequestBody();
		const result = await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			makeOAuthAnthropicAccount({
				// A re-probe targets an account the proxy already locked.
				rate_limited_until: Date.now() + 5_000,
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
			{ reprobe: true },
		);

		// Still throttled → signals the hold orchestrator via null, no persistence.
		expect(result).toBeNull();
		expect(metaCalls).toHaveLength(0);
	});
});
