import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { TIME_CONSTANTS } from "@clankermux/core";
import { usageCache } from "@clankermux/providers";
import type { Account, RequestMeta } from "@clankermux/types";
import { clearProviderOverloadCooldown } from "../../provider-overload-cooldown";
import { clearAnthropicBurstThrottle } from "../burst-cooldown";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

/**
 * Issue #261: an Anthropic OAuth account out of credits returns 429 with
 * `anthropic-ratelimit-unified-overage-disabled-reason: out_of_credits`, NO
 * reset header, and `x-should-retry: true`. The proxy must apply a LONG cooldown
 * (≥ OUT_OF_CREDITS_COOLDOWN_MS) and record the `out_of_credits` reason — NOT pin
 * it at the 60s no-reset probe loop. The failover-429 audit row must also carry
 * the request's model (not NULL).
 */

const OVERAGE_DISABLED_HEADER =
	"anthropic-ratelimit-unified-overage-disabled-reason";
const REQUEST_MODEL = "claude-sonnet-4-5";

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
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		notes: null,
		refresh_token_issued_at: null,
		renewal_anchor: null,
		renewal_cadence: null,
		renewal_price_usd_micros: null,
		renewal_auto_start_date: null,
		...overrides,
	} as Account;
}

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-ooc-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	} as RequestMeta;
}

function makeRequestBody(model = REQUEST_MODEL) {
	const body = JSON.stringify({
		model,
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 10,
	});
	return new TextEncoder().encode(body).buffer;
}

type SaveRequestCall = unknown[];

function makeProxyContext() {
	const saveRequestCalls: SaveRequestCall[] = [];
	const markCalls: Array<{ id: string; until: number; reason: string }> = [];
	const ctx = {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(
				(accountId: string, until: number, reason: string) => {
					markCalls.push({ id: accountId, until, reason });
					return Promise.resolve(1);
				},
			),
			markAccountRateLimitedDeadlineOnly: mock(
				(accountId: string, until: number, reason: string) => {
					markCalls.push({ id: accountId, until, reason });
					return Promise.resolve();
				},
			),
			saveRequest: mock((...args: unknown[]) => {
				saveRequestCalls.push(args);
				return Promise.resolve();
			}),
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
			parseRateLimit: (response: Response) => ({
				isRateLimited: response.status === 429,
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
	} as unknown as ProxyContext;
	return { ctx, saveRequestCalls, markCalls };
}

function makeRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
	});
}

function outOfCredits429() {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "Out of credits" },
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"x-should-retry": "true",
				[OVERAGE_DISABLED_HEADER]: "out_of_credits",
			},
		},
	);
}

describe("proxyWithAccount — out_of_credits 429 (issue #261)", () => {
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

	it("applies a long cooldown, records out_of_credits, and audits the model", async () => {
		globalThis.fetch = mock(async () => outOfCredits429());

		const { ctx, saveRequestCalls, markCalls } = makeProxyContext();
		const before = Date.now();
		const account = makeOAuthAnthropicAccount();
		const bodyBuffer = makeRequestBody();

		const result = await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// Failed over (null) rather than forwarding the 429.
		expect(result).toBeNull();

		// (1) Long cooldown — NOT the ~60s no-reset probe.
		expect(account.rate_limited_until).not.toBeNull();
		const until = account.rate_limited_until as number;
		expect(until).toBeGreaterThanOrEqual(
			before + TIME_CONSTANTS.OUT_OF_CREDITS_COOLDOWN_MS,
		);

		// (2) The DB cooldown + audit reason are both "out_of_credits".
		expect(markCalls).toHaveLength(1);
		expect(markCalls[0].reason).toBe("out_of_credits");
		expect(markCalls[0].until).toBeGreaterThanOrEqual(
			before + TIME_CONSTANTS.OUT_OF_CREDITS_COOLDOWN_MS,
		);

		// (3) The audit saveRequest row carries reason + the request model.
		// Positional saveRequest signature: id, method, path, accountId, status,
		// success, reason(7th), responseTime, failoverAttempts, usage(10th)...
		expect(saveRequestCalls).toHaveLength(1);
		const args = saveRequestCalls[0];
		expect(args[6]).toBe("out_of_credits"); // reason
		expect(args[9]).toEqual({ model: REQUEST_MODEL }); // usage (10th arg, 0-indexed 9)
	});
});
