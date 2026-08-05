/**
 * Boundary tests for the burst-hold BOOKKEEPING that `handleProxy` writes and
 * then reads back — the state (`burstAttemptedAccountId`, `burstHoldDeclined`,
 * `burstHeldAccountForGiveUp`) that the burst hold hands to the normal failover
 * loop and to the give-up terminal.
 *
 * Both cases go through `handleProxy` itself (never through the hold helpers
 * directly), so the assertions survive a refactor that moves the hold family out
 * of the function:
 *
 *   1. STRICT held-account skip after a give-up. The give-up records the held
 *      account as attempted, and the candidate loop must skip exactly it — pinned
 *      by strict equality on the held account's upstream call count, not a
 *      `toBeGreaterThan`. Driven through the MARKER-ACTIVE path on purpose: the
 *      affinity-first preflight has its own bookkeeping write, which would mask
 *      the one under test.
 *   2. The open-breaker skip writes NO give-up bookkeeping. When a provider /
 *      family breaker is open the hold is skipped before anything is attempted,
 *      so the request must reach its ORDINARY terminal — never the constructed
 *      burst-retry give-up 429 that the bookkeeping would trigger.
 */

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from "bun:test";
import { usageCache } from "@clankermux/providers";
import type { Account, RequestMeta } from "@clankermux/types";
import { cacheBodyStore } from "../cache-body-store";
import type { ProxyContext } from "../handlers";
import { setForcedAccount } from "../handlers";
import {
	clearAnthropicBurstThrottle,
	markAnthropicBurstThrottle,
	resetHoldSlots,
} from "../handlers/burst-cooldown";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { resetOverloadHoldSlots } from "../overload-hold";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
} from "../provider-overload-cooldown";
import { sessionProjectCache } from "../session-project-cache";
import { sessionPromotionTracker } from "../session-promotion";

const MODEL = "claude-sonnet-4-5";

/** Unique per test so no singleton state (usage cache, buckets) leaks between cases. */
let idCounter = 0;
function uniqueId(prefix: string): string {
	idCounter++;
	return `${prefix}-${idCounter}`;
}

/**
 * Deterministic burst-hold timing, injected through handleProxy's
 * `burstHoldTimingOverride` seam (forwarded verbatim to
 * holdAndRetryCacheAccount). The forward-dated clock makes the held account's
 * 60s no-reset cooldown read as already elapsed, so each re-probe fires with no
 * wall-clock sleep; jitter is zeroed and the total budget capped.
 */
const HOLD_TIMING_OVERRIDE = {
	now: () => Date.now() + 10 * 60 * 1000,
	jitterMs: 0,
	maxHoldMs: 2_000,
};

async function callHandleProxy(req: Request, url: URL, ctx: ProxyContext) {
	const { handleProxy } = await import("../proxy");
	return handleProxy(
		req,
		url,
		ctx,
		undefined,
		undefined,
		false,
		HOLD_TIMING_OVERRIDE,
	);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt-token",
		access_token: "at-token",
		expires_at: Date.now() + 3_600_000,
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
 * Strategy stub returning the available accounts (filtered like the real one)
 * while recording `heldAccountId` and the `affinity_hold` decision — the cooled
 * cache-affinity shape both cases under test need.
 */
function makeStrategy(heldAccountId: string) {
	return {
		select: (accs: Account[], meta: RequestMeta) => {
			const now = Date.now();
			const available = accs.filter(
				(acc) =>
					!acc.paused &&
					(!acc.rate_limited_until || acc.rate_limited_until <= now),
			);
			meta.routing = {
				strategy: "session",
				decision: "affinity_hold",
				affinityScope: "project",
				affinityKey: "k",
				selectedAccountId: available[0]?.id ?? null,
				previousAccountId: null,
				candidatesCount: available.length,
				failoverReason: null,
				heldAccountId,
			};
			return available;
		},
	} as never;
}

function makeContext(accounts: Account[], heldAccountId: string): ProxyContext {
	const byId = new Map(accounts.map((a) => [a.id, a]));
	return {
		strategy: makeStrategy(heldAccountId),
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getAccount: mock(async (id: string) => byId.get(id) ?? null),
			getActiveComboForFamily: mock(async () => null),
			getApiKeyPin: mock(async () => null),
			markAccountRateLimited: mock(async () => 1),
			markAccountRateLimitedDeadlineOnly: mock(async () => {}),
			saveRequest: mock(async () => {}),
			updateAccountUsage: mock(async () => {}),
			updateAccountRateLimitMeta: mock(async () => {}),
			resetConsecutiveRateLimits: mock(async () => {}),
			updateRequestUsage: mock(async () => {}),
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
		server: { timeout: mock(() => {}) } as never,
	};
}

function makeRequest(): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: MODEL,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
		}),
	});
}

function rl429(headers: Record<string, string> = {}) {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "Too many requests" },
		}),
		{
			status: 429,
			headers: { "content-type": "application/json", ...headers },
		},
	);
}

