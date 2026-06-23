import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { usageCache } from "@clankermux/providers";
import type { Account, RequestMeta } from "@clankermux/types";
import { cacheBodyStore } from "../cache-body-store";
import type { ProxyContext } from "../handlers";
import {
	BURST_RETRY_MAX_CONCURRENT_HOLDS,
	clearAnthropicBurstThrottle,
	markAnthropicBurstThrottle,
	resetHoldSlots,
	tryAcquireHoldSlot,
} from "../handlers/burst-cooldown";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";

mock.module("../inline-worker", () => ({ EMBEDDED_WORKER_CODE: "" }));

async function callHandleProxy(req: Request, url: URL, ctx: ProxyContext) {
	const { handleProxy } = await import("../proxy");
	return handleProxy(req, url, ctx);
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
 * Strategy stub that returns the available accounts (filtered like the real one)
 * AND sets `meta.routing.heldAccountId` to a fixed id so the burst-retry
 * decide-before-loop can target the cache account. The held account is excluded
 * from the returned available list when cooled (mirrors affinity_hold).
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
		// Fallback provider for any unregistered provider. In this test the real
		// provider registry IS active (anthropic + codex resolve to their real
		// providers), so accounts hit their real upstream URLs — this stub is only
		// a safety net.
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

/**
 * Mark the account with fresh usage that is AHEAD OF PACE on the 5-hour window
 * (so `applyUsageThrottling` removes it) while still leaving POSITIVE rate-limit
 * headroom (minHeadroom > 0 — NOT a real quota wall). Window started ~1h ago of a
 * 5h window (20% expected) but 50% used ⇒ pacing-throttled with 50% headroom.
 * This is the Codex High finding's bug shape: an account the pacing gate removed
 * even though it is not rate-limited and not exhausted.
 */
function seedThrottledFreshHeadroom(accountId: string) {
	usageCache.set(accountId, {
		five_hour: {
			utilization: 50,
			resets_at: new Date(Date.now() + 4 * 3_600_000).toISOString(),
		},
		seven_day: {
			utilization: 20,
			resets_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
		},
	} as never);
}

/**
 * Strategy stub for the `affinity_hit` case: the affined (held) account IS
 * available and selected, so it is returned in the available list AND
 * `decision` is `affinity_hit` (NOT `affinity_hold`). The downstream
 * usage-throttle gate may still remove it from `accounts` — which is exactly the
 * Codex High finding's bug condition (available→selected, then pacing-throttled
 * out). `heldAccountId` is still recorded (the real strategy sets it on
 * affinity_hit too).
 */
function makeStrategyHit(heldAccountId: string) {
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
				decision: "affinity_hit",
				affinityScope: "project",
				affinityKey: "k",
				selectedAccountId: heldAccountId,
				previousAccountId: null,
				candidatesCount: available.length,
				failoverReason: null,
				heldAccountId,
			};
			return available;
		},
	} as never;
}

/**
 * Context with 5-hour usage-throttling ENABLED and an `affinity_hit` strategy.
 * Used to reproduce the Codex High finding: a held account that was available
 * (affinity_hit) then removed by the usage-throttle gate must NOT enter the
 * burst hold.
 */
function makeThrottledHitContext(
	accounts: Account[],
	heldAccountId: string,
): ProxyContext {
	const ctx = makeContext(accounts, heldAccountId) as {
		strategy: unknown;
		config: { getUsageThrottlingFiveHourEnabled: () => boolean };
	};
	ctx.strategy = makeStrategyHit(heldAccountId);
	ctx.config.getUsageThrottlingFiveHourEnabled = () => true;
	return ctx as unknown as ProxyContext;
}

function makeRequest(): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
		}),
	});
}

/**
 * True for an upstream proxy endpoint (Anthropic or Codex) — vs. unrelated
 * background fetches like the pricing-table refresh from @clankermux/core, which
 * must be passed through to the real fetch. In this integration test the real
 * provider registry is active, so accounts hit their real upstream URLs:
 * Anthropic → api.anthropic.com, Codex → chatgpt.com/backend-api/codex.
 */
function isProxyCall(input: RequestInfo | URL): boolean {
	const url = input instanceof Request ? input.url : String(input);
	return (
		url.includes("api.anthropic.com") ||
		url.includes("chatgpt.com") ||
		url.includes("/v1/messages")
	);
}

