import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { ServiceUnavailableError } from "@clankermux/core";
import { getProvider } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import { canAttemptStaleTokenRefresh } from "../handlers/token-manager";

/**
 * Reactive stale-token 401 recovery: when an upstream provider returns 401 for an
 * OAuth account (the access token is stale/revoked despite looking valid by its
 * expiry timestamp), proxyWithAccount refreshes the token ONCE and retries the
 * SAME account before failing over to a sibling. Failing over loses the account's
 * per-request prompt cache and can needlessly burn a healthy sibling, so an
 * in-place refresh+retry is preferred when it can fix the request.
 *
 * These tests drive handleProxy end-to-end with a mocked global fetch so the REAL
 * OAuth refresh path runs (provider.refreshToken → platform.claude.com/v1/oauth/token
 * → in-place mutation of account.access_token → recursion → fresh getValidAccessToken).
 * The discriminating assertion is the Authorization bearer sent on the second
 * upstream attempt — it must carry the freshly-refreshed token, not the stale one.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
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
		codex_auto_apply_reset_credits_enabled: false,
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
 * An OAuth account whose access token is well WITHIN its validity window (8h out,
 * far past the 30-min TOKEN_SAFETY_WINDOW_MS) so getValidAccessToken does NOT
 * refresh it proactively — the only path that refreshes it is the reactive-401
 * handler under test. api_key must be null so provider.refreshToken takes the
 * real OAuth flow (a present api_key short-circuits to "console mode").
 */