function ok200() {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			model: MODEL,
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

/**
 * Shunt every non-upstream fetch (the models.dev pricing-catalog refresh fired by
 * the usage finalizer) to a 500 so call counts stay order-independent across the
 * suite — same rationale as `upstreamOnlyFetch` in prologue-wiring-boundary.
 */
function upstreamOnlyFetch(
	onUpstream: (auth: string) => Response,
): typeof globalThis.fetch {
	return mock(async (input: Request | string | URL, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		if (!url.includes("api.anthropic.com")) {
			return new Response("unavailable", { status: 500 });
		}
		const headers =
			input instanceof Request ? input.headers : new Headers(init?.headers);
		return onUpstream(headers.get("authorization") ?? "");
	}) as never;
}

function resetSingletons(): void {
	setForcedAccount(null);
	cacheBodyStore.setEnabled(false);
	sessionPromotionTracker.setMode("off");
	sessionPromotionTracker.clear();
	sessionProjectCache.clear();
	clearProviderOverloadCooldown();
	clearAnthropicBurstThrottle();
	resetHoldSlots();
	resetOverloadHoldSlots();
	resetRateLimitProbeGatesForTests();
}

describe("handleProxy burst-hold bookkeeping", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeAll(async () => {
		await import("../proxy");
	});

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		resetSingletons();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		resetSingletons();
	});

	it("records the held account as attempted on give-up, and the candidate loop skips EXACTLY it", async () => {
		// MARKER-ACTIVE path on purpose: an active burst-throttle marker bypasses the
		// affinity-first preflight, whose own `burstAttemptedAccountId` write would
		// mask the give-up write this test pins.
		const heldId = uniqueId("held");
		const siblingId = uniqueId("sibling");
		const held = makeAccount({
			id: heldId,
			name: "Cache",
			// Cooldown already lapsed, so the hold's re-probe fires immediately AND the
			// account stays in the gated candidate list — i.e. the loop WOULD attempt it
			// a second time if the give-up bookkeeping did not make it skip.
			rate_limited_until: Date.now() - 1,
			access_token: "at-held",
		});
		const sibling = makeAccount({
			id: siblingId,
			name: "Sibling",
			access_token: "at-sibling",
		});
		// No usage seeded ⇒ getFreshCapacity returns null ⇒ the marker-active branch
		// enters the hold at `stale_should_retry`, which caps it at exactly ONE
		// re-probe before giving up.
		usageCache.delete(heldId);
		markAnthropicBurstThrottle();

		let heldCalls = 0;
		let siblingCalls = 0;
		globalThis.fetch = upstreamOnlyFetch((auth) => {
			if (auth.includes("at-sibling")) {
				siblingCalls += 1;
				return ok200();
			}
			heldCalls += 1;
			return rl429({ "x-should-retry": "true" });
		});

		const ctx = makeContext([held, sibling], heldId);
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// The healthy sibling served the request through the normal failover loop …
		expect(res.status).toBe(200);
		expect(siblingCalls).toBe(1);
		// … and the held account was hit EXACTLY once — the hold's single re-probe.
		// A second call would mean the loop re-attempted it, i.e. the give-up's
		// attempted-account bookkeeping never reached the loop's skip.
		expect(heldCalls).toBe(1);
	});

	it("skips the hold on an open breaker WITHOUT give-up bookkeeping (ordinary 529 terminal, not the burst give-up)", async () => {
		// A provider/family breaker that is open well beyond the overload-hold budget:
		// every candidate is overload-gated, so the request reaches the zero-accounts
		// storm-degrade hold — which is skipped outright by the breaker precedence
		// check. That skip deliberately writes NO give-up bookkeeping, so the request
		// must land on the ordinary provider-overloaded terminal.
		const heldId = uniqueId("held");
		const siblingId = uniqueId("sibling");
		const held = makeAccount({
			id: heldId,
			name: "Cache",
			access_token: "at-held",
		});
		const sibling = makeAccount({
			id: siblingId,
			name: "Sibling",
			access_token: "at-sibling",
		});
		usageCache.delete(heldId);
		usageCache.delete(siblingId);
		// Marker active: without the breaker precedence, the storm-degrade branch
		// would enter the hold and re-probe the held account.
		markAnthropicBurstThrottle();
		// 5 minutes (the breaker's own cap) ≫ the 120s overload-hold budget, so the
		// overload hold is not entered either and the terminal is immediate.
		applyProviderOverloadCooldown("anthropic", Date.now() + 5 * 60_000, MODEL);

		let upstreamCalls = 0;
		let heldCalls = 0;
		globalThis.fetch = upstreamOnlyFetch((auth) => {
			upstreamCalls += 1;
			if (auth.includes("at-held")) heldCalls += 1;
			return ok200();
		});

		const ctx = makeContext([held, sibling], heldId);
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// Nothing was attempted — for the held account or anything else.
		expect(heldCalls).toBe(0);
		expect(upstreamCalls).toBe(0);
		// Exactly one ordinary terminal: the provider-overloaded 529 …
		expect(res.status).toBe(529);
		const body = (await res.json()) as { error?: { type?: string } };
		expect(body.error?.type).toBe("overloaded_error");
		// … and NOT the constructed burst-retry give-up, which is what any give-up
		// bookkeeping written by the skipped hold would have produced.
		expect(res.headers.get("x-clankermux-burst-retry")).toBeNull();
	});
});
