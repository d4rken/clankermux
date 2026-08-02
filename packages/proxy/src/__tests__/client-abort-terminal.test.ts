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
		// Exactly ONE upstream attempt: a disconnect must not fan out to siblings.
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
});
