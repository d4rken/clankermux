import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getProvider } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
	getProviderOverloadUntil,
	isProviderOverloaded,
} from "../provider-overload-cooldown";

mock.module("../inline-worker", () => ({
	EMBEDDED_WORKER_CODE: "",
}));

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
		api_key: "test-key",
		refresh_token: "",
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
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

function makeRequest(headers: Record<string, string> = {}): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

function makeContext(accounts: Account[]): ProxyContext {
	return {
		strategy: {
			select: mock((allAccounts: Account[]) => allAccounts),
		},
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
			updateAccountUsage: mock(async () => undefined),
			updateAccountRateLimitMeta: mock(async () => undefined),
			updateAccountTokens: mock(async () => undefined),
			updateRequestUsage: mock(async () => undefined),
			resetAccountSession: mock(async () => undefined),
			markAccountRateLimited: mock(async () => 1),
			getAdapter: mock(() => ({
				run: mock(async () => undefined),
				get: mock(async () => null),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getStorePayloads: () => true,
		} as never,
		provider: getProvider("anthropic") as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => undefined) } as never,
		usageWorker: { postMessage: mock(() => undefined) } as never,
	};
}

describe("provider overload cooldown", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
	});

	it("skips remaining Anthropic accounts after official Anthropic 529 and falls back cross-provider", async () => {
		const anthropicA = makeAccount({
			id: "anthropic-a",
			name: "Anthropic A",
			provider: "anthropic",
			api_key: "anthropic-key-a",
		});
		const anthropicB = makeAccount({
			id: "anthropic-b",
			name: "Anthropic B",
			provider: "anthropic",
			api_key: "anthropic-key-b",
		});
		const consoleAccount = makeAccount({
			id: "console-a",
			name: "Console A",
			provider: "claude-console-api",
			api_key: "console-key",
		});
		const fallback = makeAccount({
			id: "openai-fallback",
			name: "OpenAI fallback",
			provider: "openai-compatible",
			api_key: "fallback-key",
			custom_endpoint: "https://fallback.example/v1",
			model_mappings: JSON.stringify({ sonnet: "gpt-4o" }),
		});
		const calls: string[] = [];

		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));
			calls.push(request.url);

			if (request.url.includes("api.anthropic.com")) {
				return new Response(
					'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
					{
						status: 529,
						headers: {
							"content-type": "application/json",
							"retry-after": "60",
						},
					},
				);
			}

			return new Response(
				JSON.stringify({
					id: "chatcmpl_1",
					object: "chat.completion",
					model: "gpt-4o",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "fallback ok" },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		const ctx = makeContext([anthropicA, anthropicB, consoleAccount, fallback]);
		const { handleProxy } = await import("../proxy");
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(200);
		expect(calls).toHaveLength(2);
		expect(calls[0]).toContain("api.anthropic.com");
		expect(calls[1]).toContain("fallback.example");
		expect(isProviderOverloaded("anthropic")).toBe(true);
		expect(isProviderOverloaded("claude-console-api")).toBe(true);
		expect(anthropicA.rate_limited_until).toBeNull();
		expect(anthropicB.rate_limited_until).toBeNull();
		expect(consoleAccount.rate_limited_until).toBeNull();
	});

	it("forwards the first 529 without trying another same-upstream Anthropic account when no cross-provider fallback exists", async () => {
		const anthropicA = makeAccount({
			id: "anthropic-a",
			name: "Anthropic A",
			provider: "anthropic",
			api_key: "anthropic-key-a",
		});
		const anthropicB = makeAccount({
			id: "anthropic-b",
			name: "Anthropic B",
			provider: "anthropic",
			api_key: "anthropic-key-b",
		});
		const calls: string[] = [];

		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));
			calls.push(request.url);
			return new Response(
				'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
				{
					status: 529,
					headers: {
						"content-type": "application/json",
						"retry-after": "60",
					},
				},
			);
		});

		const ctx = makeContext([anthropicA, anthropicB]);
		const { handleProxy } = await import("../proxy");
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(529);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("api.anthropic.com");
		expect(isProviderOverloaded("anthropic")).toBe(true);
		expect(anthropicA.rate_limited_until).toBeNull();
		expect(anthropicB.rate_limited_until).toBeNull();
	});

	it("returns and records 529 during an active official Anthropic cooldown when no cross-provider account remains", async () => {
		const now = Date.UTC(2026, 4, 29, 12, 0, 0);
		const originalDateNow = Date.now;
		const calls: string[] = [];

		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));
			calls.push(request.url);
			return new Response("unexpected", { status: 500 });
		});

		Date.now = () => now;
		try {
			applyProviderOverloadCooldown("anthropic", now + 60_000);
			const ctx = makeContext([
				makeAccount({ id: "anthropic-a", provider: "anthropic" }),
				makeAccount({ id: "console-a", provider: "claude-console-api" }),
			]);
			const usageWorkerPostMessage = (
				ctx.usageWorker as { postMessage: ReturnType<typeof mock> }
			).postMessage;
			const { handleProxy } = await import("../proxy");
			const response = await handleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);

			expect(response.status).toBe(529);
			expect(response.headers.get("Retry-After")).toBe("60");
			const body = (await response.json()) as {
				error: { type: string; providers: string[] };
			};
			expect(body.error.type).toBe("overloaded_error");
			expect(body.error.providers).toEqual(["anthropic"]);
			expect(calls).toHaveLength(0);
			expect(usageWorkerPostMessage).toHaveBeenCalledTimes(2);
			expect(usageWorkerPostMessage.mock.calls[0][0]).toMatchObject({
				type: "start",
				accountId: null,
				responseStatus: 529,
				providerName: "anthropic",
			});
			expect(usageWorkerPostMessage.mock.calls[1][0]).toMatchObject({
				type: "end",
				success: false,
				error: "provider_overloaded",
			});
		} finally {
			Date.now = originalDateNow;
		}
	});

	it("does not record synthetic provider-overload 529s for auto-refresh probes", async () => {
		const now = Date.UTC(2026, 4, 29, 12, 0, 0);
		const originalDateNow = Date.now;

		Date.now = () => now;
		try {
			applyProviderOverloadCooldown("anthropic", now + 60_000);
			const ctx = makeContext([
				makeAccount({ id: "anthropic-a", provider: "anthropic" }),
			]);
			const usageWorkerPostMessage = (
				ctx.usageWorker as { postMessage: ReturnType<typeof mock> }
			).postMessage;
			const { handleProxy } = await import("../proxy");
			const response = await handleProxy(
				makeRequest({ "x-clankermux-auto-refresh": "true" }),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);

			expect(response.status).toBe(529);
			expect(usageWorkerPostMessage).not.toHaveBeenCalled();
		} finally {
			Date.now = originalDateNow;
		}
	});

	it("caps long overload reset headers, extends cooldowns, and expires the shared Anthropic group", () => {
		let now = Date.UTC(2026, 4, 29, 12, 0, 0);
		const originalDateNow = Date.now;

		Date.now = () => now;
		try {
			const cappedUntil = applyProviderOverloadCooldown(
				"anthropic",
				now + 60 * 60_000,
			);
			expect(cappedUntil).toBe(now + 5 * 60_000);
			expect(getProviderOverloadUntil("claude-console-api")).toBe(cappedUntil);

			const shorterUntil = applyProviderOverloadCooldown(
				"claude-console-api",
				now + 60_000,
			);
			expect(shorterUntil).toBe(cappedUntil);

			now = cappedUntil + 1;
			expect(isProviderOverloaded("anthropic")).toBe(false);
			expect(getProviderOverloadUntil("claude-console-api")).toBeNull();
		} finally {
			Date.now = originalDateNow;
		}
	});
});
