/**
 * Client-abort terminals in `handleProxy`.
 *
 * A client that disconnects mid-flight used to fall through to `handleProxy`'s
 * unconditional tail and be reported as a thrown `ServiceUnavailableError`
 * ("All accounts failed to proxy the request") — logged at ERROR by
 * `dispatch.ts`, i.e. the exact string an operator greps for during a real
 * outage, emitted while the pool was healthy. `handleProxyError` already
 * classified the abort as "not a failure", but that only suppressed a log line,
 * not the control flow.
 *
 * These tests pin the two guards that fix it:
 *  - the request-level terminal (both throws: needsReauth and ALL_ACCOUNTS_FAILED)
 *  - the selection-time terminal (pool_exhausted / pinned_target_unavailable,
 *    both of which record a synthetic history row)
 * plus the `/v1/responses` adapter carrying the client signal into its
 * synthetic `/v1/messages` request, without which the whole endpoint is
 * invisible to every abort guard.
 *
 * Mechanics note: these tests reproduce the REAL signal chain — the upstream
 * fetch mock waits on the AbortSignal it actually received and the ORIGINAL
 * client controller is aborted — rather than hand-throwing an `AbortError`,
 * which would prove nothing about the production wiring.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@clankermux/types";
import { cacheBodyStore } from "../cache-body-store";
import type { ProxyContext } from "../handlers";
import {
	clearAnthropicBurstThrottle,
	resetHoldSlots,
} from "../handlers/burst-cooldown";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";

async function callHandleProxy(req: Request, url: URL, ctx: ProxyContext) {
	const { handleProxy } = await import("../proxy");
	return handleProxy(req, url, ctx);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "Claude-Main",
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
		refresh_token_issued_at: Date.now(),
		...overrides,
	};
}

/**
 * `affinity_hit` strategy stub: the affined account is available and selected,
 * and `heldAccountId` is recorded (the real SessionStrategy does this on
 * affinity_hit too). This is the ONLY path that threads `req.signal` into
 * `proxyWithAccount`, and it is the shape of every observed incident
 * ("Selected 1 accounts: Claude-Main").
 */
function makeAffinityHitStrategy(heldAccountId: string) {
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
 * Plain round-robin strategy stub: NO affinity, so every candidate is served by
 * `runCandidateLoop` rather than by the affinity_hit preflight. Required by the
 * fan-out tests — see the T4 block for why a single-account affinity pool cannot
 * prove anything about fan-out.
 */
function makeRoundRobinStrategy() {
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
				decision: "round_robin",
				affinityScope: null,
				affinityKey: null,
				selectedAccountId: available[0]?.id ?? null,
				previousAccountId: null,
				candidatesCount: available.length,
				failoverReason: null,
			};
			return available;
		},
	} as never;
}

/**
 * A pool of API-key accounts (no refresh token), so a 401 fails straight over
 * instead of detouring through the stale-token refresh-and-retry path.
 */
function makeApiKeyPool(size: number): Account[] {
	return Array.from({ length: size }, (_, i) =>
		makeAccount({
			id: `apikey-${i + 1}`,
			name: `ApiKey-${i + 1}`,
			api_key: "test-key",
			refresh_token: "",
			access_token: null,
			expires_at: null,
			refresh_token_issued_at: null,
		}),
	);
}

/**
 * Selection-time strategy stub: the client hangs up WHILE account selection is
 * running, and selection then finds nothing available. Drives the T2 terminals.
 */
function makeSelectionAbortStrategy(onSelect: () => void) {
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
				decision: "round_robin",
				affinityScope: null,
				affinityKey: null,
				selectedAccountId: available[0]?.id ?? null,
				previousAccountId: null,
				candidatesCount: available.length,
				failoverReason: null,
			};
			onSelect();
			return available;
		},
	} as never;
}

