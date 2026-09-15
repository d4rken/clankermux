/**
 * A Z.AI 429 landed with a non-quota reason, because the account-wide
 * exhaustion rung was gated on `provider === "anthropic"`. That reason is
 * outside `QUOTA_DERIVED_RATE_LIMIT_REASONS`, so the capacity-restored listener
 * refused to release the lock however much headroom polling then observed — and
 * a long-held one logged the `lock_contradiction` WARN on every poll.
 *
 * The guards that bound the risk are unchanged and asserted here: the reading
 * must be fresh, and the exhaustion verdict must independently say a window is
 * spent with a future reset.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { usageCache } from "@clankermux/providers";
import { mockFetch } from "@clankermux/test-support";
import type { Account, RequestMeta, RoutingAttempt } from "@clankermux/types";
import {
	proxyWithAccount,
	routingAttempts,
} from "../../__tests__/fixtures/routing-harness";
import { clearProviderOverloadCooldown } from "../../provider-overload-cooldown";
import { clearAnthropicBurstThrottle } from "../burst-cooldown";
import type { ProxyContext } from "../proxy-types";

const ACCOUNT_ID = "acc-zai-429";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Retry-after on every stubbed 429, in seconds. */
const RETRY_AFTER_S = 600;

function makeZaiAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: ACCOUNT_ID,
		name: "Z.AI-1",
		provider: "zai",
		api_key: "zai-key",
		refresh_token: "zai-key",
		access_token: "zai-key",
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

function zaiUsage(fiveHourPct: number, weeklyPct: number) {
	const now = Date.now();
	return {
		time_limit: null,
		tokens_limit: {
			used: fiveHourPct,
			remaining: 100 - fiveHourPct,
			percentage: fiveHourPct,
			resetAt: now + 2 * HOUR,
			type: "tokens_limit",
		},
		tokens_limit_weekly: {
			used: weeklyPct,
			remaining: 100 - weeklyPct,
			percentage: weeklyPct,
			resetAt: now + 3 * DAY,
			type: "tokens_limit_weekly",
		},
	};
}

type SaveRequestCall = Record<string, unknown>;

function makeProxyContext() {
	const markCalls: Array<{ id: string; until: number; reason: string }> = [];
	let persistedStreak = 0;
	const ctx = {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(
				(accountId: string, until: number, reason: string) => {
					markCalls.push({ id: accountId, until, reason });
					return Promise.resolve(++persistedStreak);
				},
			),
			markAccountRateLimitedDeadlineOnly: mock(
				(accountId: string, until: number, reason: string) => {
					markCalls.push({ id: accountId, until, reason });
					return Promise.resolve();
				},
			),
			saveRequest: mock((_data: SaveRequestCall) => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			updateAccountRateLimitMeta: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {
			name: "zai",
			canHandle: () => true,
			buildUrl: () => "https://api.z.ai/api/anthropic/v1/messages",
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
	return { ctx, attemptCalls: routingAttempts(ctx), markCalls };
}

function rejected429() {
	return new Response(
		JSON.stringify({ error: { type: "rate_limit_error", message: "slow" } }),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"retry-after": String(RETRY_AFTER_S),
			},
		},
	);
}

function reasonsFrom(attempts: RoutingAttempt[]): Array<string | null> {
	return attempts.map((row) => row.error);
}

async function run(ctx: ProxyContext, account: Account) {
	const body = new TextEncoder().encode(
		JSON.stringify({
			model: "glm-4.6",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
		}),
	).buffer;
	return proxyWithAccount(
		new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body,
			headers: { "Content-Type": "application/json" },
		}),
		new URL("https://proxy.local/v1/messages"),
		account,
		{
			id: "req-zai-1",
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			headers: new Headers(),
		} as RequestMeta,
		body,
		() => undefined,
		0,
		ctx,
	);
}

describe("proxyWithAccount — account-wide exhausted 429 on a Z.AI account", () => {
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

	it("records weekly_exhausted_429 from a fresh at-100% weekly reading", async () => {
		globalThis.fetch = mockFetch(mock(async () => rejected429()));
		usageCache.set(ACCOUNT_ID, zaiUsage(30, 100) as never);

		const { ctx, attemptCalls, markCalls } = makeProxyContext();
		await run(ctx, makeZaiAccount());

		expect(reasonsFrom(attemptCalls)).toContain("weekly_exhausted_429");
		expect(markCalls[0]?.reason).toBe("weekly_exhausted_429");
	});

	it("records session_exhausted_429 when only the five-hour window is spent", async () => {
		globalThis.fetch = mockFetch(mock(async () => rejected429()));
		usageCache.set(ACCOUNT_ID, zaiUsage(100, 30) as never);

		const { ctx, attemptCalls } = makeProxyContext();
		await run(ctx, makeZaiAccount());

		expect(reasonsFrom(attemptCalls)).toContain("session_exhausted_429");
	});

	it("records neither quota reason when the reading is stale", async () => {
		globalThis.fetch = mockFetch(mock(async () => rejected429()));
		// Older than FAMILY_WEEKLY_MAX_USAGE_AGE_MS: the freshness gate refuses it,
		// so the 429 falls through to the pre-existing generic handling.
		usageCache.setWithAgeForTests(
			ACCOUNT_ID,
			zaiUsage(30, 100) as never,
			10 * 60 * 1000,
		);

		const { ctx, attemptCalls } = makeProxyContext();
		await run(ctx, makeZaiAccount());

		const reasons = reasonsFrom(attemptCalls);
		expect(reasons).not.toContain("weekly_exhausted_429");
		expect(reasons).not.toContain("session_exhausted_429");
	});

	it("records neither quota reason when no window is spent", async () => {
		globalThis.fetch = mockFetch(mock(async () => rejected429()));
		usageCache.set(ACCOUNT_ID, zaiUsage(30, 40) as never);

		const { ctx, attemptCalls } = makeProxyContext();
		await run(ctx, makeZaiAccount());

		const reasons = reasonsFrom(attemptCalls);
		expect(reasons).not.toContain("weekly_exhausted_429");
		expect(reasons).not.toContain("session_exhausted_429");
	});
});
