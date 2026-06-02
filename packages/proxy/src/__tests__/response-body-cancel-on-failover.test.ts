import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getProvider } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";

/**
 * Regression: failover/return-null paths in proxy-operations.ts MUST cancel the
 * abandoned upstream response body. At Bun 1.3.x a fetch() Response body that is
 * neither read to EOF nor cancelled keeps its socket + ~512 KB native read
 * buffer committed forever — an off-heap leak that ratchets up with every 429 /
 * 401 / 529 failover under load (observed: ~1.6 GB/h on the live proxy). These
 * tests drive a real upstream error through handleProxy with a body backed by a
 * ReadableStream whose cancel() is spied, and assert the body was cancelled.
 */

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

/**
 * Drive handleProxy and swallow the ServiceUnavailableError it throws once every
 * attempted account has failed over (it only RETURNS a 503 for an empty pool).
 * The body cancellation we assert on happens inside proxyWithAccount before the
 * failover `return null`, so it occurs regardless of the terminal throw.
 */
async function runFailover(ctx: ProxyContext): Promise<void> {
	const { handleProxy } = await import("../proxy");
	try {
		await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
	} catch {
		// Expected: all attempted accounts failed → ServiceUnavailableError.
	}
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
			getSystemPromptCacheTtl1h: () => false,
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
	};
}

/**
 * Build an error Response whose body is a ReadableStream we can observe. The
 * returned `cancelled` ref flips true if the proxy cancels the body (the leak
 * fix); it stays false if the body is dropped on the floor (the leak).
 */
function errorResponseWithObservableBody(
	status: number,
	json: string,
	headers: Record<string, string> = {},
): { response: Response; state: { cancelled: boolean; fullyRead: boolean } } {
	const state = { cancelled: false, fullyRead: false };
	const payload = new TextEncoder().encode(json);
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(payload);
			controller.close();
			state.fullyRead = true;
		},
		cancel() {
			state.cancelled = true;
		},
	});
	const response = new Response(body, {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
	return { response, state };
}

describe("failover cancels the abandoned upstream response body", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("cancels the 429 body on the no-model-fallback failover (return null)", async () => {
		const account = makeAccount({ id: "anthropic-a", provider: "anthropic" });
		const { response, state } = errorResponseWithObservableBody(
			429,
			'{"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}',
			{ "retry-after": "60" },
		);

		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));
			// Don't let the pricing-catalogue fetch (models.dev) interfere.
			if (request.url.includes("models.dev")) {
				return new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return response;
		}) as never;

		const ctx = makeContext([account]);
		await runFailover(ctx);

		// The abandoned 429 body must be cancelled (or drained), never dropped.
		expect(state.cancelled || state.fullyRead).toBe(true);
		expect(state.cancelled).toBe(true);
	});

	it("cancels the 401 body on the auth-failure failover (return null)", async () => {
		const account = makeAccount({ id: "anthropic-a", provider: "anthropic" });
		const { response, state } = errorResponseWithObservableBody(
			401,
			'{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
		);

		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));
			if (request.url.includes("models.dev")) {
				return new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return response;
		}) as never;

		const ctx = makeContext([account]);
		await runFailover(ctx);

		expect(state.cancelled).toBe(true);
	});
});