function makeContext(accounts: Account[], strategy: unknown): ProxyContext {
	const byId = new Map(accounts.map((a) => [a.id, a]));
	return {
		strategy: strategy as never,
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
		// Fallback provider for accounts whose provider name is not in the real
		// registry ("test-provider"). Anthropic accounts resolve to the REAL
		// Anthropic provider and hit api.anthropic.com.
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://upstream.local/v1/messages",
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
			onWorkerGone: mock(() => {}),
			sweep: mock(() => {}),
			dispose: mock(() => {}),
		} as never,
	};
}

function recordSyntheticCalls(ctx: ProxyContext): number {
	return (
		ctx.requestRecorder as unknown as {
			recordSynthetic: { mock: { calls: unknown[] } };
		}
	).recordSynthetic.mock.calls.length;
}

function cooldownCalls(ctx: ProxyContext): number {
	const dbOps = ctx.dbOps as unknown as {
		markAccountRateLimited: { mock: { calls: unknown[] } };
		markAccountRateLimitedDeadlineOnly: { mock: { calls: unknown[] } };
	};
	return (
		dbOps.markAccountRateLimited.mock.calls.length +
		dbOps.markAccountRateLimitedDeadlineOnly.mock.calls.length
	);
}

function makeRequest(
	signal?: AbortSignal,
	extraHeaders: Record<string, string> = {},
): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...extraHeaders },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
		signal,
	});
}

/** A request carrying a real prompt-cache marker, so staging actually happens. */
function makeCacheableRequest(signal?: AbortSignal): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			system: [
				{
					type: "text",
					text: "You are a helpful assistant.",
					cache_control: { type: "ephemeral" },
				},
			],
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
		signal,
	});
}

function isUpstreamCall(input: RequestInfo | URL): boolean {
	const url = input instanceof Request ? input.url : String(input);
	return url.includes("api.anthropic.com") || url.includes("upstream.local");
}

/**
 * Wrap a per-test upstream handler so unrelated background fetches (the
 * models.dev pricing-catalog refresh) never reach it or skew the exact
 * upstream-attempt counts.
 */
function upstreamOnlyFetch(
	handler: (input: Request | string | URL) => Response | Promise<Response>,
): typeof globalThis.fetch {
	return mock(async (input: Request | string | URL) => {
		if (!isUpstreamCall(input)) {
			return new Response("unavailable", { status: 500 });
		}
		return handler(input);
	}) as never;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitFor: condition not met within timeout");
		}
		await sleep(5);
	}
}

/**
 * An upstream that accepts the connection and never answers until the signal it
 * was HANDED aborts — the real production shape of a client disconnect on an
 * in-flight attempt. Records the signal so the test can prove the client's
 * abort actually propagated down the chain (rather than a hand-thrown error).
 */
function hangUntilAbortedFetch(state: {
	calls: number;
	signal: AbortSignal | null;
}): typeof globalThis.fetch {
	return upstreamOnlyFetch((input) => {
		state.calls++;
		const signal = input instanceof Request ? input.signal : undefined;
		state.signal = signal ?? null;
		return new Promise<Response>((_, reject) => {
			if (!signal) {
				reject(new Error("upstream fetch received no AbortSignal"));
				return;
			}
			signal.addEventListener(
				"abort",
				() =>
					reject(new DOMException("The operation was aborted.", "AbortError")),
				{ once: true },
			);
		});
	});
}

