import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { usageCache } from "@clankermux/providers";
import type { Account, RequestMeta } from "@clankermux/types";
import { clearProviderOverloadCooldown } from "../../provider-overload-cooldown";
import {
	clearAnthropicBurstThrottle,
	isAnthropicBurstThrottleActive,
} from "../burst-cooldown";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

/**
 * Account-wide weekly exhaustion is a CAUSE, not a transient burst: a 429 on an
 * Anthropic account whose weekly window is at 100% (per fresh usage data) must
 * record `weekly_exhausted_429` and fail over immediately, instead of being
 * mislabelled `model_fallback_429` and held/re-probed by the burst-retry
 * machinery. The cooldown DEADLINE is unchanged (`extractCooldownUntil`) — only
 * the reason and the skipped hold change.
 */

const ACCOUNT_ID = "acc-weekly";
/** Retry-after on every stubbed 429, in seconds. */
const RETRY_AFTER_S = 600;

function makeOAuthAnthropicAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: ACCOUNT_ID,
		name: "oauth-weekly",
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

function makeRequestMeta(overrides: Partial<RequestMeta> = {}): RequestMeta {
	return {
		id: "req-weekly-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		...overrides,
	} as RequestMeta;
}

function makeRequestBody(model: string) {
	const body = JSON.stringify({
		model,
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 10,
	});
	return new TextEncoder().encode(body).buffer;
}

/** Seed the usage cache with a 100%-weekly (exhausted) Anthropic payload. */
function seedWeeklyExhausted() {
	usageCache.set(ACCOUNT_ID, {
		five_hour: {
			utilization: 100,
			resets_at: new Date(Date.now() + 4 * 3_600_000).toISOString(),
		},
		seven_day: {
			utilization: 100,
			resets_at: new Date(Date.now() + 23 * 3_600_000).toISOString(),
		},
	} as never);
}

/** Seed the usage cache with a healthy (not exhausted) Anthropic payload. */
function seedWeeklyHealthy() {
	usageCache.set(ACCOUNT_ID, {
		five_hour: {
			utilization: 10,
			resets_at: new Date(Date.now() + 4 * 3_600_000).toISOString(),
		},
		seven_day: {
			utilization: 42,
			resets_at: new Date(Date.now() + 23 * 3_600_000).toISOString(),
		},
	} as never);
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

function makeRequest(body: ArrayBuffer, headers: Record<string, string> = {}) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

/** A 429 exactly as Anthropic sends it on a spent weekly window. */
function rejected429() {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "rate limited" },
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"anthropic-ratelimit-unified-status": "rejected",
				"x-should-retry": "true",
				"retry-after": String(RETRY_AFTER_S),
			},
		},
	);
}

function reasonsFrom(calls: SaveRequestCall[]): unknown[] {
	return calls.map((args) => args[6]);
}

