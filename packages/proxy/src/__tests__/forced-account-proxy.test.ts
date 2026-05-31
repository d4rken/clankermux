import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import { setForcedAccount } from "../handlers";

mock.module("../inline-worker", () => ({
	EMBEDDED_WORKER_CODE: "",
}));

async function callHandleProxy(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	isInternal = false,
) {
	const { handleProxy } = await import("../proxy");
	return handleProxy(req, url, ctx, null, null, isInternal);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		// Unknown provider name → getProvider() returns undefined → handleProxy
		// falls back to ctx.provider (our mock), giving deterministic upstream
		// behaviour with no real provider transforms.
		provider: "test-provider" as Account["provider"],
		api_key: "test-key",
		refresh_token: "",
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

/**
 * Build a ProxyContext whose ctx.provider is a controllable mock and whose
 * dbOps.getAccount resolves the forced account by id. selectAccountsForRequest
 * is driven by a strategy.select that returns all non-paused/non-limited
 * accounts (so we can assert the forced path bypasses selection).
 */
function makeContext(
	accounts: Account[],
	opts: {
		providerName?: string;
	} = {},
): { ctx: ProxyContext } {
	const ctx: ProxyContext = {
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
			markAccountRateLimited: mock(async () => {}),
			saveRequest: mock(async () => {}),
			getAdapter: mock(() => ({
				run: mock(async () => {}),
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
		provider: {
			name: opts.providerName ?? "test-provider",
			canHandle: () => true,
			buildUrl: () => "https://upstream.local/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: "allowed",
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		requestRecorder: {
			begin: mock(() => {}),
			captureResponseChunk: mock(() => {}),
			finishTransport: mock(() => {}),
			attachUsageSummary: mock(() => {}),
			markUsageUnavailable: mock(() => {}),
			recordSynthetic: mock(() => {}),
			onWorkerGone: mock(() => {}),
			sweep: mock(() => {}),
			dispose: mock(() => {}),
		} as never,
	};

	return { ctx };
}

function jsonResponse(body: object, status: number) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function makeRequest(headers: Record<string, string> = {}) {
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

describe("force-account proxy override", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		setForcedAccount(null);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		setForcedAccount(null);
	});

	it("returns the forced account's 429 as-is with NO failover to a second healthy account", async () => {
		const forced = makeAccount({ id: "forced-1", name: "Forced-1" });
		const healthy = makeAccount({ id: "healthy-2", name: "Healthy-2" });

		// Track which target each fetch hit. Only the forced account should be
		// called — never the second healthy account.
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return jsonResponse(
				{ error: { type: "rate_limit_error", message: "Rate limited" } },
				429,
			);
		});

		const { ctx } = makeContext([forced, healthy]);
		setForcedAccount("forced-1");

		const response = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// The forced 429 is returned to the client as-is.
		expect(response.status).toBe(429);
		// Exactly ONE upstream request — no failover retry to the second account.
		expect(fetchCount).toBe(1);
		// No cooldown mutation on the forced account.
		expect(forced.rate_limited_until).toBeNull();
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock
		>;
		expect(markMock.mock.calls).toHaveLength(0);
		// Request was still recorded (history intact).
		const beginMock = ctx.requestRecorder.begin as ReturnType<typeof mock>;
		expect(beginMock.mock.calls.length).toBeGreaterThan(0);
	});

	it("returns the forced account's 529 as-is without provider-overload cooldown", async () => {
		const forced = makeAccount({ id: "forced-1", name: "Forced-1" });
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return jsonResponse(
				{ error: { type: "overloaded_error", message: "Overloaded" } },
				529,
			);
		});

		const { ctx } = makeContext([forced]);
		setForcedAccount("forced-1");

		const response = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(529);
		expect(fetchCount).toBe(1);
		expect(forced.rate_limited_until).toBeNull();
	});

	it("attempts a context-window-too-large request on a forced Codex account (no 400 gate)", async () => {
		// A Codex account would normally be excluded by the context-window gate
		// for an oversized request (400 context_window_exceeded). Forced mode must
		// bypass the gate and attempt the request upstream.
		const forcedCodex = makeAccount({
			id: "codex-forced",
			name: "Codex-forced",
			// Use a real codex provider so the gate would normally apply — but the
			// forced path never reaches the gate. getProvider("codex") returns the
			// real codex provider; we mock fetch so the upstream call is captured.
			provider: "codex",
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});

		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return jsonResponse(
				{
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					model: "gpt-5.5",
					stop_reason: "end_turn",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
				200,
			);
		});

		const { ctx } = makeContext([forcedCodex], { providerName: "codex" });
		setForcedAccount("codex-forced");

		// An oversized opus request (would be gated for the codex account).
		const largeReq = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "claude-opus-4-7",
				messages: [{ role: "user", content: "x".repeat(2_000_000) }],
				max_tokens: 16,
			}),
		});

		const response = await callHandleProxy(
			largeReq,
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// Not a 400 context_window_exceeded gate error — the upstream call happened.
		expect(response.status).not.toBe(400);
		expect(fetchCount).toBe(1);
	});

	it("internal/auto-refresh request bypasses force and runs normal selection", async () => {
		const forced = makeAccount({ id: "forced-1", name: "Forced-1" });
		const getAccountMock = mock(async () => forced);

		const { ctx } = makeContext([forced]);
		(ctx.dbOps as unknown as { getAccount: typeof getAccountMock }).getAccount =
			getAccountMock;
		setForcedAccount("forced-1");

		globalThis.fetch = mock(async () => jsonResponse({ ok: true }, 200));

		await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
			true, // isInternal
		);

		// The forced short-circuit looks up the forced account via getAccount;
		// for an internal request it must NOT be consulted (force bypassed).
		expect(getAccountMock.mock.calls).toHaveLength(0);
	});

	it("missing forced id returns 503 forced_account_missing AND auto-clears the force", async () => {
		const other = makeAccount({ id: "other-1", name: "Other-1" });
		const { ctx } = makeContext([other]);
		// Force points at an account that does not exist.
		setForcedAccount("ghost-account");

		globalThis.fetch = mock(async () => jsonResponse({ ok: true }, 200));

		const response = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(503);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("forced_account_missing");

		// Force was auto-cleared.
		const { getForcedAccount } = await import("../handlers");
		expect(getForcedAccount()).toBeNull();
	});

	it("token-resolution throw returns a local 502 error Response (not null/failover)", async () => {
		// A claude-oauth account with no usable token forces getValidAccessToken to
		// attempt a refresh, which throws because there is no provider/refresh path.
		const forced = makeAccount({
			id: "forced-oauth",
			name: "Forced-OAuth",
			provider: "claude-oauth",
			api_key: null,
			refresh_token: "expired-refresh-token",
			access_token: null,
			expires_at: 1, // already expired → triggers refresh attempt
		});

		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return jsonResponse({ ok: true }, 200);
		});

		const { ctx } = makeContext([forced], { providerName: "anthropic" });
		setForcedAccount("forced-oauth");

		const response = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// A local error Response — never a thrown ServiceUnavailableError, never
		// null/failover. Token resolution failed before any upstream call.
		expect(response.status).toBe(502);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("forced_account_unavailable");
		expect(fetchCount).toBe(0);
	});

	it("records a forced-mode token-resolution failure in history (recorder begin fires)", async () => {
		// The forced upstream response is recorded via forwardToClient; this
		// asserts the forced LOCAL error (dead-token throw) is ALSO recorded so a
		// forced account with an unrefreshable token still shows up in Request
		// History rather than vanishing.
		const forced = makeAccount({
			id: "forced-oauth-rec",
			name: "Forced-OAuth-Rec",
			provider: "claude-oauth",
			api_key: null,
			refresh_token: "expired-refresh-token",
			access_token: null,
			expires_at: 1, // already expired → triggers refresh attempt → throw
		});

		globalThis.fetch = mock(async () => jsonResponse({ ok: true }, 200));

		const { ctx } = makeContext([forced], { providerName: "anthropic" });
		setForcedAccount("forced-oauth-rec");

		const response = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// Local error returned (token resolution failed pre-upstream).
		expect(response.status).toBe(502);

		// The local failure was recorded under the forced account: recorder.begin
		// fired (forwardToClient's start/recorder path) AND it was attributed to
		// the forced account, not NO_ACCOUNT/null.
		const beginMock = ctx.requestRecorder.begin as ReturnType<typeof mock>;
		expect(beginMock.mock.calls.length).toBeGreaterThan(0);
		const recordMeta = beginMock.mock.calls[0][0] as {
			accountId: string | null;
			responseStatus: number;
		};
		expect(recordMeta.accountId).toBe("forced-oauth-rec");
		expect(recordMeta.responseStatus).toBe(502);
	});
});
