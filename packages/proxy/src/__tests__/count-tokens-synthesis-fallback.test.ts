import { describe, expect, it, mock } from "bun:test";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import { handleProxy } from "../proxy";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "codex",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
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

function makeContext(accounts: Account[]): ProxyContext {
	return {
		strategy: {
			select: (accs: Account[]) => {
				// Mirror the pool-exhausted harness: drop paused / rate-limited accounts.
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
			getActiveComboForFamily: mock(async () => null),
			getApiKeyPin: mock(async () => null),
			saveRequest: mock(async () => {}),
			updateAccountUsage: mock(async () => {}),
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
			name: "codex",
			canHandle: () => true,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		requestRecorder: {
			recordSynthetic: mock(() => {}),
			begin: mock(() => {}),
		} as never,
	};
}

function makeCountTokensRequest(): Request {
	return new Request("https://proxy.local/v1/messages/count_tokens", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello world" }],
		}),
	});
}

describe("count_tokens last-resort synthesis when pool is exhausted", () => {
	it("synthesizes a 200 input_tokens from a gated-out Codex account instead of 503", async () => {
		// The only account is a non-paused Codex account that is rate-limited, so
		// selection gates it out → accounts.length === 0. A /v1/messages request
		// would 503 here (see pool-exhausted.test.ts); count_tokens must NOT.
		const fetchMock = mock(async () => {
			throw new Error("count_tokens synthesis must not hit upstream");
		});
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as typeof globalThis.fetch;
		try {
			const rateLimitedCodex = makeAccount({
				id: "acc-codex",
				name: "codex-account",
				provider: "codex",
				rate_limited_until: Date.now() + 60_000,
			});
			const ctx = makeContext([rateLimitedCodex]);

			const response = await handleProxy(
				makeCountTokensRequest(),
				new URL("https://proxy.local/v1/messages/count_tokens"),
				ctx,
			);

			expect(fetchMock).toHaveBeenCalledTimes(0);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { input_tokens?: number };
			expect(typeof body.input_tokens).toBe("number");
			expect(body.input_tokens as number).toBeGreaterThan(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("still returns 503 for a real /v1/messages request when the pool is exhausted", async () => {
		// Guard: the count_tokens carve-out must not change normal pool-exhausted
		// behavior for billable traffic.
		const rateLimitedCodex = makeAccount({
			id: "acc-codex",
			name: "codex-account",
			provider: "codex",
			rate_limited_until: Date.now() + 60_000,
		});
		const ctx = makeContext([rateLimitedCodex]);

		const response = await handleProxy(
			new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "claude-sonnet-4-5",
					messages: [{ role: "user", content: "hello" }],
					max_tokens: 16,
				}),
			}),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(503);
	});

	it("respects an Anthropic pin: does NOT substitute Codex for a pinned key", async () => {
		// API key pinned to the anthropic provider, with every account gated out.
		// The Codex account must NOT answer count_tokens — that would violate the
		// pin. Expect the pinned-target-unavailable terminal, not a synthesized 200.
		const fetchMock = mock(async () => {
			throw new Error("pinned count_tokens must not synthesize from Codex");
		});
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as typeof globalThis.fetch;
		try {
			const rateLimitedAnthropic = makeAccount({
				id: "acc-anthropic",
				name: "anthropic-account",
				provider: "anthropic",
				rate_limited_until: Date.now() + 60_000,
			});
			const rateLimitedCodex = makeAccount({
				id: "acc-codex",
				name: "codex-account",
				provider: "codex",
				rate_limited_until: Date.now() + 60_000,
			});
			const ctx = makeContext([rateLimitedAnthropic, rateLimitedCodex]);
			ctx.dbOps.getApiKeyPin = mock(async () => ({
				pinnedAccountId: null,
				pinnedProviders: ["anthropic"],
			})) as never;

			const response = await handleProxy(
				makeCountTokensRequest(),
				new URL("https://proxy.local/v1/messages/count_tokens"),
				ctx,
				"key-1",
				"pinned-key",
			);

			expect(fetchMock).toHaveBeenCalledTimes(0);
			expect(response.status).toBe(503);
			expect(response.headers.get("x-clankermux-pool-status")).toBe(
				"pinned-target-unavailable",
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