describe("client-abort terminals", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearAnthropicBurstThrottle();
		resetHoldSlots();
		clearProviderOverloadCooldown();
		cacheBodyStore.setEnabled(false);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearAnthropicBurstThrottle();
		resetHoldSlots();
		clearProviderOverloadCooldown();
		// Restore the singleton's default state (setEnabled(false) also clears any
		// staged entry a test left behind).
		cacheBodyStore.setEnabled(false);
	});

	// ===== T1: the request-level terminal =====

	it("single affinity-pinned candidate + mid-flight client disconnect → resolves 499, never ALL_ACCOUNTS_FAILED", async () => {
		const account = makeAccount();
		const ctx = makeContext([account], makeAffinityHitStrategy(account.id));

		const state = { calls: 0, signal: null as AbortSignal | null };
		globalThis.fetch = hangUntilAbortedFetch(state);

		const controller = new AbortController();
		const pending = callHandleProxy(
			makeRequest(controller.signal),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// Only abort once the attempt is genuinely in flight upstream.
		await waitFor(() => state.calls === 1);
		controller.abort();

		const response = await pending;

		// The client's abort really reached the upstream fetch's signal — this is
		// the production chain, not a hand-thrown AbortError.
		expect(state.signal?.aborted).toBe(true);
		expect(response.status).toBe(499);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("client_closed_request");
		// NOTE: this pool has ONE account and the affinity preflight attempts it
		// outside `runCandidateLoop` (the loop then skips it via `skipAccountId`),
		// so `calls === 1` here says nothing about fan-out. The real fan-out
		// assertions live in the T4 block below, against a 3-account pool.
		expect(state.calls).toBe(1);
	}, 15_000);

	it("aborted request whose attempted account has an expired refresh token → 499, not the reauth 503", async () => {
		// The `needsReauth` throw sits ABOVE the generic ALL_ACCOUNTS_FAILED throw;
		// a guard placed too low would leave it exposed and tell an operator to
		// re-authenticate a healthy account because a client hung up.
		const account = makeAccount({
			created_at: Date.now() - 200 * 24 * 60 * 60 * 1000,
			refresh_token_issued_at: Date.now() - 200 * 24 * 60 * 60 * 1000,
		});
		const ctx = makeContext([account], makeAffinityHitStrategy(account.id));

		const state = { calls: 0, signal: null as AbortSignal | null };
		globalThis.fetch = hangUntilAbortedFetch(state);

		const controller = new AbortController();
		const pending = callHandleProxy(
			makeRequest(controller.signal),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		await waitFor(() => state.calls === 1);
		controller.abort();

		const response = await pending;

		expect(response.status).toBe(499);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("client_closed_request");
		expect(JSON.stringify(body)).not.toContain("OAuth tokens have expired");
	}, 15_000);

	it("live client (no abort): an ordinary all-fail still THROWS ALL_ACCOUNTS_FAILED", async () => {
		const account = makeAccount();
		const ctx = makeContext([account], makeAffinityHitStrategy(account.id));

		let calls = 0;
		globalThis.fetch = upstreamOnlyFetch(() => {
			calls++;
			// A genuine network failure — NOT an abort.
			throw new TypeError("connection reset");
		});

		await expect(
			callHandleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			),
		).rejects.toThrow(/All accounts failed to proxy the request/);
		expect(calls).toBe(1);
	}, 15_000);

	it("live client (no abort): an expired-OAuth all-fail still THROWS the reauth 503", async () => {
		const account = makeAccount({
			created_at: Date.now() - 200 * 24 * 60 * 60 * 1000,
			refresh_token_issued_at: Date.now() - 200 * 24 * 60 * 60 * 1000,
		});
		const ctx = makeContext([account], makeAffinityHitStrategy(account.id));

		globalThis.fetch = upstreamOnlyFetch(() => {
			throw new TypeError("connection reset");
		});

		await expect(
			callHandleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			),
		).rejects.toThrow(/OAuth tokens have expired/);
	}, 15_000);

	it("race policy: a genuine account failure PLUS a client abort → 499 at request level, per-attempt cooldown still applied", async () => {
		// "Client disconnect wins at request level": the aggregate verdict becomes
		// 499 even though a real 429 landed, because there is no client left to
		// receive the aggregate. Every PER-ATTEMPT effect must still have happened.
		const account = makeAccount();
		const ctx = makeContext([account], makeAffinityHitStrategy(account.id));

		const controller = new AbortController();
		let calls = 0;
		globalThis.fetch = upstreamOnlyFetch(() => {
			calls++;
			// The client hangs up in the same tick the upstream rejection lands.
			controller.abort();
			return new Response(
				JSON.stringify({
					type: "error",
					error: { type: "rate_limit_error", message: "Too many requests" },
				}),
				{
					status: 429,
					headers: {
						"content-type": "application/json",
						"anthropic-ratelimit-unified-status": "rejected",
						"anthropic-ratelimit-unified-reset": String(
							Math.floor((Date.now() + 3_600_000) / 1000),
						),
					},
				},
			);
		});

		const response = await callHandleProxy(
			makeRequest(controller.signal),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(499);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("client_closed_request");
		expect(calls).toBe(1);
		// The per-attempt effect happened before the terminal was reached.
		expect(cooldownCalls(ctx)).toBeGreaterThan(0);
	}, 15_000);

	it("does not leak the staged cache-keepalive body on the 499 return", async () => {
		cacheBodyStore.setEnabled(true);
		const baseline = cacheBodyStore.getStagingSize();

		const account = makeAccount();
		const ctx = makeContext([account], makeAffinityHitStrategy(account.id));

		const state = { calls: 0, signal: null as AbortSignal | null };
		let stagedDuringAttempt = -1;
		const inner = hangUntilAbortedFetch(state);
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const result = inner(input as never);
			if (isUpstreamCall(input)) {
				// Sampled AFTER proxyWithAccount staged the body, BEFORE the abort.
				stagedDuringAttempt = cacheBodyStore.getStagingSize();
			}
			return result;
		}) as never;

		const controller = new AbortController();
		const pending = callHandleProxy(
			makeCacheableRequest(controller.signal),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		await waitFor(() => state.calls === 1);
		controller.abort();

		const response = await pending;

		expect(response.status).toBe(499);
		// Non-vacuity: something really WAS staged for this request.
		expect(stagedDuringAttempt).toBe(baseline + 1);
		// ...and it was reclaimed on the way out, not left to the age sweep.
		expect(cacheBodyStore.getStagingSize()).toBe(baseline);
	}, 15_000);

	// ===== T2: the selection-time terminals =====

	it("client aborts during selection → 499 instead of pool_exhausted, and NO synthetic history row", async () => {
		const cooled = makeAccount({
			id: "acc-cooled",
			name: "Cooled",
			rate_limited_until: Date.now() + 3_600_000,
		});

		// Baseline (live client): the pool-exhausted terminal DOES record a row.
		let calls = 0;
		globalThis.fetch = upstreamOnlyFetch(() => {
			calls++;
			return new Response("nope", { status: 500 });
		});
		const liveCtx = makeContext(
			[cooled],
			makeSelectionAbortStrategy(() => {}),
		);
		const liveResponse = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			liveCtx,
		);
		expect(liveResponse.status).toBe(503);
		expect(
			((await liveResponse.json()) as { error: { type: string } }).error.type,
		).toBe("pool_exhausted");
		expect(recordSyntheticCalls(liveCtx)).toBe(1);

		// Aborted client: 499, no ERROR-level pool_exhausted, no history row.
		const controller = new AbortController();
		const abortedCtx = makeContext(
			[cooled],
			makeSelectionAbortStrategy(() => controller.abort()),
		);
		const response = await callHandleProxy(
			makeRequest(controller.signal),
			new URL("https://proxy.local/v1/messages"),
			abortedCtx,
		);

		expect(response.status).toBe(499);
		const body = (await response.json()) as Record<string, unknown>;
		expect((body.error as Record<string, unknown>).type).toBe(
			"client_closed_request",
		);
		expect(recordSyntheticCalls(abortedCtx)).toBe(0);
		expect(calls).toBe(0);
	}, 15_000);

	it("client aborts during selection on a Codex-CLI request → 499 instead of pinned_target_unavailable, and NO synthetic history row", async () => {
		const cooled = makeAccount({
			id: "codex-cooled",
			name: "Codex-Cooled",
			provider: "codex",
			rate_limited_until: Date.now() + 3_600_000,
		});
		const denyOfficial = { "x-clankermux-deny-official-anthropic": "1" };

		let calls = 0;
		globalThis.fetch = upstreamOnlyFetch(() => {
			calls++;
			return new Response("nope", { status: 500 });
		});

		// Baseline (live client): the pinned terminal DOES record a row.
		const liveCtx = makeContext(
			[cooled],
			makeSelectionAbortStrategy(() => {}),
		);
		const liveResponse = await callHandleProxy(
			makeRequest(undefined, denyOfficial),
			new URL("https://proxy.local/v1/messages"),
			liveCtx,
		);
		expect(liveResponse.status).toBe(503);
		expect(
			((await liveResponse.json()) as { error: { type: string } }).error.type,
		).toBe("pinned_target_unavailable");
		expect(recordSyntheticCalls(liveCtx)).toBe(1);

		const controller = new AbortController();
		const abortedCtx = makeContext(
			[cooled],
			makeSelectionAbortStrategy(() => controller.abort()),
		);
		const response = await callHandleProxy(
			makeRequest(controller.signal, denyOfficial),
			new URL("https://proxy.local/v1/messages"),
			abortedCtx,
		);

		expect(response.status).toBe(499);
		const body = (await response.json()) as Record<string, unknown>;
		expect((body.error as Record<string, unknown>).type).toBe(
			"client_closed_request",
		);
		expect(recordSyntheticCalls(abortedCtx)).toBe(0);
		expect(calls).toBe(0);
	}, 15_000);

	// ===== T3: /v1/responses carries the client signal =====

	it("/v1/responses: a client disconnect reaches handleProxy's terminal as 499, not the aggregate 503", async () => {
		const { handleResponsesRequest } = await import(
			"@clankermux/openai-responses-adapter"
		);
		const { handleProxy } = await import("../proxy");

		// Non-official-Anthropic account (the adapter's unconditional Codex-CLI
		// floor drops official Claude accounts), resolved through the ctx fallback
		// provider so the upstream URL is deterministic.
		const account = makeAccount({
			id: "passthrough-1",
			name: "Passthrough",
			provider: "test-provider" as Account["provider"],
		});
		const ctx = makeContext([account], makeAffinityHitStrategy(account.id));

		const controller = new AbortController();
		let calls = 0;
		globalThis.fetch = upstreamOnlyFetch(() => {
			calls++;
			// The client hangs up; the un-threaded upstream attempt fails on its own.
			controller.abort();
			throw new TypeError("connection reset");
		});

		const req = new Request("https://proxy.local/v1/responses", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "hi" }],
					},
				],
				stream: false,
			}),
			signal: controller.signal,
		});

		const response = await handleResponsesRequest(
			req,
			new URL(req.url),
			handleProxy as never,
			ctx,
		);

		// Without the signal on the adapter's synthetic request this is a 503
		// ("Service temporarily unavailable") produced by the adapter's catch.
		expect(response.status).toBe(499);
		const body = (await response.json()) as {
			error: { type: string; code: string };
		};
		expect(body.error.type).toBe("client_closed_request");
		expect(calls).toBe(1);
	}, 15_000);

	// ===== T4: the candidate loop must not fan out after a disconnect =====
	//
	// Every test here uses a >= 3 account, NON-affinity pool, so `runCandidateLoop`
	// owns all of them. The T1 fan-out claim was vacuous: with one affinity-held
	// account the preflight attempts it outside the loop and `skipAccountId` makes
	// the loop skip the only entry, so the loop body never executed at all.

	it("disconnect on the first candidate → 499 and candidates 2 and 3 are never attempted", async () => {
		const accounts = makeApiKeyPool(3);
		const ctx = makeContext(accounts, makeRoundRobinStrategy());

		const state = { calls: 0, signal: null as AbortSignal | null };
		globalThis.fetch = hangUntilAbortedFetch(state);

		const controller = new AbortController();
		const pending = callHandleProxy(
			makeRequest(controller.signal),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		await waitFor(() => state.calls === 1);
		controller.abort();

		const response = await pending;

		expect(state.signal?.aborted).toBe(true);
		expect(response.status).toBe(499);
		const body = (await response.json()) as Record<string, unknown>;
		expect((body.error as Record<string, unknown>).type).toBe(
			"client_closed_request",
		);
		// The pool had two more healthy candidates and neither was touched.
		expect(state.calls).toBe(1);
	}, 15_000);

	it("disconnect during an attempt that RETURNS a 401 → 499 before candidate 2, no cooldown written", async () => {
		// Designed so it CANNOT pass via the proxyWithAccount catch: the first
		// attempt does not throw, it returns an ordinary 401 Response and signals
		// failover by returning null. Only the loop's own top-of-body abort check
		// can stop candidate 2 here. A 401 (not a 429) so the "no cooldown" claim
		// is about the abort guard and not about which status writes a cooldown.
		const accounts = makeApiKeyPool(3);
		const ctx = makeContext(accounts, makeRoundRobinStrategy());

		const controller = new AbortController();
		let calls = 0;
		globalThis.fetch = upstreamOnlyFetch(() => {
			calls++;
			// The client hangs up while this attempt is being processed. The
			// attempt itself completes normally.
			controller.abort();
			return new Response(
				JSON.stringify({
					type: "error",
					error: { type: "authentication_error", message: "invalid x-api-key" },
				}),
				{ status: 401, headers: { "content-type": "application/json" } },
			);
		});

		const response = await callHandleProxy(
			makeRequest(controller.signal),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(499);
		const body = (await response.json()) as Record<string, unknown>;
		expect((body.error as Record<string, unknown>).type).toBe(
			"client_closed_request",
		);
		expect(calls).toBe(1);
		expect(cooldownCalls(ctx)).toBe(0);
	}, 15_000);

	it("disconnect on the first candidate of a multi-account pool discards the staged cache body", async () => {
		// proxyWithAccount stages a cacheable body BEFORE fetching, and its
		// client-abort terminal returns a Response — at which point the candidate
		// loop returns immediately and both the loop's cleanup and the
		// request-level tail are bypassed. The discard therefore has to happen
		// inside that terminal itself; without it the staged body is left to the
		// age sweep.
		cacheBodyStore.setEnabled(true);
		const baseline = cacheBodyStore.getStagingSize();

		const accounts = makeApiKeyPool(3);
		const ctx = makeContext(accounts, makeRoundRobinStrategy());

		const state = { calls: 0, signal: null as AbortSignal | null };
		let stagedDuringAttempt = -1;
		const inner = hangUntilAbortedFetch(state);
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const result = inner(input as never);
			if (isUpstreamCall(input)) {
				stagedDuringAttempt = cacheBodyStore.getStagingSize();
			}
			return result;
		}) as never;

		const controller = new AbortController();
		const pending = callHandleProxy(
			makeCacheableRequest(controller.signal),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		await waitFor(() => state.calls === 1);
		controller.abort();

		const response = await pending;

		expect(response.status).toBe(499);
		// Non-vacuity: something really WAS staged for this request.
		expect(stagedDuringAttempt).toBe(baseline + 1);
		expect(cacheBodyStore.getStagingSize()).toBe(baseline);
		expect(state.calls).toBe(1);
	}, 15_000);

	// The two tests above drive `handleProxy`, so neither can pin the
	// ATTEMPT-level terminal inside `proxyWithAccount`: that function returning
	// `null` (the pre-fix behaviour) is indistinguishable from there, because the
	// candidate loop's own top-of-body abort check then produces the 499 and
	// discards the staged body for candidate two. The attempt-level terminal has
	// to be observed where it returns — directly.

	it("proxyWithAccount RETURNS the 499 itself on an aborted attempt, and discards its own staged body", async () => {
		// Invoked directly, with no candidate loop underneath to paper over it:
		// if the attempt-level terminal returned `null` (signalling failover) or
		// skipped its own `discardStaged`, nothing else in this call could
		// substitute for either.
		const { proxyWithAccount } = await import("../handlers");
		cacheBodyStore.setEnabled(true);
		const baseline = cacheBodyStore.getStagingSize();

		const account = makeApiKeyPool(1)[0];
		const ctx = makeContext([account], makeRoundRobinStrategy());

		const state = { calls: 0, signal: null as AbortSignal | null };
		let stagedDuringAttempt = -1;
		const inner = hangUntilAbortedFetch(state);
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const result = inner(input as never);
			if (isUpstreamCall(input)) {
				// Sampled AFTER proxyWithAccount staged the body, BEFORE the abort.
				stagedDuringAttempt = cacheBodyStore.getStagingSize();
			}
			return result;
		}) as never;

		const controller = new AbortController();
		const req = makeCacheableRequest(controller.signal);
		const requestBodyBuffer = await req.clone().arrayBuffer();
		const requestMeta = {
			id: "direct-attempt-abort-1",
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			requestedModel: "claude-sonnet-4-5",
			routing: null,
		} as unknown as RequestMeta;

		const pending = proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			requestMeta,
			requestBodyBuffer,
			() => undefined,
			0,
			ctx,
			null,
			null,
			null,
			null,
			false,
			// The candidate loop threads the CLIENT's signal in here; without it the
			// upstream fetch would be armed with the internal timeout controller
			// alone and a disconnect would never reach this attempt.
			{ signal: req.signal },
		);

		await waitFor(() => state.calls === 1);
		controller.abort();

		const response = await pending;

		// (1) The attempt itself is terminal — NOT a `null` failover signal.
		expect(response).not.toBeNull();
		expect(response?.status).toBe(499);
		const body = (await (response as Response).json()) as Record<
			string,
			unknown
		>;
		expect((body.error as Record<string, unknown>).type).toBe(
			"client_closed_request",
		);
		// (2) Non-vacuity: something really WAS staged by this attempt...
		expect(stagedDuringAttempt).toBe(baseline + 1);
		// ...and this attempt reclaimed it on its own way out.
		expect(cacheBodyStore.getStagingSize()).toBe(baseline);
	}, 15_000);

	it("AbortError with a LIVE client (composed budget/timeout signal) still fails over", async () => {
		// The discriminator is `req.signal.aborted`, never `isAbortError`. The
		// burst / overload / context-window holds each build their own
		// AbortController and compose it with the client signal via
		// AbortSignal.any, and makeProxyRequest composes its internal request
		// timeout the same way — so an AbortError can perfectly well arrive while
		// the client is still connected and waiting. That case MUST keep failing
		// over rather than short-circuiting to 499.
		const accounts = makeApiKeyPool(2);
		const ctx = makeContext(accounts, makeRoundRobinStrategy());

		let calls = 0;
		globalThis.fetch = upstreamOnlyFetch(() => {
			calls++;
			throw new DOMException("The operation was aborted.", "AbortError");
		});

		// No client signal at all: req.signal.aborted is false throughout.
		await expect(
			callHandleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			),
		).rejects.toThrow(/All accounts failed to proxy the request/);
		// Both candidates attempted — the AbortError did not terminate the loop.
		expect(calls).toBe(2);
	}, 15_000);

	// ===== T5: the forced-account path =====

	it("forced account + client disconnect → 499, and nothing is recorded", async () => {
		// proxyForcedAccount now threads the client signal into its single upstream
		// fetch. Without a matching abort check, that change would turn every
		// client disconnect into a recorded forced-account failure (a local 502 plus
		// a Request History row) — trading a leak for a new mis-classification.
		const { proxyForcedAccount } = await import("../handlers");
		const account = makeApiKeyPool(1)[0];
		const ctx = makeContext([account], makeRoundRobinStrategy());

		const state = { calls: 0, signal: null as AbortSignal | null };
		globalThis.fetch = hangUntilAbortedFetch(state);

		const controller = new AbortController();
		const requestMeta = {
			id: "forced-abort-1",
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			requestedModel: "claude-sonnet-4-5",
			routing: null,
		} as unknown as RequestMeta;

		const pending = proxyForcedAccount(
			makeRequest(controller.signal),
			new URL("https://proxy.local/v1/messages"),
			account,
			requestMeta,
			null,
			ctx,
		);

		await waitFor(() => state.calls === 1);
		controller.abort();

		const response = await pending;

		expect(state.signal?.aborted).toBe(true);
		expect(response.status).toBe(499);
		const body = (await response.json()) as Record<string, unknown>;
		expect((body.error as Record<string, unknown>).type).toBe(
			"client_closed_request",
		);
		// Nothing recorded: no forced_account_unavailable row, no recorder begin.
		expect(
			(
				ctx.requestRecorder as unknown as {
					begin: { mock: { calls: unknown[] } };
				}
			).begin.mock.calls.length,
		).toBe(0);
		expect(
			(ctx.dbOps as unknown as { saveRequest: { mock: { calls: unknown[] } } })
				.saveRequest.mock.calls.length,
		).toBe(0);
	}, 15_000);

	it("forced account + disconnect while the token refresh fails → 499, and nothing is recorded", async () => {
		// The token-resolution catch has its OWN `return`, so the outer catch's
		// abort check never runs for it. Without a matching check at the top of
		// that catch, a disconnect racing a failing refresh becomes a recorded
		// forced-account failure (local 502 + Request History row) — the same
		// defect the outer check fixed, one site short.
		const { proxyForcedAccount } = await import("../handlers");
		// OAuth account with an already-expired access token, so
		// getValidAccessToken must go to the network to refresh.
		const account = makeAccount({
			id: "forced-oauth-refresh-abort",
			name: "Forced-OAuth",
			api_key: null,
			refresh_token: "rt-token",
			access_token: "expired-at-token",
			expires_at: Date.now() - 60_000,
		});
		const ctx = makeContext([account], makeRoundRobinStrategy());

		const controller = new AbortController();
		let refreshCalls = 0;
		let upstreamCalls = 0;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const target = input instanceof Request ? input.url : String(input);
			if (target.includes("/v1/oauth/token")) {
				refreshCalls++;
				// The client hangs up while the refresh is in flight, and the
				// refresh then fails (transient network error — NOT invalid_grant,
				// so no account pause is involved).
				controller.abort();
				throw new TypeError("connection reset");
			}
			if (isUpstreamCall(input)) {
				upstreamCalls++;
				return new Response("should never be reached", { status: 500 });
			}
			return new Response("unavailable", { status: 500 });
		}) as never;

		const requestMeta = {
			id: "forced-token-abort-1",
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			requestedModel: "claude-sonnet-4-5",
			routing: null,
		} as unknown as RequestMeta;

		const response = await proxyForcedAccount(
			makeRequest(controller.signal),
			new URL("https://proxy.local/v1/messages"),
			account,
			requestMeta,
			null,
			ctx,
		);

		// Non-vacuity: the refresh really was attempted and really did fail, and
		// the request never reached upstream.
		expect(refreshCalls).toBe(1);
		expect(upstreamCalls).toBe(0);

		expect(response.status).toBe(499);
		const body = (await response.json()) as Record<string, unknown>;
		expect((body.error as Record<string, unknown>).type).toBe(
			"client_closed_request",
		);
		// Nothing recorded: no forced_account_unavailable row, no recorder begin,
		// no DB write of any kind.
		expect(
			(
				ctx.requestRecorder as unknown as {
					begin: { mock: { calls: unknown[] } };
				}
			).begin.mock.calls.length,
		).toBe(0);
		expect(
			(ctx.dbOps as unknown as { saveRequest: { mock: { calls: unknown[] } } })
				.saveRequest.mock.calls.length,
		).toBe(0);
		expect(recordSyntheticCalls(ctx)).toBe(0);
	}, 15_000);
});
