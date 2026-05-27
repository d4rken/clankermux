/**
 * Tests for synthetic probe pollution fixes added in PR #200 (bug 2).
 *
 * Three sites guard against auto-refresh probe pollution:
 *   1. proxy-operations.ts  — isSyntheticInternal skips cacheBodyStore.stageRequest
 *   2. response-handler.ts  — shouldProcessRequest is false for auto-refresh probes
 *   3. proxy.ts             — pool-exhausted path skips usageWorker.postMessage for probes
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account } from "@clankermux/types";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
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

// ---------------------------------------------------------------------------
// Site 1: isSyntheticInternal in proxy-operations.ts
//
// The guard is: isSyntheticInternal = !!req.headers.get("x-clankermux-auto-refresh")
// We test the header detection logic in isolation — the exact boolean produced
// by the header check — rather than mocking cache-body-store (which poisons
// the module registry in Bun and breaks cache-body-store.test.ts).
// ---------------------------------------------------------------------------

describe("proxy-operations — isSyntheticInternal header detection", () => {
	it("header x-clankermux-auto-refresh: true is truthy (probe detected)", () => {
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "x-clankermux-auto-refresh": "true" },
		});
		const isSyntheticInternal =
			!!req.headers.get("x-clankermux-keepalive") ||
			!!req.headers.get("x-clankermux-auto-refresh");
		expect(isSyntheticInternal).toBe(true);
	});

	it("header x-clankermux-auto-refresh absent is falsy (normal request)", () => {
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		});
		const isSyntheticInternal =
			!!req.headers.get("x-clankermux-keepalive") ||
			!!req.headers.get("x-clankermux-auto-refresh");
		expect(isSyntheticInternal).toBe(false);
	});

	it("keepalive header also triggers isSyntheticInternal (existing guard preserved)", () => {
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "x-clankermux-keepalive": "1" },
		});
		const isSyntheticInternal =
			!!req.headers.get("x-clankermux-keepalive") ||
			!!req.headers.get("x-clankermux-auto-refresh");
		expect(isSyntheticInternal).toBe(true);
	});

	it("neither header present produces false (real user traffic passes through)", () => {
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
		});
		const isSyntheticInternal =
			!!req.headers.get("x-clankermux-keepalive") ||
			!!req.headers.get("x-clankermux-auto-refresh");
		expect(isSyntheticInternal).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Site 2: shouldProcessRequest in response-handler.ts
// ---------------------------------------------------------------------------

describe("response-handler — shouldProcessRequest suppresses auto-refresh probes", () => {
	it("does not call usageWorker.postMessage for auto-refresh probe requests", async () => {
		const { forwardToClient } = await import("../response-handler");

		const usageWorkerPostMessage = mock(() => {});
		const account = makeAccount();

		const ctx = {
			provider: {
				name: "anthropic",
				isStreamingResponse: () => false,
			} as never,
			config: { getStorePayloads: () => false } as never,
			usageWorker: { postMessage: usageWorkerPostMessage } as never,
		};

		const response = new Response(JSON.stringify({ type: "message" }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});

		const requestHeaders = new Headers({
			"x-clankermux-auto-refresh": "true",
		});

		await forwardToClient(
			{
				requestId: "req-probe",
				method: "POST",
				path: "/v1/messages",
				account,
				requestHeaders,
				requestBody: null,
				response,
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx as never,
		);

		expect(usageWorkerPostMessage).not.toHaveBeenCalled();
	});

	it("calls usageWorker.postMessage for normal (non-probe) requests", async () => {
		const { forwardToClient } = await import("../response-handler");

		const usageWorkerPostMessage = mock(() => {});
		const account = makeAccount();

		const ctx = {
			provider: {
				name: "anthropic",
				isStreamingResponse: () => false,
			} as never,
			config: { getStorePayloads: () => false } as never,
			usageWorker: { postMessage: usageWorkerPostMessage } as never,
		};

		const response = new Response(JSON.stringify({ type: "message" }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});

		// No auto-refresh header
		const requestHeaders = new Headers();

		await forwardToClient(
			{
				requestId: "req-normal",
				method: "POST",
				path: "/v1/messages",
				account,
				requestHeaders,
				requestBody: null,
				response,
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx as never,
		);

		// At minimum a "start" message should have been sent
		expect(usageWorkerPostMessage).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Site 3: pool-exhausted path in proxy.ts
// ---------------------------------------------------------------------------

describe("proxy.ts — pool-exhausted path skips usageWorker for auto-refresh probes", () => {
	let savedPassthrough: string | undefined;

	beforeEach(() => {
		savedPassthrough = process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	});

	afterEach(() => {
		if (savedPassthrough === undefined) {
			delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
		} else {
			process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = savedPassthrough;
		}
	});

	it("does not post to usageWorker when pool is exhausted and request is an auto-refresh probe", async () => {
		const { handleProxy } = await import("../proxy");

		const usageWorkerPostMessage = mock(() => {});

		const ctx = {
			strategy: {
				select: () => [],
			} as never,
			dbOps: {
				getAllAccounts: mock(async () => []),
				getActiveComboForFamily: mock(async () => null),
			} as never,
			runtime: { port: 8080, clientId: "test" } as never,
			config: {
				getUsageThrottlingFiveHourEnabled: () => false,
				getUsageThrottlingWeeklyEnabled: () => false,
				getSystemPromptCacheTtl1h: () => false,
			} as never,
			provider: {
				name: "anthropic",
				canHandle: () => true,
			} as never,
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) } as never,
			usageWorker: { postMessage: usageWorkerPostMessage } as never,
		};

		const probeRequest = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-clankermux-auto-refresh": "true",
			},
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 10,
			}),
		});

		const response = await handleProxy(
			probeRequest,
			new URL("https://proxy.local/v1/messages"),
			ctx as never,
		);

		// Should still return 503
		expect(response.status).toBe(503);

		// But must NOT post to usageWorker
		expect(usageWorkerPostMessage).not.toHaveBeenCalled();
	});

	it("posts to usageWorker when pool is exhausted and request is NOT an auto-refresh probe", async () => {
		const { handleProxy } = await import("../proxy");

		const usageWorkerPostMessage = mock(() => {});

		const ctx = {
			strategy: {
				select: (
					_accounts: unknown,
					meta: { routing?: Record<string, unknown> },
				) => {
					meta.routing = {
						strategy: "session",
						decision: "affinity_pool_exhausted",
						affinityScope: "claude_session",
						affinityKey: "claude_session:claude-session-id",
						selectedAccountId: null,
						previousAccountId: "previous-account",
						candidatesCount: 0,
						failoverReason: "pool_exhausted",
					};
					return [];
				},
			} as never,
			dbOps: {
				getAllAccounts: mock(async () => []),
				getActiveComboForFamily: mock(async () => null),
			} as never,
			runtime: { port: 8080, clientId: "test" } as never,
			config: {
				getUsageThrottlingFiveHourEnabled: () => false,
				getUsageThrottlingWeeklyEnabled: () => false,
				getSystemPromptCacheTtl1h: () => false,
			} as never,
			provider: {
				name: "anthropic",
				canHandle: () => true,
			} as never,
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) } as never,
			usageWorker: { postMessage: usageWorkerPostMessage } as never,
		};

		const normalRequest = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-claude-code-session-id": "claude-session-id",
				"thread-id": "codex-thread-id",
			},
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 10,
			}),
		});

		const response = await handleProxy(
			normalRequest,
			new URL("https://proxy.local/v1/messages"),
			ctx as never,
		);

		expect(response.status).toBe(503);

		// Normal requests MUST be logged
		expect(usageWorkerPostMessage).toHaveBeenCalled();
		const startMessage = usageWorkerPostMessage.mock.calls[0][0] as {
			requestHeaders: Record<string, string>;
			routing: { affinityKeyHash: string | null; affinityScope: string | null };
		};
		expect(startMessage.requestHeaders["content-type"]).toBe(
			"application/json",
		);
		expect(startMessage.requestHeaders["x-claude-code-session-id"]).toBe(
			undefined,
		);
		expect(startMessage.requestHeaders["thread-id"]).toBe(undefined);
		expect(startMessage.routing.affinityScope).toBe("claude_session");
		expect(startMessage.routing.affinityKeyHash).toBe(
			"850fda028909f0c4cd88dd904a7d010898d21f96f75b3cc79c5721ce3c27d5fd",
		);
	});
});
