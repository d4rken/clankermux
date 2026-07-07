/**
 * Integration tests for the family-weekly transient-cooldown hold.
 *
 * Incident: an Anthropic account with FREE weekly quota for the requested family
 * (e.g. Fable at 48%) is briefly knocked out of the pool by a short 529 overload
 * / per-account 429 cooldown. The only remaining account is genuinely
 * Fable-exhausted, so the family-weekly terminal fires and returns a misleading
 * 5-day "weekly quota exhausted" 429.
 *
 * The fix: when the pool empties for that reason AND a family-capable sibling is
 * merely on a transient cooldown, hold for its recovery (bounded) and retry —
 * and if the cooldown outlasts the budget, report the SIBLING's cooldown reset,
 * not the multi-day family window.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { usageCache } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";

async function callHandleProxy(req: Request, url: URL, ctx: ProxyContext) {
	const { handleProxy } = await import("../proxy");
	return handleProxy(req, url, ctx);
}

const EXHAUSTED_ID = "acc-exhausted";
const SIBLING_ID = "acc-sibling";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc",
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
	} as Account;
}

/** Seed a fresh usageCache entry: unified 5h/7d windows + optional Fable
 *  weekly_scoped limit. `fableExhausted` at 100% marks the family spent. */
function seedUsage(
	id: string,
	{
		fiveHourUtil,
		sevenDayUtil,
		fableExhausted,
	}: { fiveHourUtil: number; sevenDayUtil: number; fableExhausted: boolean },
) {
	usageCache.set(id, {
		five_hour: {
			utilization: fiveHourUtil,
			resets_at: new Date(Date.now() + 4 * 3_600_000).toISOString(),
		},
		seven_day: {
			utilization: sevenDayUtil,
			resets_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
		},
		limits: fableExhausted
			? [
					{
						kind: "weekly_scoped",
						group: "weekly",
						percent: 100,
						resets_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
						scope: { model: { id: "claude-fable-5", display_name: "Fable" } },
						is_active: true,
					},
				]
			: [],
	} as never);
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

function fableRequest(signal?: AbortSignal): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-fable-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
		signal,
	});
}

function ok200() {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			model: "claude-fable-5",
			stop_reason: "end_turn",
			usage: { input_tokens: 10, output_tokens: 5 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("family-weekly transient-cooldown hold", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
		usageCache.delete(EXHAUSTED_ID);
		usageCache.delete(SIBLING_ID);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
		usageCache.delete(EXHAUSTED_ID);
		usageCache.delete(SIBLING_ID);
	});

	it("holds for a briefly-cooled family-capable sibling and serves it once the cooldown lapses", async () => {
		globalThis.fetch = mock(async () => ok200());
		// Reachable account: Fable exhausted, unified 5h/7d headroom → family-weekly
		// excluded (not account-wide).
		seedUsage(EXHAUSTED_ID, {
			fiveHourUtil: 2,
			sevenDayUtil: 60,
			fableExhausted: true,
		});
		// Sibling: Fable-capable, but on a ~250ms rate-limit cooldown so selection
		// drops it initially; the hold waits it out and retries.
		seedUsage(SIBLING_ID, {
			fiveHourUtil: 10,
			sevenDayUtil: 24,
			fableExhausted: false,
		});

		const exhausted = makeAccount({ id: EXHAUSTED_ID, name: "Main-me" });
		const sibling = makeAccount({
			id: SIBLING_ID,
			name: "Backup1",
			rate_limited_until: Date.now() + 250,
		});
		const ctx = makeContext([exhausted, sibling]);

		const res = await callHandleProxy(
			fableRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(200);
	});

	it("skips the hold and reports the SIBLING cooldown (not the 5-day family window) when the cooldown exceeds the budget", async () => {
		globalThis.fetch = mock(async () => ok200());
		seedUsage(EXHAUSTED_ID, {
			fiveHourUtil: 2,
			sevenDayUtil: 60,
			fableExhausted: true,
		});
		seedUsage(SIBLING_ID, {
			fiveHourUtil: 10,
			sevenDayUtil: 24,
			fableExhausted: false,
		});

		const exhausted = makeAccount({ id: EXHAUSTED_ID, name: "Main-me" });
		// 200s cooldown > 120s hold budget → no hold; report the cooldown directly.
		const sibling = makeAccount({
			id: SIBLING_ID,
			name: "Backup1",
			rate_limited_until: Date.now() + 200_000,
		});
		const ctx = makeContext([exhausted, sibling]);

		const res = await callHandleProxy(
			fableRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(429);
		expect(res.headers.get("x-clankermux-pool-status")).toBe(
			"family-weekly-sibling-cooldown",
		);
		// Retry-After reflects the ~200s cooldown, NOT the 5-day family reset.
		const retryAfter = Number(res.headers.get("Retry-After"));
		expect(retryAfter).toBeGreaterThan(150);
		expect(retryAfter).toBeLessThanOrEqual(200);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain("Backup1");
	});

	it("returns the genuine family-exhausted 429 when NO family-capable sibling exists", async () => {
		globalThis.fetch = mock(async () => ok200());
		// Both accounts Fable-exhausted; the sibling is also on a cooldown, but it is
		// NOT family-capable, so there is nothing to hold for.
		seedUsage(EXHAUSTED_ID, {
			fiveHourUtil: 2,
			sevenDayUtil: 60,
			fableExhausted: true,
		});
		seedUsage(SIBLING_ID, {
			fiveHourUtil: 2,
			sevenDayUtil: 60,
			fableExhausted: true,
		});

		const exhausted = makeAccount({ id: EXHAUSTED_ID, name: "Main-me" });
		const sibling = makeAccount({
			id: SIBLING_ID,
			name: "Backup1",
			rate_limited_until: Date.now() + 30_000,
		});
		const ctx = makeContext([exhausted, sibling]);

		const res = await callHandleProxy(
			fableRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(429);
		expect(res.headers.get("x-clankermux-pool-status")).toBe(
			"family-weekly-exhausted",
		);
	});
});
