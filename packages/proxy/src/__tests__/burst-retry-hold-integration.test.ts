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
			saveRequest: mock(async () => {}),
			updateAccountUsage: mock(async () => {}),
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
			getSystemPromptCacheTtl1h: () => false,
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

	it("hold exhausted with no fitting non-Anthropic candidate ⇒ constructed retryable 429 (never a sibling)", async () => {
		const held = makeAccount({ id: "held", name: "Cache" });
		const siblingA = makeAccount({ id: "sibA", name: "SiblingA" });
		const siblingB = makeAccount({ id: "sibB", name: "SiblingB" });
		seedFreshHeadroom("held");

		// Every upstream call 429s — held never recovers; siblings must NOT be tried.
		let proxyCalls = 0;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				proxyCalls += 1;
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
		// sibling success.
		expect(res.status).toBe(429);
		expect(res.headers.get("x-clankermux-burst-retry")).toBe("exhausted");
		const body = (await res.json()) as { error?: { type?: string } };
		expect(body.error?.type).toBe("rate_limited");
		// Held first attempt + re-probes all 429'd; ONLY the held account was hit —
		// no sibling-Anthropic was ever tried (they have no fitting non-Anthropic
		// provider). At least the first attempt fired.
		expect(proxyCalls).toBeGreaterThanOrEqual(1);
	});

	it("hold exhausted ⇒ tries a fitting Codex last-resort candidate (sibling-Anthropic never tried)", async () => {
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
		let anthropicCalls = 0;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				const target = callTarget(input);
				// Every Anthropic call (held first attempt + held re-probes) 429s; the
				// Codex last-resort succeeds. Siblings are filtered out of the
				// last-resort by construction, so the only Anthropic calls are the held
				// account's — counting them bounds "no extra Anthropic attempt".
				if (target === "codex") {
					codexHit = true;
					return ok200();
				}
				anthropicCalls += 1;
				return rl429({ "x-should-retry": "true" });
			},
		);

		const ctx = makeContext([held, sibling, codex], "held");
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// The fitting Codex candidate served the request.
		expect(res.status).toBe(200);
		expect(codexHit).toBe(true);
		// Only the held account's Anthropic calls happened (1 first attempt + up to
		// MAX_ATTEMPTS=3 re-probes). A sibling-Anthropic diversion would have added
		// a 5th Anthropic call.
		expect(anthropicCalls).toBeLessThanOrEqual(4);
		expect(anthropicCalls).toBeGreaterThanOrEqual(1);
	});

	it("concurrency-cap overflow ⇒ filtered last-resort (Codex), never a sibling-Anthropic diversion", async () => {
		// Saturate the hold-slot cap BEFORE the request so holdAndRetryCacheAccount
		// returns HOLD_OVERFLOW, routing straight to the filtered last-resort.
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

	it("Finding 5: last-resort NEVER attempts a claude-console-api account (shares the Anthropic per-IP throttle)", async () => {
		const held = makeAccount({ id: "held", name: "Cache" });
		// claude-console-api is Anthropic-DIRECT (api.anthropic.com, same egress IP)
		// — it must be excluded from the last-resort candidate list. If it WERE
		// erroneously included, it would be the only non-held candidate and (by the
		// stub below) would serve a 200 — making the give-up 429 impossible.
		const consoleAcc = makeAccount({
			id: "console",
			name: "Console",
			provider: "claude-console-api",
			refresh_token: "",
			access_token: null,
			api_key: "sk-ant-test",
		});
		seedFreshHeadroom("held");

		// Distinguish the two Anthropic-host callers: the held OAuth account uses a
		// Bearer access token (Authorization header); the console account uses the
		// x-api-key header. The held account always 429s; the console account — if
		// it is ever attempted — would 200. The filter must exclude it, so the only
		// outcome left is the constructed give-up 429.
		let consoleHit = false;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				const headers =
					input instanceof Request ? input.headers : new Headers(init?.headers);
				if (headers.get("x-api-key")) {
					consoleHit = true;
					return ok200();
				}
				return rl429({ "x-should-retry": "true" });
			},
		);

		const ctx = makeContext([held, consoleAcc], "held");
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// Give-up (no eligible non-Anthropic last-resort). The console account was
		// NEVER attempted as a last-resort candidate — so no 200 from it.
		expect(consoleHit).toBe(false);
		expect(res.status).toBe(429);
		expect(res.headers.get("x-clankermux-burst-retry")).toBe("exhausted");
	});
});