describe("proxyWithAccount — account-wide weekly-exhausted 429", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
		clearAnthropicBurstThrottle();
		usageCache.delete(ACCOUNT_ID);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
		clearAnthropicBurstThrottle();
		usageCache.delete(ACCOUNT_ID);
	});

	it("records weekly_exhausted_429, keeps the extractCooldownUntil deadline and skips burst-retry", async () => {
		globalThis.fetch = mock(async () => rejected429());
		seedWeeklyExhausted();

		const { ctx, saveRequestCalls, markCalls } = makeProxyContext();
		const account = makeOAuthAnthropicAccount();
		const bodyBuffer = makeRequestBody("claude-opus-4-8");
		const before = Date.now();

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

		// Failed over rather than forwarding the 429.
		expect(result).toBeNull();
		// The audit row names the real cause...
		const row = saveRequestCalls.find(
			(args) => args[6] === "weekly_exhausted_429",
		);
		expect(row).toBeDefined();
		expect(row?.[9]).toEqual({ model: "claude-opus-4-8" });
		// ...and burst-retry was never entered.
		expect(reasonsFrom(saveRequestCalls)).not.toContain("model_fallback_429");
		expect(isAnthropicBurstThrottleActive()).toBe(false);
		// The cooldown deadline is the unchanged extractCooldownUntil value: the
		// 429's retry-after, NOT the (much later) weekly reset.
		expect(account.rate_limited_until).not.toBeNull();
		const until = account.rate_limited_until as number;
		expect(until).toBeGreaterThanOrEqual(before + RETRY_AFTER_S * 1000);
		expect(until).toBeLessThan(before + (RETRY_AFTER_S + 5) * 1000);
		// The persisted cooldown carries the same reason (server-directed reset ⇒
		// the non-incrementing deadline-only write).
		expect(markCalls).toEqual([
			{ id: ACCOUNT_ID, until, reason: "weekly_exhausted_429" },
		]);
	});

	it("does NOT fire when the weekly window still has headroom", async () => {
		globalThis.fetch = mock(async () => rejected429());
		seedWeeklyHealthy();

		const { ctx, saveRequestCalls } = makeProxyContext();
		const account = makeOAuthAnthropicAccount();
		const bodyBuffer = makeRequestBody("claude-opus-4-8");

		await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(reasonsFrom(saveRequestCalls)).not.toContain("weekly_exhausted_429");
	});

	it("fails open to today's behaviour when usage is absent/stale", async () => {
		globalThis.fetch = mock(async () => rejected429());
		// No usage cache entry ⇒ getFreshCapacity returns null ⇒ no evidence.

		const { ctx, saveRequestCalls } = makeProxyContext();
		const account = makeOAuthAnthropicAccount();
		const bodyBuffer = makeRequestBody("claude-opus-4-8");

		await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(reasonsFrom(saveRequestCalls)).not.toContain("weekly_exhausted_429");
	});

	it("is skipped in reprobe mode (the hold orchestrator owns that outcome)", async () => {
		globalThis.fetch = mock(async () => rejected429());
		seedWeeklyExhausted();

		const { ctx, saveRequestCalls } = makeProxyContext();
		const account = makeOAuthAnthropicAccount();
		const bodyBuffer = makeRequestBody("claude-opus-4-8");

		await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
			{ reprobe: true },
		);

		expect(reasonsFrom(saveRequestCalls)).not.toContain("weekly_exhausted_429");
	});

	it("still fires for an EXTERNAL request carrying a spoofed keepalive header", async () => {
		// The marker headers are client-spoofable, so this block uses the
		// trust-gated `isTrustedSyntheticProbe` (which also requires the in-process
		// `internal` flag) rather than the header-only variant its neighbours use.
		globalThis.fetch = mock(async () => rejected429());
		seedWeeklyExhausted();

		const { ctx, saveRequestCalls } = makeProxyContext();
		const account = makeOAuthAnthropicAccount();
		const bodyBuffer = makeRequestBody("claude-opus-4-8");

		await proxyWithAccount(
			makeRequest(bodyBuffer, { "x-clankermux-keepalive": "1" }),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(reasonsFrom(saveRequestCalls)).toContain("weekly_exhausted_429");
	});

	it("is skipped for a TRUSTED in-process probe (internal + keepalive marker)", async () => {
		globalThis.fetch = mock(async () => rejected429());
		seedWeeklyExhausted();

		const { ctx, saveRequestCalls } = makeProxyContext();
		const account = makeOAuthAnthropicAccount();
		const bodyBuffer = makeRequestBody("claude-opus-4-8");

		await proxyWithAccount(
			makeRequest(bodyBuffer, { "x-clankermux-keepalive": "1" }),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta({ internal: true }),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(reasonsFrom(saveRequestCalls)).not.toContain("weekly_exhausted_429");
	});

	it("does not fire for a non-Anthropic account", async () => {
		globalThis.fetch = mock(async () => rejected429());
		seedWeeklyExhausted();

		const { ctx, saveRequestCalls } = makeProxyContext();
		const account = makeOAuthAnthropicAccount({ provider: "codex" });
		const bodyBuffer = makeRequestBody("gpt-5.5");

		await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(reasonsFrom(saveRequestCalls)).not.toContain("weekly_exhausted_429");
	});
});
