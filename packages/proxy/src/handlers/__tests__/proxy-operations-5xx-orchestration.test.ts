import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getProvider } from "@clankermux/providers";
import { makeAccount as canonicalAccount } from "@clankermux/test-support";
import type { Account } from "@clankermux/types";
import { handleProxy } from "../../__tests__/fixtures/routing-harness";
import { clearProviderOverloadCooldown } from "../../provider-overload-cooldown";
import type { ProxyContext } from "../proxy-types";

/**
 * The per-attempt tests in proxy-operations-5xx-failover.test.ts pin what ONE
 * attempt returns. This one pins the thing the user actually asked for: a pool
 * with a healthy sibling serves the request instead of handing the client the
 * first account's server error.
 */

function makeAccount(id: string): Account {
	return canonicalAccount({
		id,
		name: id,
		provider: "anthropic",
		api_key: null,
		access_token: "at-token",
		refresh_token: "rt-token",
		expires_at: Date.now() + 3_600_000,
		created_at: Date.now(),
		custom_endpoint: null,
	});
}

function makeRequest(): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
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
			select: mock((all: Account[]) => all),
			peekRanked: mock((all: Account[]) => all),
			peek: mock((all: Account[]) => all[0]?.id ?? null),
		},
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
			updateAccountUsage: mock(async () => undefined),
			updateAccountRateLimitMeta: mock(async () => undefined),
			updateAccountTokens: mock(async () => true),
			updateRequestUsage: mock(async () => undefined),
			resetAccountSession: mock(async () => undefined),
			markAccountRateLimited: mock(async () => 1),
			markAccountRateLimitedDeadlineOnly: mock(async () => {}),
			saveRequest: mock(async () => undefined),
			getAdapter: mock(() => ({
				run: mock(async () => undefined),
				get: mock(async () => null),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getCacheWarmingEnabled: () => false,
			getCacheWarmingMinTokens: () => 100_000,
			getStorePayloads: () => true,
		} as never,
		provider: getProvider("anthropic") as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => undefined) } as never,
		requestRecorder: {
			begin: mock(() => undefined),
			captureResponseChunk: mock(() => undefined),
			finishTransport: mock(() => undefined),
			attachUsageSummary: mock(() => undefined),
			markUsageUnavailable: mock(() => undefined),
			recordSynthetic: mock(() => undefined),
			sweep: mock(() => undefined),
			dispose: mock(() => undefined),
		} as never,
	} as unknown as ProxyContext;
}

describe("pool orchestration — a transient 5xx reaches the healthy sibling", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
	});

	it("serves the request from the second account after the first returns 500", async () => {
		let upstreamCalls = 0;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const url = input instanceof Request ? input.url : String(input);
			// The pricing catalogue fetch must not be counted as an attempt.
			if (url.includes("models.dev")) {
				return new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			upstreamCalls += 1;
			if (upstreamCalls === 1) {
				return new Response(
					JSON.stringify({
						type: "error",
						error: { type: "api_error", message: "Internal server error" },
					}),
					{ status: 500, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: "claude-sonnet-4-5",
					content: [{ type: "text", text: "ok" }],
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as never;

		const accounts = [makeAccount("acct-broken"), makeAccount("acct-healthy")];
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			makeContext(accounts),
		);

		expect(response.status).toBe(200);
		expect(upstreamCalls).toBe(2);
		// The 500 must not have invented quota state on the way past.
		expect(accounts[0].rate_limited_until).toBeNull();
		expect(accounts[0].rate_limited_reason).toBeNull();
	});
});
