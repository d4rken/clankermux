/**
 * Integration test for the family-weekly repeat-429 loop, through handleProxy.
 *
 * Incident (2026-08-17): eighteen `claude-fable-5` requests went to one account
 * between 07:15:25 and 07:22:52, every one answered `429` with the family's
 * weekly window rejected, every one `failover_attempts = 0`, each costing ~800ms
 * upstream. The reactive rung classified all eighteen correctly — and then
 * discarded the finding each time, because it deliberately applies no
 * account-wide cooldown and had nowhere family-scoped to put it. The proactive
 * gate re-derived eligibility from a usage cache that still reported headroom,
 * picked the same account, and the loop closed.
 *
 * What is pinned here is the SECOND request: once a 429 has said "this family is
 * spent on this account", the next request for that family must not go there
 * again — while a request for a DIFFERENT family on the same account still must,
 * since the reactive rung's no-account-wide-cooldown decision is what keeps the
 * rest of the account usable.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { usageCache } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import { resetFamilyWeeklyMemoForTests } from "../family-weekly-memo";
import type { ProxyContext } from "../handlers";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";

async function callHandleProxy(req: Request, url: URL, ctx: ProxyContext) {
	const { handleProxy } = await import("../proxy");
	return handleProxy(req, url, ctx);
}

const EXHAUSTED_ID = "acc-fable-spent";
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

/**
 * The 429 the exhausted account answers with: account-wide 5h/7d reporting
 * headroom while the Fable-scoped weekly claim (`7d_oi`) is rejected. This is
 * the shape the reactive rung reads when the usage cache has nothing fresh to
 * say — which is precisely the evidence-starved state that let the loop run.
 */
function fableWeeklyRejected429(): Response {
	const resetSeconds = Math.floor((Date.now() + 5 * 86_400_000) / 1000);
	return new Response(JSON.stringify({ type: "error", error: {} }), {
		status: 429,
		headers: {
			"anthropic-ratelimit-unified-5h-reset": String(
				Math.floor((Date.now() + 4 * 3_600_000) / 1000),
			),
			"anthropic-ratelimit-unified-5h-status": "allowed",
			"anthropic-ratelimit-unified-5h-utilization": "0.1",
			"anthropic-ratelimit-unified-7d-reset": String(resetSeconds),
			"anthropic-ratelimit-unified-7d-status": "allowed_warning",
			"anthropic-ratelimit-unified-7d-utilization": "0.6",
			"anthropic-ratelimit-unified-7d_oi-reset": String(resetSeconds),
			"anthropic-ratelimit-unified-7d_oi-status": "rejected",
			"anthropic-ratelimit-unified-7d_oi-utilization": "1.0",
			"anthropic-ratelimit-unified-reset": String(resetSeconds),
			"anthropic-ratelimit-unified-status": "rejected",
			"content-type": "application/json",
			"retry-after": "432000",
		},
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
			hasRecord: mock(() => false),
			sweep: mock(() => {}),
			dispose: mock(() => {}),
		} as never,
	};
}