function makeOAuthAccount(overrides: Partial<Account> = {}): Account {
	return makeAccount({
		id: "anthropic-oauth",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-old",
		access_token: "stale-token",
		expires_at: Date.now() + 8 * 60 * 60 * 1000,
		...overrides,
	});
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
			getAccount: mock(async (id: string) => accounts.find((a) => a.id === id)),
			getActiveComboForFamily: mock(async () => null),
			updateAccountUsage: mock(async () => undefined),
			updateAccountRateLimitMeta: mock(async () => undefined),
			updateAccountTokens: mock(async () => true),
			updateRequestUsage: mock(async () => undefined),
			resetAccountSession: mock(async () => undefined),
			markAccountRateLimited: mock(async () => 1),
			markAccountRateLimitedDeadlineOnly: mock(async () => {}),
			pauseAccount: mock(async () => undefined),
			saveRequest: mock(async () => undefined),
			getAdapter: mock(() => ({
				run: mock(async () => undefined),
				get: mock(async () => null),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test-client" } as never,
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
	};
}

const OAUTH_TOKEN_URL = "platform.claude.com/v1/oauth/token";

/** A minimal, valid non-streaming Anthropic message response body. */
const OK_MESSAGE_BODY = JSON.stringify({
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: "claude-sonnet-4-5",
	content: [{ type: "text", text: "hi" }],
	stop_reason: "end_turn",
	usage: { input_tokens: 5, output_tokens: 2 },
});

const AUTH_ERROR_BODY =
	'{"type":"error","error":{"type":"authentication_error","message":"invalid bearer token"}}';

interface FetchRecorder {
	messageAuthHeaders: (string | null)[];
	oauthRefreshCount: number;
}

/**
 * Install a mocked global fetch with three branches: the pricing catalogue
 * (models.dev), the OAuth refresh endpoint, and the upstream /v1/messages call.
 * `messageResponder` decides what /v1/messages returns for a given attempt index
 * and the Authorization header it carried.
 */
function installFetch(
	messageResponder: (attempt: number, authHeader: string | null) => Response,
	refreshResponder: () => Response,
): FetchRecorder {
	const recorder: FetchRecorder = {
		messageAuthHeaders: [],
		oauthRefreshCount: 0,
	};
	globalThis.fetch = mock(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request =
				input instanceof Request ? input : new Request(String(input), init);
			const urlStr = request.url;
			if (urlStr.includes("models.dev")) {
				return new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (urlStr.includes(OAUTH_TOKEN_URL)) {
				recorder.oauthRefreshCount += 1;
				return refreshResponder();
			}
			// Upstream /v1/messages
			const auth = request.headers.get("authorization");
			const attempt = recorder.messageAuthHeaders.length;
			recorder.messageAuthHeaders.push(auth);
			return messageResponder(attempt, auth);
		},
	) as never;
	return recorder;
}

async function runProxy(
	ctx: ProxyContext,
	req = makeRequest(),
): Promise<Response | null> {
	const { handleProxy } = await import("../proxy");
	try {
		return await handleProxy(
			req,
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
	} catch (err) {
		// Expected terminal state once every attempted account has failed over: an
		// empty pool throws ServiceUnavailableError. Any OTHER error is a real bug
		// (e.g. a leak-guard throw or a logic error) — rethrow so the test fails.
		if (err instanceof ServiceUnavailableError) return null;
		throw err;
	}
}

describe("reactive stale-token 401 refresh + same-account retry", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("refreshes and retries the SAME account when a stale token 401s, then succeeds", async () => {
		// Distinct id per test: the reactive-refresh cooldown is keyed by account.id
		// in a module-level map that persists across tests in the same run.
		const account = makeOAuthAccount({ id: "oauth-success" });
		const recorder = installFetch(
			(_attempt, auth) => {
				// The stale token is rejected; the refreshed token is accepted.
				if (auth === "Bearer stale-token") {
					return new Response(AUTH_ERROR_BODY, {
						status: 401,
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(OK_MESSAGE_BODY, {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
			() =>
				new Response(
					JSON.stringify({
						access_token: "fresh-token",
						expires_in: 3600,
						refresh_token: "refresh-new",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);

		const ctx = makeContext([account]);
		const response = await runProxy(ctx);

		// The retry succeeded on the same account.
		expect(response?.status).toBe(200);
		// Exactly one refresh, and two upstream attempts (stale → fresh).
		expect(recorder.oauthRefreshCount).toBe(1);
		expect(recorder.messageAuthHeaders).toEqual([
			"Bearer stale-token",
			"Bearer fresh-token",
		]);
		// The in-memory account now carries the refreshed token.
		expect(account.access_token).toBe("fresh-token");
	});

	it("fails over when the post-refresh retry ALSO 401s (bounded to one retry)", async () => {
		const account = makeOAuthAccount({ id: "oauth-retry-401" });
		const recorder = installFetch(
			// Always 401, even with the fresh token (e.g. account genuinely revoked).
			() =>
				new Response(AUTH_ERROR_BODY, {
					status: 401,
					headers: { "content-type": "application/json" },
				}),
			() =>
				new Response(
					JSON.stringify({
						access_token: "fresh-token",
						expires_in: 3600,
						refresh_token: "refresh-new",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);

		const ctx = makeContext([account]);
		const response = await runProxy(ctx);

		// Empty pool after failover → no response.
		expect(response).toBeNull();
		// Refreshed once, retried once (two attempts), then gave up — not a storm.
		expect(recorder.oauthRefreshCount).toBe(1);
		expect(recorder.messageAuthHeaders).toEqual([
			"Bearer stale-token",
			"Bearer fresh-token",
		]);
	});

	it("fails over WITHOUT a retry when the refresh itself fails", async () => {
		const account = makeOAuthAccount({ id: "oauth-refresh-fail" });
		const recorder = installFetch(
			() =>
				new Response(AUTH_ERROR_BODY, {
					status: 401,
					headers: { "content-type": "application/json" },
				}),
			// Refresh endpoint is down (transient, NOT invalid_grant) → refresh throws.
			() =>
				new Response('{"error":"server_error"}', {
					status: 500,
					headers: { "content-type": "application/json" },
				}),
		);

		const ctx = makeContext([account]);
		const response = await runProxy(ctx);

		expect(response).toBeNull();
		// Refresh was attempted once and failed; the request was NOT retried.
		expect(recorder.oauthRefreshCount).toBe(1);
		expect(recorder.messageAuthHeaders).toEqual(["Bearer stale-token"]);
	});

	it("does NOT refresh-retry an api-key account with no refresh token", async () => {
		// provider anthropic but api-key-backed (empty refresh_token) → guard skips.
		const account = makeAccount({
			id: "anthropic-apikey",
			provider: "anthropic",
			api_key: "sk-test",
			refresh_token: "",
			access_token: null,
			expires_at: null,
		});
		const recorder = installFetch(
			() =>
				new Response(AUTH_ERROR_BODY, {
					status: 401,
					headers: { "content-type": "application/json" },
				}),
			() =>
				new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);

		const ctx = makeContext([account]);
		const response = await runProxy(ctx);

		expect(response).toBeNull();
		// No OAuth refresh attempted; single upstream attempt then failover.
		expect(recorder.oauthRefreshCount).toBe(0);
		expect(recorder.messageAuthHeaders.length).toBe(1);
	});

	it("does NOT retry when the refresh returns an unchanged token (static credential)", async () => {
		// Some providers store a static credential in refresh_token; a "refresh"
		// returns the same value, so retrying would just 401 again. Guard on the
		// token actually changing → fail over without a pointless retry.
		const account = makeOAuthAccount({
			id: "oauth-static-cred",
			access_token: "static-token",
		});
		const recorder = installFetch(
			() =>
				new Response(AUTH_ERROR_BODY, {
					status: 401,
					headers: { "content-type": "application/json" },
				}),
			// Refresh "succeeds" but hands back the same token it already had.
			() =>
				new Response(
					JSON.stringify({
						access_token: "static-token",
						expires_in: 3600,
						refresh_token: "refresh-old",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);

		const ctx = makeContext([account]);
		const response = await runProxy(ctx);

		expect(response).toBeNull();
		// Refresh ran once, but the unchanged token means NO retry (one attempt).
		expect(recorder.oauthRefreshCount).toBe(1);
		expect(recorder.messageAuthHeaders).toEqual(["Bearer static-token"]);
	});

	it("does NOT re-refresh within the cooldown window on a second request", async () => {
		// First request refreshes (new token) but still 401s → fails over. A second
		// request moments later must NOT trigger another refresh (cooldown), else a
		// perpetually-rejecting account would hammer the token endpoint per request.
		const account = makeOAuthAccount({ id: "oauth-cooldown" });
		const recorder = installFetch(
			// Always 401, regardless of token.
			() =>
				new Response(AUTH_ERROR_BODY, {
					status: 401,
					headers: { "content-type": "application/json" },
				}),
			() =>
				new Response(
					JSON.stringify({
						access_token: "fresh-token",
						expires_in: 3600,
						refresh_token: "refresh-new",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);

		const ctx = makeContext([account]);
		// Request 1: stale → refresh → fresh → 401 → failover.
		expect(await runProxy(ctx)).toBeNull();
		// Request 2 (same account, within cooldown): fresh token → 401 → cooldown
		// blocks a second refresh → failover directly.
		expect(await runProxy(ctx)).toBeNull();

		// Exactly one refresh across BOTH requests.
		expect(recorder.oauthRefreshCount).toBe(1);
		// Attempts: req1 [stale, fresh], req2 [fresh] — no fourth attempt/refresh.
		expect(recorder.messageAuthHeaders).toEqual([
			"Bearer stale-token",
			"Bearer fresh-token",
			"Bearer fresh-token",
		]);
	});

	it("does NOT reactively refresh a qwen account on 401 (no real OAuth exchange)", async () => {
		// Regression: qwen carries a refresh_token but inherits the openai-compatible
		// refreshToken, which echoes the refresh token back as the access token. A
		// reactive refresh there would corrupt the stored access token and retry with
		// the wrong bearer — so qwen must NOT be eligible for the reactive-401 path.
		const account = makeAccount({
			id: "qwen-oauth",
			provider: "qwen",
			api_key: null,
			refresh_token: "qwen-refresh",
			access_token: "qwen-access",
			expires_at: Date.now() + 8 * 60 * 60 * 1000,
		});
		const recorder = installFetch(
			() =>
				new Response(AUTH_ERROR_BODY, {
					status: 401,
					headers: { "content-type": "application/json" },
				}),
			() =>
				new Response(
					JSON.stringify({ access_token: "qwen-refresh", expires_in: 3600 }),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);

		const ctx = makeContext([account]);
		const response = await runProxy(ctx);

		expect(response).toBeNull();
		// No reactive refresh; single attempt then failover.
		expect(recorder.oauthRefreshCount).toBe(0);
		expect(recorder.messageAuthHeaders.length).toBe(1);
		// The stored access token was NOT clobbered with the refresh token.
		expect(account.access_token).toBe("qwen-access");
	});
});

describe("canAttemptStaleTokenRefresh guard", () => {
	it("allows anthropic and codex OAuth accounts with a refresh token", () => {
		expect(
			canAttemptStaleTokenRefresh(
				makeAccount({ provider: "anthropic", refresh_token: "r" }),
			),
		).toBe(true);
		expect(
			canAttemptStaleTokenRefresh(
				makeAccount({ provider: "codex", refresh_token: "r" }),
			),
		).toBe(true);
		expect(
			canAttemptStaleTokenRefresh(
				makeAccount({ provider: "claude-oauth", refresh_token: "r" }),
			),
		).toBe(true);
	});

	it("rejects accounts without a refresh token", () => {
		expect(
			canAttemptStaleTokenRefresh(
				makeAccount({ provider: "anthropic", refresh_token: "" }),
			),
		).toBe(false);
	});

	it("rejects providers whose refresh is a no-op echo (qwen, openai-compatible, ollama)", () => {
		// These carry a refresh_token / report supportsOAuth but do NOT perform a
		// real OAuth exchange — reactively refreshing them corrupts credentials.
		for (const provider of [
			"qwen",
			"openai-compatible",
			"ollama-cloud",
			"zai",
			"minimax",
		]) {
			expect(
				canAttemptStaleTokenRefresh(
					makeAccount({ provider, refresh_token: "r" }),
				),
			).toBe(false);
		}
	});
});
