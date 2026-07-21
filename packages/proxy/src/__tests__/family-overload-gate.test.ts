/**
 * Integration tests for the family-scoped provider-overload gate.
 *
 * Incident: a Haiku-only 529 storm used to trip a single provider-wide
 * "anthropic-upstream" cooldown that gated Opus/Sonnet/Fable traffic too. The
 * breaker is now family-scoped: an open haiku bucket must gate haiku requests
 * (529 terminal, family named in the message) while a sonnet request routes
 * straight through the same account.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
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
			sweep: mock(() => {}),
			dispose: mock(() => {}),
		} as never,
	};
}

function modelRequest(model: string): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
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

describe("family-scoped provider-overload gate", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
	});

	it("an open haiku bucket lets a sonnet request through on the same account", async () => {
		globalThis.fetch = mock(async () => ok200("claude-sonnet-4-5"));
		applyProviderOverloadCooldown("anthropic", undefined, "claude-haiku-4-5");

		const ctx = makeContext([makeAccount()]);
		const res = await callHandleProxy(
			modelRequest("claude-sonnet-4-5"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(200);
	});

	it("an open haiku bucket gates a haiku request with the 529 terminal naming the family", async () => {
		globalThis.fetch = mock(async () => ok200("claude-haiku-4-5"));
		// Beyond the 120s transparent-hold budget → the immediate 529 terminal
		// (a within-budget cooldown would hold the connection instead — Stage D).
		applyProviderOverloadCooldown(
			"anthropic",
			Date.now() + 200_000,
			"claude-haiku-4-5",
		);

		const ctx = makeContext([makeAccount()]);
		const res = await callHandleProxy(
			modelRequest("claude-haiku-4-5"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(529);
		const body = (await res.json()) as {
			error: { type: string; message: string; providers: string[] };
		};
		expect(body.error.type).toBe("overloaded_error");
		expect(body.error.providers).toContain("anthropic");
		expect(body.error.message).toContain("(haiku)");
	});

	it("a provider-wide bucket (no model attribution) still gates every family", async () => {
		globalThis.fetch = mock(async () => ok200("claude-sonnet-4-5"));
		// Beyond the hold budget for the same reason as above.
		applyProviderOverloadCooldown("anthropic", Date.now() + 200_000);

		const ctx = makeContext([makeAccount()]);
		const res = await callHandleProxy(
			modelRequest("claude-sonnet-4-5"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(529);
	});
});