function request(model: string): Request {
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

const URL_MESSAGES = new URL("https://proxy.local/v1/messages");

describe("family-weekly repeat-429 loop", () => {
	let originalFetch: typeof globalThis.fetch;
	/** Which account each upstream call was authenticated as. */
	let hits: string[];

	const reset = () => {
		clearProviderOverloadCooldown();
		resetRateLimitProbeGatesForTests();
		resetFamilyWeeklyMemoForTests();
		usageCache.delete(EXHAUSTED_ID);
		usageCache.delete(SIBLING_ID);
	};

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		hits = [];
		reset();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		reset();
	});

	/**
	 * Upstream that answers as the account whose key it was called with: the
	 * Fable-spent account returns the family-rejected 429, everyone else 200s.
	 * Deliberately no usageCache seeding — the cache being unable to say anything
	 * fresh is the state that let the loop run in production.
	 */
	function installUpstream(accounts: Account[]) {
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			// The proxy calls fetch with a Request object, so the URL, headers and
			// body all live on it rather than in `init` — `String(input)` would
			// yield "[object Request]".
			const asRequest = input instanceof Request ? input : null;
			const url = asRequest ? asRequest.url : String(input);
			const headers = asRequest
				? asRequest.headers
				: new Headers(init?.headers as HeadersInit);
			if (!url.includes("/v1/messages")) {
				return new Response("{}", { status: 200 });
			}

			const key =
				headers.get("x-api-key") ??
				headers.get("authorization")?.replace(/^Bearer /, "") ??
				"";
			const account = accounts.find((a) => a.api_key === key);
			hits.push(account?.id ?? `unknown:${key}`);

			const rawBody = asRequest
				? await asRequest.clone().text()
				: String(init?.body ?? "{}");
			const body = JSON.parse(rawBody || "{}") as { model?: string };
			if (account?.id === EXHAUSTED_ID && body.model === "claude-fable-5") {
				return fableWeeklyRejected429();
			}
			return ok200(body.model ?? "claude-fable-5");
		}) as typeof globalThis.fetch;
	}

	function accountPair(): Account[] {
		return [
			makeAccount({
				id: EXHAUSTED_ID,
				name: "fable-spent",
				api_key: "key-spent",
				priority: 0,
			}),
			makeAccount({
				id: SIBLING_ID,
				name: "sibling",
				api_key: "key-sibling",
				priority: 1,
			}),
		];
	}

	it("stops re-sending the same family to an account a 429 already refused", async () => {
		const accounts = accountPair();
		installUpstream(accounts);
		const ctx = makeContext(accounts);

		// First Fable request: discovers the exhaustion the only way available —
		// by asking, and being refused. It then fails over to the sibling.
		const first = await callHandleProxy(
			request("claude-fable-5"),
			URL_MESSAGES,
			ctx,
		);
		expect(first.status).toBe(200);
		expect(hits).toContain(EXHAUSTED_ID);

		// Second Fable request: must NOT ask the refused account again. This is
		// the assertion the incident violated eighteen times.
		hits = [];
		const second = await callHandleProxy(
			request("claude-fable-5"),
			URL_MESSAGES,
			ctx,
		);
		expect(second.status).toBe(200);
		expect(hits).not.toContain(EXHAUSTED_ID);
		expect(hits).toContain(SIBLING_ID);
	});

	it("keeps the same account serving its other families", async () => {
		const accounts = accountPair();
		installUpstream(accounts);
		const ctx = makeContext(accounts);

		await callHandleProxy(request("claude-fable-5"), URL_MESSAGES, ctx);

		// Sonnet on the Fable-spent account is untouched: the reactive rung
		// withholds an account-wide cooldown on purpose, and a family-scoped memo
		// must not quietly reinstate one.
		hits = [];
		const sonnet = await callHandleProxy(
			request("claude-sonnet-4-5"),
			URL_MESSAGES,
			ctx,
		);
		expect(sonnet.status).toBe(200);
		expect(hits).toContain(EXHAUSTED_ID);
	});

	// Inferred state may narrow the pool but must never empty it. With the
	// refused account as the ONLY candidate, the request is still attempted.
	it("still tries the refused account when it is the only one left", async () => {
		const accounts = [
			makeAccount({
				id: EXHAUSTED_ID,
				name: "fable-spent",
				api_key: "key-spent",
			}),
		];
		installUpstream(accounts);
		const ctx = makeContext(accounts);

		// Both requests end in the all-accounts-failed terminal, which handleProxy
		// signals by throwing (dispatchProxyRequest turns it into a 503). The
		// terminal is correct here — the account really is out of Fable. What is
		// under test is that the SECOND request still went and asked rather than
		// being refused locally on the memo's say-so.
		const attempt = async () => {
			try {
				await callHandleProxy(request("claude-fable-5"), URL_MESSAGES, ctx);
			} catch {
				// expected: no account could serve it
			}
		};

		await attempt();
		hits = [];
		await attempt();
		expect(hits).toContain(EXHAUSTED_ID);
	});
});