/** Which provider an upstream call targets, inferred from its real URL host. */
function callTarget(input: RequestInfo | URL): "anthropic" | "codex" | "other" {
	const url = input instanceof Request ? input.url : String(input);
	if (url.includes("chatgpt.com")) return "codex";
	if (url.includes("api.anthropic.com")) return "anthropic";
	return "other";
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

function ok200(model = "claude-sonnet-4-5") {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			model,
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

/** Mark the held account as having fresh, positive 5h headroom in usageCache. */
function seedFreshHeadroom(accountId: string) {
	usageCache.set(accountId, {
		five_hour: {
			utilization: 40,
			resets_at: new Date(Date.now() + 3_600_000).toISOString(),
		},
		seven_day: {
			utilization: 20,
			resets_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
		},
	} as never);
}

/**
 * Mark the account as having fresh, FULLY-EXHAUSTED 5h capacity (minHeadroom=0)
 * in usageCache — i.e. a real per-account quota wall, not a transient burst.
 */
function seedZeroHeadroom(accountId: string) {
	usageCache.set(accountId, {
		five_hour: {
			utilization: 100,
			resets_at: new Date(Date.now() + 3_600_000).toISOString(),
		},
		seven_day: {
			utilization: 100,
			resets_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
		},
	} as never);
}

describe("burst-retry hold integration (handleProxy)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
		clearAnthropicBurstThrottle();
		resetHoldSlots();
		// Deterministic timing. The first 429 sets a cooldown of
		// min(default-no-reset, backoff-base); floor both to ~1s so a single
		// re-probe wait fits within the fixed (60s) hold budget. The burst-retry
		// tuning constants are now fixed in source, so only the cooldown-length
		// knobs need pinning here.
		process.env.CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS = "1000";
		process.env.CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS = "1000";
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
		clearAnthropicBurstThrottle();
		resetHoldSlots();
		delete process.env.CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS;
		delete process.env.CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS;
	});

	it("holds the cache account on a transient 429 + quota (429→200), with NO sibling attempt", async () => {
		const held = makeAccount({ id: "held", name: "Cache" });
		const sibling = makeAccount({ id: "sibling", name: "Sibling" });
		seedFreshHeadroom("held");

		const calls: string[] = [];
		let n = 0;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				const r = input instanceof Request ? input : new Request(String(input));
				calls.push(r.url);
				n += 1;
				// Call 1 = held first attempt (429); call 2 = held re-probe (200).
				return n === 1 ? rl429({ "x-should-retry": "true" }) : ok200();
			},
		);

		const ctx = makeContext([held, sibling], "held");
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(200);
		// Exactly two upstream calls: held first-attempt (429) + held re-probe (200).
		// A sibling diversion would have produced a 3rd call AND used the sibling.
		expect(calls).toHaveLength(2);
	});

	it("concurrent request with burst marker already active holds the held account (no sibling diversion)", async () => {
		const held = makeAccount({
			id: "held",
			name: "Cache",
			// Cooled (affinity_hold): excluded from the available list.
			rate_limited_until: Date.now() - 1, // expired so re-probe fires immediately
		});
		const sibling = makeAccount({ id: "sibling", name: "Sibling" });
		seedFreshHeadroom("held");
		// Simulate a prior request having tripped the marker.
		markAnthropicBurstThrottle();

		const calls: string[] = [];
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				const r = input instanceof Request ? input : new Request(String(input));
				calls.push(r.url);
				// The held account's re-probe succeeds.
				return ok200();
			},
		);

		const ctx = makeContext([held, sibling], "held");
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(200);
		// Marker-active path goes straight to the hold (one re-probe), no first
		// attempt and no sibling diversion.
		expect(calls).toHaveLength(1);
	});

	it("non-storm regression: held cooled + healthy sibling + marker INACTIVE ⇒ serves from sibling, NO hold", async () => {
		// The pinned cache account is cooled (affinity_hold) but the burst marker is
		// NOT active — there is no recent burst. This is today's correct behavior:
		// serve from a healthy sibling (stay unblocked), do NOT hold. The held
		// account is NOT re-probed (no hold), so the ONLY upstream call is the
		// sibling's success.
		const held = makeAccount({
			id: "held",
			name: "Cache",
			// Cooled (affinity_hold): excluded from the available list.
			rate_limited_until: Date.now() + 60_000,
			access_token: "at-held",
		});
		const sibling = makeAccount({
			id: "sibling",
			name: "Sibling",
			access_token: "at-sibling",
		});
		seedFreshHeadroom("held");
		// Marker deliberately NOT set (beforeEach clears it).

		let heldProbes = 0;
		let siblingServed = false;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				const reqHeaders =
					input instanceof Request ? input.headers : new Headers(init?.headers);
				const auth = reqHeaders.get("authorization") ?? "";
				if (auth.includes("at-held")) {
					heldProbes += 1;
					return rl429({ "x-should-retry": "true" });
				}
				siblingServed = true;
				return ok200();
			},
		);

		const ctx = makeContext([held, sibling], "held");
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(200);
		expect(siblingServed).toBe(true);
		// No hold was entered (marker inactive + held not in `accounts`) ⇒ the held
		// account was never probed.
		expect(heldProbes).toBe(0);
	});

	it("storm: hold gives up, normal loop tries healthy siblings (all 429), then constructed retryable 429", async () => {
		// Two healthy Anthropic siblings are available. After the hold on the cache
		// account gives up, the request FALLS THROUGH to the normal failover loop
		// (Part 4): it attempts the healthy siblings (cache miss but still Opus). The
		// mock 429s EVERY Anthropic call, so the siblings fail too and the terminal
		// outcome is the constructed burst-retry give-up 429 — NOT a 503
		// pool_exhausted. The key change from the old behavior: siblings ARE now
		// attempted instead of being skipped straight to the last-resort.
		const held = makeAccount({ id: "held", name: "Cache" });
		const siblingA = makeAccount({ id: "sibA", name: "SiblingA" });
		const siblingB = makeAccount({ id: "sibB", name: "SiblingB" });
		seedFreshHeadroom("held");

		// Every upstream call 429s — held never recovers, and the siblings also 429.
		let proxyCalls = 0;
		const headers = new Set<string>();
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				proxyCalls += 1;
				const reqHeaders =
					input instanceof Request ? input.headers : new Headers(init?.headers);
				const auth = reqHeaders.get("authorization") ?? "";
				headers.add(auth);
				return rl429({ "x-should-retry": "true" });
			},
		);

		const ctx = makeContext([held, siblingA, siblingB], "held");
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// Constructed retryable 429 (give-up), not a 503 pool_exhausted and not a
		// sibling success (every Anthropic call 429'd).
		expect(res.status).toBe(429);
		expect(res.headers.get("x-clankermux-burst-retry")).toBe("exhausted");
		const body = (await res.json()) as { error?: { type?: string } };
		expect(body.error?.type).toBe("rate_limited");
		// Held first attempt + re-probes + the two siblings (normal-loop fall-through)
		// all 429'd — strictly more than just the held account's calls.
		expect(proxyCalls).toBeGreaterThanOrEqual(2);
	});

	it("hold gives up ⇒ normal loop serves a healthy Anthropic sibling (cache miss but still Opus)", async () => {
		// The cache account is in a storm (its calls 429), but a healthy sibling
		// exists. After the hold gives up, the normal loop (Part 4) serves the
		// request from the sibling — preferred over diverting to Codex (gpt-5.5).
		const held = makeAccount({ id: "held", name: "Cache" });
		const sibling = makeAccount({ id: "sibling", name: "Sibling" });
		const codex = makeAccount({
			id: "codex",
			name: "Codex",
			provider: "codex",
			refresh_token: "rt",
			access_token: "at-codex",
			expires_at: Date.now() + 3_600_000,
			model_mappings: JSON.stringify({ sonnet: "gpt-5.5" }),
		});
		seedFreshHeadroom("held");

		let codexHit = false;
		let heldCalls = 0;
		let siblingServed = false;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				const target = callTarget(input);
				if (target === "codex") {
					codexHit = true;
					return ok200();
				}
				// Distinguish held vs sibling by the access token on the Authorization
				// header (both are anthropic-direct → same host). The held account uses
				// "at-token"; the sibling uses a different one below.
				const reqHeaders =
					input instanceof Request ? input.headers : new Headers(init?.headers);
				const auth = reqHeaders.get("authorization") ?? "";
				if (auth.includes("at-sibling")) {
					siblingServed = true;
					return ok200();
				}
				heldCalls += 1;
				return rl429({ "x-should-retry": "true" });
			},
		);

		sibling.access_token = "at-sibling";
		const ctx = makeContext([held, sibling, codex], "held");
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// Served by the healthy Anthropic sibling — NOT Codex (sibling Opus is
		// preferred over a Codex gpt-5.5 downgrade).
		expect(res.status).toBe(200);
		expect(siblingServed).toBe(true);
		expect(codexHit).toBe(false);
		// The held account was probed (hold) but never served.
		expect(heldCalls).toBeGreaterThanOrEqual(1);
	});

	it("storm with no healthy siblings: hold gives up, normal loop empty, Codex-if-fits serves it", async () => {
		// The held account is in a sustained storm (every Anthropic call 429s) and
		// the ONLY other available account is Codex. With no healthy Anthropic
		// sibling, the normal-loop fall-through reaches the Codex candidate, which
		// serves the request. (Part 3 removed the fast-bail: the hold now uses the
		// full budget, but the give-up still ends at Codex.)
		const held = makeAccount({ id: "held", name: "Cache" });
		const codex = makeAccount({
			id: "codex",
			name: "Codex",
			provider: "codex",
			refresh_token: "rt",
			access_token: "at-codex",
			expires_at: Date.now() + 3_600_000,
			model_mappings: JSON.stringify({ sonnet: "gpt-5.5" }),
		});
		seedFreshHeadroom("held");

		let codexHit = false;
		let anthropicCalls = 0;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				if (callTarget(input) === "codex") {
					codexHit = true;
					return ok200();
				}
				anthropicCalls += 1;
				return rl429({ "x-should-retry": "true" });
			},
		);

		const ctx = makeContext([held, codex], "held");
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(200);
		expect(codexHit).toBe(true);
		// The held account was probed during the hold (≥1 call), then the give-up
		// fell through to Codex. No sibling-Anthropic existed.
		expect(anthropicCalls).toBeGreaterThanOrEqual(1);
	});

	it("oversized request gates Codex out, no healthy sibling ⇒ holds full budget then constructed 429", async () => {
		// The request is too large for the Codex account's mapped model (gpt-5.5,
		// 400K window → 340K threshold), so the context-window gate excludes it.
		// With no surviving non-Anthropic candidate AND no healthy Anthropic sibling,
		// the hold uses the full budget and, when the held account never recovers,
		// the normal-loop fall-through is empty → constructed retryable 429.
		const held = makeAccount({ id: "held", name: "Cache" });
		const codex = makeAccount({
			id: "codex",
			name: "Codex",
			provider: "codex",
			refresh_token: "rt",
			access_token: "at-codex",
			expires_at: Date.now() + 3_600_000,
			model_mappings: JSON.stringify({ sonnet: "gpt-5.5" }),
		});
		seedFreshHeadroom("held");

		let codexHit = false;
		let anthropicCalls = 0;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				if (callTarget(input) === "codex") {
					codexHit = true;
					return ok200();
				}
				anthropicCalls += 1;
				return rl429({ "x-should-retry": "true" });
			},
		);

		// Oversized body: ~1.2M chars ⇒ estimate ~400K tokens > 340K gpt-5.5 cap.
		const largeReq = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [{ role: "user", content: "x".repeat(1_200_000) }],
				max_tokens: 16,
			}),
		});

		const ctx = makeContext([held, codex], "held");
		const res = await callHandleProxy(
			largeReq,
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// Codex was gated out (oversized) ⇒ never in `accounts`, so the normal-loop
		// fall-through is empty; the held account never recovered ⇒ constructed
		// give-up 429.
		expect(codexHit).toBe(false);
		expect(res.status).toBe(429);
		expect(res.headers.get("x-clankermux-burst-retry")).toBe("exhausted");
		// Full 120s budget multi-attempt loop: held first attempt + up to
		// MAX_ATTEMPTS=3 re-probes.
		expect(anthropicCalls).toBeGreaterThanOrEqual(3);
	});

	it("concurrency-cap overflow ⇒ normal-loop fall-through serves the fitting Codex candidate", async () => {
		// Saturate the hold-slot cap BEFORE the request so holdAndRetryCacheAccount
		// returns HOLD_OVERFLOW. The give-up then FALLS THROUGH to the normal loop
		// (Part 4): the healthy Anthropic sibling is tried (429) and the fitting
		// Codex candidate serves the request.
		const cap = BURST_RETRY_MAX_CONCURRENT_HOLDS;
		for (let i = 0; i < cap; i++) tryAcquireHoldSlot();

		const held = makeAccount({ id: "held", name: "Cache" });
		const sibling = makeAccount({ id: "sibling", name: "Sibling" });
		const codex = makeAccount({
			id: "codex",
			name: "Codex",
			provider: "codex",
			refresh_token: "rt",
			access_token: "at-codex",
			expires_at: Date.now() + 3_600_000,
			model_mappings: JSON.stringify({ sonnet: "gpt-5.5" }),
		});
		seedFreshHeadroom("held");

		let codexHit = false;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				if (callTarget(input) === "codex") {
					codexHit = true;
					return ok200();
				}
				return rl429({ "x-should-retry": "true" });
			},
		);

		const ctx = makeContext([held, sibling, codex], "held");
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(200);
		expect(codexHit).toBe(true);
	});

	it("held first attempt fails non-retryably (hard-limit 429) ⇒ no hold, loop does NOT re-attempt held, serves sibling", async () => {
		// No fresh headroom seeded + a hard-limit unified-status ⇒ classify429Transient
		// returns non-retryable, so the burst block falls through to the normal loop.
		const held = makeAccount({ id: "held", name: "Cache" });
		const sibling = makeAccount({ id: "sibling", name: "Sibling" });

		const calls: Array<"anthropic" | "codex" | "other"> = [];
		let anthropicCalls = 0;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				calls.push(callTarget(input));
				anthropicCalls += 1;
				// First Anthropic call (held) hard-429s; the second (sibling) succeeds.
				return anthropicCalls === 1
					? rl429({ "anthropic-ratelimit-unified-status": "rate_limited" })
					: ok200();
			},
		);

		const ctx = makeContext([held, sibling], "held");
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// Served by the sibling. Exactly 2 Anthropic calls: held (burst first attempt,
		// hard-429) + sibling (loop). The held account is NOT re-attempted by the
		// loop (the dedup guard), so there is no 3rd Anthropic call.
		expect(res.status).toBe(200);
		expect(anthropicCalls).toBe(2);
	});

	it("Finding 2: give-up via last-resort returns the staging size to baseline (no staged-body leak)", async () => {
		// A held account that never recovers + a Codex last-resort candidate that
		// also 429s. The last-resort proxyWithAccount RE-stages requestMeta.id (it
		// runs without reprobe mode), so without the final discardStaged the staged
		// body would leak until the age sweep. We assert staging returns to its
		// pre-request baseline after the give-up.
		const baseline = cacheBodyStore.getStagingSize();

		const held = makeAccount({ id: "held", name: "Cache" });
		const codex = makeAccount({
			id: "codex",
			name: "Codex",
			provider: "codex",
			refresh_token: "rt",
			access_token: "at-codex",
			expires_at: Date.now() + 3_600_000,
			model_mappings: JSON.stringify({ sonnet: "gpt-5.5" }),
		});
		seedFreshHeadroom("held");

		// EVERY upstream call 429s — held never recovers, and the Codex last-resort
		// 429s too → give-up. Both the held first attempt and the Codex last-resort
		// stage/​re-stage the same request id.
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				return rl429({ "x-should-retry": "true" });
			},
		);

		const ctx = makeContext([held, codex], "held");
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// Constructed give-up 429 (Codex last-resort also failed).
		expect(res.status).toBe(429);
		expect(res.headers.get("x-clankermux-burst-retry")).toBe("exhausted");
		// Staging returned to baseline — no leaked staged body for this request id.
		expect(cacheBodyStore.getStagingSize()).toBe(baseline);
	});

	it("Finding 4: marker active + held account at ZERO headroom ⇒ normal failover, NOT a hold", async () => {
		// A concurrent request tripped the global per-IP marker, but THIS held
		// account is genuinely exhausted (minHeadroom=0). The marker-active path must
		// re-validate the held account and fall through to normal failover instead of
		// burning the whole hold budget re-probing a really-dead account.
		const held = makeAccount({
			id: "held",
			name: "Cache",
			// Cooled so it's excluded from the available list (affinity_hold) — the
			// marker-active branch would otherwise hold it.
			rate_limited_until: Date.now() + 60_000,
		});
		const sibling = makeAccount({ id: "sibling", name: "Sibling" });
		// Real exhaustion on the held account (fresh, util=100 ⇒ minHeadroom=0).
		seedZeroHeadroom("held");
		markAnthropicBurstThrottle();

		let n = 0;
		const targets: Array<"anthropic" | "codex" | "other"> = [];
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				targets.push(callTarget(input));
				n += 1;
				// The sibling (only available account) serves the request.
				return ok200();
			},
		);

		const ctx = makeContext([held, sibling], "held");
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// Normal failover served it from the sibling — exactly one upstream call, no
		// hold/re-probe budget burned on the exhausted held account.
		expect(res.status).toBe(200);
		expect(n).toBe(1);
	});

	it("marker active + held account capacity STALE/absent ⇒ single re-probe only (stale_should_retry), not the full 3-attempt budget", async () => {
		// A concurrent request tripped the global per-IP marker, and THIS held
		// account's usage is stale/absent (no seed ⇒ getFreshCapacity → null) — the
		// SAME condition under which classify429Transient would only grant
		// `stale_should_retry`. The marker-active branch must therefore enter the
		// hold at `stale_should_retry` confidence, capping it at ONE re-probe rather
		// than burning the full BURST_RETRY_MAX_ATTEMPTS (3) against a
		// possibly-exhausted account. With the bug (confidence left as
		// `fresh_headroom`) this path would re-probe up to 3 times.
		const held = makeAccount({
			id: "held",
			name: "Cache",
			// Cooled (affinity_hold) but already expired so a re-probe fires at once.
			rate_limited_until: Date.now() - 1,
			// Distinct token so we can count the held account's hold re-probes apart
			// from the normal-loop sibling attempt.
			access_token: "at-held",
		});
		const sibling = makeAccount({
			id: "sibling",
			name: "Sibling",
			access_token: "at-sibling",
		});
		// Deliberately NO usageCache seed for "held" ⇒ getFreshCapacity returns null.
		usageCache.delete("held");
		markAnthropicBurstThrottle();

		// Every Anthropic call 429s. We count the held account's HOLD re-probes
		// separately (by its access token) from the normal-loop sibling attempt.
		// stale_should_retry must cap the HOLD at exactly ONE re-probe; the buggy
		// fresh_headroom would re-probe the held account up to 3 times.
		let heldProbes = 0;
		let siblingCalls = 0;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				const reqHeaders =
					input instanceof Request ? input.headers : new Headers(init?.headers);
				const auth = reqHeaders.get("authorization") ?? "";
				if (auth.includes("at-sibling")) siblingCalls += 1;
				else heldProbes += 1;
				return rl429({ "x-should-retry": "true" });
			},
		);

		const ctx = makeContext([held, sibling], "held");
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// Constructed give-up 429 (held never recovered; sibling also 429'd; no
		// fitting non-Anthropic candidate).
		expect(res.status).toBe(429);
		expect(res.headers.get("x-clankermux-burst-retry")).toBe("exhausted");
		// Marker-active ⇒ no first attempt; stale_should_retry caps the HOLD at ONE
		// re-probe of the held account (NOT 3). The normal-loop fall-through then
		// tries the healthy sibling once (Part 4).
		expect(heldProbes).toBe(1);
		expect(siblingCalls).toBe(1);
	});

	it("Part 4: give-up falls through to the normal loop, which serves a healthy OAuth-Anthropic sibling", async () => {
		// Under the OLD jump-to-filtered-last-resort, the give-up went STRAIGHT to the
		// Codex-if-fits filtered last-resort, skipping every healthy Anthropic sibling.
		// Part 4 changes this: a declined hold now falls through to the NORMAL failover
		// loop, which tries every healthy account in `accounts` — including a healthy
		// Anthropic sibling (cache miss but still Opus), PREFERRED over a Codex
		// downgrade. The held account itself is NOT re-attempted by the loop (the
		// burstAttemptedAccountId double-attempt guard).
		const held = makeAccount({
			id: "held",
			name: "Cache",
			access_token: "at-held",
		});
		const sibling = makeAccount({
			id: "sibling",
			name: "Sibling",
			access_token: "at-sibling",
		});
		const codex = makeAccount({
			id: "codex",
			name: "Codex",
			provider: "codex",
			refresh_token: "rt",
			access_token: "at-codex",
			expires_at: Date.now() + 3_600_000,
			model_mappings: JSON.stringify({ sonnet: "gpt-5.5" }),
		});
		seedFreshHeadroom("held");

		let codexHit = false;
		let siblingServed = false;
		let heldAttempts = 0;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				if (callTarget(input) === "codex") {
					codexHit = true;
					return ok200();
				}
				const reqHeaders =
					input instanceof Request ? input.headers : new Headers(init?.headers);
				const auth = reqHeaders.get("authorization") ?? "";
				if (auth.includes("at-sibling")) {
					siblingServed = true;
					return ok200();
				}
				// The held account (at-held) always 429s.
				heldAttempts += 1;
				return rl429({ "x-should-retry": "true" });
			},
		);

		const ctx = makeContext([held, sibling, codex], "held");
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// The healthy Anthropic sibling served it via the normal-loop fall-through —
		// preferred over Codex (gpt-5.5). The held account was probed by the hold but
		// NOT re-attempted by the normal loop (double-attempt guard).
		expect(res.status).toBe(200);
		expect(siblingServed).toBe(true);
		expect(codexHit).toBe(false);
		expect(heldAttempts).toBeGreaterThanOrEqual(1);
	});

	// -------------------------------------------------------------------------
	// Finding 1: storm-degrade — the cache account AND every sibling are cooled, so
	// the strategy returns ZERO available candidates. The no-accounts terminal must
	// run the hold on the cache account (marker active) BEFORE degrading to a
	// pool_exhausted/constructed-give-up terminal — the hold must not be skipped in
	// the worst storm moment.
	// -------------------------------------------------------------------------
	it("Finding 1: ALL accounts cooled + marker active ⇒ holds the held cache account (429→200), NOT immediate pool_exhausted", async () => {
		// Both the cache account and the only sibling are cooled → makeStrategy
		// returns [] (zero available) but still records heldAccountId. The held
		// account's cooldown has already lapsed so a re-probe fires at once.
		const held = makeAccount({
			id: "held",
			name: "Cache",
			rate_limited_until: Date.now() - 1, // expired → re-probe immediately
			access_token: "at-held",
		});
		const sibling = makeAccount({
			id: "sibling",
			name: "Sibling",
			rate_limited_until: Date.now() + 60_000, // still cooled → excluded
			access_token: "at-sibling",
		});
		seedFreshHeadroom("held");
		// A concurrent request tripped the global per-IP marker.
		markAnthropicBurstThrottle();

		let heldProbes = 0;
		let siblingCalls = 0;
		let n = 0;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				const reqHeaders =
					input instanceof Request ? input.headers : new Headers(init?.headers);
				const auth = reqHeaders.get("authorization") ?? "";
				if (auth.includes("at-sibling")) siblingCalls += 1;
				else heldProbes += 1;
				n += 1;
				// First held re-probe 429s, second succeeds.
				return n === 1 ? rl429({ "x-should-retry": "true" }) : ok200();
			},
		);

		const ctx = makeContext([held, sibling], "held");
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// Served by the held cache account via the storm-degrade hold — never the
		// cooled sibling, and never an immediate pool_exhausted.
		expect(res.status).toBe(200);
		expect(siblingCalls).toBe(0);
		expect(heldProbes).toBeGreaterThanOrEqual(1);
	});

	it("Finding 1: ALL accounts cooled + marker active + persistent throttle ⇒ constructed give-up 429 (NOT pool_exhausted 503)", async () => {
		const held = makeAccount({
			id: "held",
			name: "Cache",
			rate_limited_until: Date.now() - 1,
			access_token: "at-held",
		});
		const sibling = makeAccount({
			id: "sibling",
			name: "Sibling",
			rate_limited_until: Date.now() + 60_000, // cooled → excluded
			access_token: "at-sibling",
		});
		seedFreshHeadroom("held");
		markAnthropicBurstThrottle();

		// Held never recovers; the sibling is cooled (excluded) so it is never even
		// resolved — there is no normal-loop fall-through in the zero-accounts case.
		let siblingCalls = 0;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				const reqHeaders =
					input instanceof Request ? input.headers : new Headers(init?.headers);
				const auth = reqHeaders.get("authorization") ?? "";
				if (auth.includes("at-sibling")) siblingCalls += 1;
				return rl429({ "x-should-retry": "true" });
			},
		);

		const ctx = makeContext([held, sibling], "held");
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// Constructed retryable burst-retry give-up 429 — NOT the generic
		// pool_exhausted 503. The cooled sibling was never attempted.
		expect(res.status).toBe(429);
		expect(res.headers.get("x-clankermux-burst-retry")).toBe("exhausted");
		expect(siblingCalls).toBe(0);
	});

	it("Finding 1: ALL accounts cooled + held at ZERO headroom ⇒ degrades to pool_exhausted, NO hold", async () => {
		// Real per-account exhaustion (minHeadroom=0) on the held account: even with
		// the marker active, the storm-degrade gate must NOT hold — it degrades to
		// the existing pool_exhausted terminal without re-probing.
		const held = makeAccount({
			id: "held",
			name: "Cache",
			rate_limited_until: Date.now() + 60_000,
			access_token: "at-held",
		});
		seedZeroHeadroom("held");
		markAnthropicBurstThrottle();

		let upstreamCalls = 0;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				upstreamCalls += 1;
				return rl429();
			},
		);

		const ctx = makeContext([held], "held");
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// No hold, no re-probe — straight to the pool_exhausted terminal (503).
		expect(res.status).toBe(503);
		expect(upstreamCalls).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Finding 2: a client disconnect mid-hold must STOP the request — no
	// sibling/Codex upstream requests issued after the hold gives up for a client
	// that is already gone.
	// -------------------------------------------------------------------------
	it("Finding 2: client aborts mid-hold ⇒ no sibling/Codex upstream request after give-up", async () => {
		const held = makeAccount({
			id: "held",
			name: "Cache",
			access_token: "at-held",
		});
		const sibling = makeAccount({
			id: "sibling",
			name: "Sibling",
			access_token: "at-sibling",
		});
		const codex = makeAccount({
			id: "codex",
			name: "Codex",
			provider: "codex",
			refresh_token: "rt",
			access_token: "at-codex",
			expires_at: Date.now() + 3_600_000,
			model_mappings: JSON.stringify({ sonnet: "gpt-5.5" }),
		});
		seedFreshHeadroom("held");

		const controller = new AbortController();
		let heldProbes = 0;
		let siblingCalls = 0;
		let codexCalls = 0;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				const target = callTarget(input);
				if (target === "codex") {
					codexCalls += 1;
					return ok200();
				}
				const reqHeaders =
					input instanceof Request ? input.headers : new Headers(init?.headers);
				const auth = reqHeaders.get("authorization") ?? "";
				if (auth.includes("at-sibling")) {
					siblingCalls += 1;
					return ok200();
				}
				// Held first attempt: 429 (enters the hold), then abort the client so
				// the hold gives up on the next wait.
				heldProbes += 1;
				controller.abort();
				return rl429({ "x-should-retry": "true" });
			},
		);

		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 10,
			}),
			signal: controller.signal,
		});

		const ctx = makeContext([held, sibling, codex], "held");
		const res = await callHandleProxy(
			req,
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// The client aborted mid-hold: the request stops at the abort guard. No
		// sibling and no Codex upstream request is issued after the give-up.
		expect(siblingCalls).toBe(0);
		expect(codexCalls).toBe(0);
		expect(heldProbes).toBeGreaterThanOrEqual(1);
		expect(res.status).toBe(499);
	});

	// -------------------------------------------------------------------------
	// Codex High finding: the burst hold must NEVER fire for an account that was
	// removed by the usage-throttle (pacing) gate rather than a rate-limit
	// cooldown. The throttle gate drops accounts with POSITIVE rate-limit headroom
	// — holding+probing such an account would bypass the configured pacing
	// throttle by issuing an upstream call. Eligibility requires either presence
	// in the gated `accounts` list (available) OR decision === "affinity_hold"
	// (genuine cooldown). An affinity_hit account throttled OUT of `accounts` is
	// neither, so it must fall to the usage-throttled terminal / normal loop.
	// -------------------------------------------------------------------------
	it("Codex High: zero-candidate via usage-throttle (affinity_hit, NOT cooldown) + marker active + positive headroom ⇒ usage-throttled 529, NO hold, NO upstream call", async () => {
		// The held account is available→selected (affinity_hit) with positive
		// rate-limit headroom, but the 5-hour pacing gate throttles it out, leaving
		// `accounts` empty. The marker is active. WITHOUT the eligibility gate the
		// zero-candidate storm-hold would fire (decision is affinity_hit, not
		// affinity_hold) and issue an upstream probe that bypasses the throttle.
		// WITH the gate it degrades to the usage-throttled 529 terminal instead.
		const held = makeAccount({
			id: "held",
			name: "Cache",
			access_token: "at-held",
		});
		seedThrottledFreshHeadroom("held");
		markAnthropicBurstThrottle();

		let upstreamCalls = 0;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				upstreamCalls += 1;
				return ok200();
			},
		);

		const ctx = makeThrottledHitContext([held], "held");
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// Usage-throttled terminal (529), NOT a held-account hold success and NOT a
		// pool_exhausted 503. No upstream call was issued — the throttle held.
		expect(res.status).toBe(529);
		expect(upstreamCalls).toBe(0);
	});

	it("Codex High: normal path, held account usage-throttled out (affinity_hit) + healthy sibling + marker active ⇒ serves sibling via normal loop, NO reprobe of the throttled held account", async () => {
		// The held account is affinity_hit (available, positive headroom) but the
		// 5-hour pacing gate throttles it out of `accounts`; a healthy sibling
		// remains (no throttling usage seeded ⇒ passes the gate). The marker is
		// active. WITHOUT the eligibility gate, Branch A would resolve the held
		// account from `selectedAccounts`/DB and hold+probe it (bypassing the
		// throttle). WITH the gate, Branch A is skipped (held absent from `accounts`
		// AND decision is affinity_hit) and the normal loop serves the sibling. The
		// throttled held account is NEVER re-probed.
		const held = makeAccount({
			id: "held",
			name: "Cache",
			access_token: "at-held",
		});
		const sibling = makeAccount({
			id: "sibling",
			name: "Sibling",
			access_token: "at-sibling",
		});
		seedThrottledFreshHeadroom("held");
		// Sibling: fresh, on-pace headroom ⇒ NOT throttled, passes the gate.
		seedFreshHeadroom("sibling");
		markAnthropicBurstThrottle();

		let heldProbes = 0;
		let siblingServed = false;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				const reqHeaders =
					input instanceof Request ? input.headers : new Headers(init?.headers);
				const auth = reqHeaders.get("authorization") ?? "";
				if (auth.includes("at-sibling")) {
					siblingServed = true;
					return ok200();
				}
				heldProbes += 1;
				return rl429({ "x-should-retry": "true" });
			},
		);

		const ctx = makeThrottledHitContext([held, sibling], "held");
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// The healthy sibling served it via the normal loop. The throttled held
		// account was never held/re-probed (its eligibility was denied).
		expect(res.status).toBe(200);
		expect(siblingServed).toBe(true);
		expect(heldProbes).toBe(0);
	});
});
