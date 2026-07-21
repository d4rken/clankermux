/**
 * Integration tests for the half-open overload-probe lifecycle (Stage C).
 *
 * A half-open bucket (cooldown expired, entry persisted) admits exactly ONE
 * probe request through `proxyWithAccount`; concurrent requests are suppressed
 * (fail over / 529 terminal) until the probe reaches a verdict. The verdict is
 * judged on FULL stream completion — the incident's overloads arrive mid-stream
 * after 200 headers — not on response headers:
 *   - clean EOF on a successful response  → "recovered" (bucket closed)
 *   - mid-stream `overloaded_error` frame → "reopened" (fresh cooldown)
 *   - pre-stream 529                      → "reopened" (re-trip at the trip site)
 *   - stream error / disconnect           → "abandoned" (lease released)
 *   - non-streaming 2xx                   → "recovered" at forward time
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
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
	completeProviderOverloadProbe,
	getProviderWideOverloadUntil,
	inspectProviderOverload,
	tryAcquireProviderOverloadProbe,
} from "../provider-overload-cooldown";

async function callHandleProxy(req: Request, url: URL, ctx: ProxyContext) {
	const { handleProxy } = await import("../proxy");
	return handleProxy(req, url, ctx);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "Main-me",
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
			isStreamingResponse: (r: Response) =>
				r.headers.get("content-type")?.includes("text/event-stream") ?? false,
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

function modelRequest(model: string, signal?: AbortSignal): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
		signal,
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

function overloaded529() {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "overloaded_error", message: "Overloaded" },
		}),
		{ status: 529, headers: { "content-type": "application/json" } },
	);
}

const encoder = new TextEncoder();

/** SSE 200 whose body emits the given frames, then closes cleanly. */
function sseResponse(frames: string[]) {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const frame of frames) {
				controller.enqueue(encoder.encode(frame));
			}
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** SSE 200 whose body emits one healthy frame, then errors mid-stream. */
function sseErroringResponse() {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				encoder.encode(
					'event: message_start\ndata: {"type":"message_start"}\n\n',
				),
			);
			controller.error(new Error("upstream connection reset"));
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const HEALTHY_SSE_FRAMES = [
	'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":10}}}\n\n',
	'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
	'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

const MIDSTREAM_OVERLOAD_FRAMES = [
	'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":10}}}\n\n',
	'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
];

/**
 * Wrap a per-test upstream handler so unrelated background fetches — the
 * models.dev pricing-catalog refresh fired by the usage finalizer's cost
 * lookup — never reach it. Without the shunt the catalog refresh lands
 * mid-test through the mocked `globalThis.fetch`, skewing exact
 * fetch-call-count assertions (order-dependent: only when no earlier test
 * file already warmed the in-process catalog), and a mocked 200 would poison
 * the on-disk pricing cache. The 500 makes pricing fall back to its bundled
 * data.
 */
function upstreamOnlyFetch(
	handler: (input: Request | string | URL) => Response | Promise<Response>,
): typeof globalThis.fetch {
	return mock(async (input: Request | string | URL) => {
		const url = input instanceof Request ? input.url : String(input);
		if (!url.includes("api.anthropic.com")) {
			return new Response("unavailable", { status: 500 });
		}
		return handler(input);
	}) as never;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `cond` is true (bounded) — avoids racy fixed sleeps. */
async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitFor: condition not met within timeout");
		}
		await sleep(5);
	}
}

/** Trip the anthropic:haiku bucket, then wait for it to become half-open. */
async function tripToHalfOpen(model = "claude-haiku-4-5"): Promise<void> {
	applyProviderOverloadCooldown("anthropic", Date.now() + 5, model);
	await sleep(15);
	expect(inspectProviderOverload("anthropic", model).state).toBe("half-open");
}

describe("half-open overload probe lifecycle", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeAll(async () => {
		// Warm the proxy module graph so the first in-test request doesn't spend
		// its concurrency window inside the dynamic import.
		await import("../proxy");
	});

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
	});

	it("suppresses a concurrent second request into the transparent hold without an upstream hit", async () => {
		let fetchCalls = 0;
		let releaseProbe: (r: Response) => void = () => {};
		const probeGate = new Promise<Response>((resolve) => {
			releaseProbe = resolve;
		});
		globalThis.fetch = upstreamOnlyFetch(async () => {
			fetchCalls++;
			if (fetchCalls === 1) return probeGate;
			return ok200("claude-haiku-4-5");
		}) as never;

		await tripToHalfOpen();
		const ctx = makeContext([makeAccount()]);

		const p1 = callHandleProxy(
			modelRequest("claude-haiku-4-5"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		// Let request 1 reach the upstream fetch and hold the probe lease.
		await waitFor(() => fetchCalls === 1);

		// Request 2 is suppressed by admission and HELD (Stage D) — no second
		// upstream hit while the probe is undecided, and no bounced 529.
		const p2 = callHandleProxy(
			modelRequest("claude-haiku-4-5"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		await sleep(100);
		expect(fetchCalls).toBe(1);

		releaseProbe(ok200("claude-haiku-4-5"));
		const res1 = await p1;
		expect(res1.status).toBe(200);
		// Non-streaming 2xx probe verdict → bucket closed.
		expect(inspectProviderOverload("anthropic", "claude-haiku-4-5").state).toBe(
			"closed",
		);
		// The holder wakes on its short poll and is served transparently.
		const res2 = await p2;
		expect(res2.status).toBe(200);
		expect(fetchCalls).toBe(2);
	}, 15_000);

	it("fails a concurrent second request over to a different-provider account without an upstream hit on the probed family", async () => {
		let fetchCalls = 0;
		let releaseProbe: (r: Response) => void = () => {};
		const probeGate = new Promise<Response>((resolve) => {
			releaseProbe = resolve;
		});
		globalThis.fetch = upstreamOnlyFetch(async () => {
			fetchCalls++;
			if (fetchCalls === 1) return probeGate;
			return ok200("claude-haiku-4-5");
		}) as never;

		await tripToHalfOpen();
		const anthropicAccount = makeAccount();
		const altAccount = makeAccount({
			id: "acc-2",
			name: "Alt",
			provider: "test-alt-provider",
			priority: 1,
		});
		const ctx = makeContext([anthropicAccount, altAccount]);

		const p1 = callHandleProxy(
			modelRequest("claude-haiku-4-5"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		await waitFor(() => fetchCalls === 1);

		// Second request: anthropic account suppressed (probe active) → served by
		// the alternate provider (its buckets are untouched).
		const res2 = await callHandleProxy(
			modelRequest("claude-haiku-4-5"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		expect(res2.status).toBe(200);
		expect(fetchCalls).toBe(2);

		releaseProbe(ok200("claude-haiku-4-5"));
		await p1;
	});

	it("closes the bucket after the probe's SSE stream completes cleanly", async () => {
		globalThis.fetch = upstreamOnlyFetch(async () =>
			sseResponse(HEALTHY_SSE_FRAMES),
		) as never;

		await tripToHalfOpen();
		const ctx = makeContext([makeAccount()]);

		const res = await callHandleProxy(
			modelRequest("claude-haiku-4-5"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		expect(res.status).toBe(200);
		// The verdict is judged on FULL stream completion, not headers: still
		// half-open (probe in flight) until the client drains the stream.
		expect(inspectProviderOverload("anthropic", "claude-haiku-4-5").state).toBe(
			"half-open",
		);
		await res.text();
		await sleep(20);

		expect(inspectProviderOverload("anthropic", "claude-haiku-4-5").state).toBe(
			"closed",
		);

		// Subsequent requests flow with no admission suppression.
		const res2 = await callHandleProxy(
			modelRequest("claude-haiku-4-5"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		expect(res2.status).toBe(200);
	});

	it("re-opens the bucket on a mid-stream overloaded_error during the probe", async () => {
		globalThis.fetch = upstreamOnlyFetch(async () =>
			sseResponse(MIDSTREAM_OVERLOAD_FRAMES),
		) as never;

		await tripToHalfOpen();
		const ctx = makeContext([makeAccount()]);

		const res = await callHandleProxy(
			modelRequest("claude-haiku-4-5"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		expect(res.status).toBe(200);
		await res.text();
		await sleep(20);

		const status = inspectProviderOverload("anthropic", "claude-haiku-4-5");
		expect(status.state).toBe("open");
		expect(status.probeActive).toBe(false);

		// A later request is gated as open — no upstream hit. The within-budget
		// cooldown means it enters the transparent hold (Stage D); aborting the
		// client exits it promptly without ever touching upstream.
		const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
		const callsBefore = fetchMock.mock.calls.length;
		const controller = new AbortController();
		const p2 = callHandleProxy(
			modelRequest("claude-haiku-4-5", controller.signal),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		await sleep(100);
		controller.abort();
		const res2 = await p2;
		expect(res2.status).toBe(499);
		expect(fetchMock.mock.calls.length).toBe(callsBefore);
	});

	it("re-trips on a pre-stream 529 probe and releases the lease as reopened", async () => {
		globalThis.fetch = upstreamOnlyFetch(async () => overloaded529()) as never;

		await tripToHalfOpen();
		const ctx = makeContext([makeAccount()]);

		const res = await callHandleProxy(
			modelRequest("claude-haiku-4-5"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		// Single account + final attempt → the upstream 529 is forwarded (not
		// ALL_ACCOUNTS_FAILED), and the breaker is open again with no stuck lease.
		expect(res.status).toBe(529);
		const status = inspectProviderOverload("anthropic", "claude-haiku-4-5");
		expect(status.state).toBe("open");
		expect(status.probeActive).toBe(false);
	});

	it("abandons the lease on a mid-stream error so another request can probe", async () => {
		globalThis.fetch = upstreamOnlyFetch(async () =>
			sseErroringResponse(),
		) as never;

		await tripToHalfOpen();
		const ctx = makeContext([makeAccount()]);

		const res = await callHandleProxy(
			modelRequest("claude-haiku-4-5"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		expect(res.status).toBe(200);
		await res.text().catch(() => {});
		await sleep(20);

		// No verdict: still half-open, but the lease is released.
		const status = inspectProviderOverload("anthropic", "claude-haiku-4-5");
		expect(status.state).toBe("half-open");
		expect(status.probeActive).toBe(false);

		// Another request can acquire the probe.
		const admission = tryAcquireProviderOverloadProbe(
			"anthropic",
			"claude-haiku-4-5",
		);
		expect(admission.admitted).toBe(true);
		if (admission.admitted) {
			expect(admission.token).not.toBeNull();
			completeProviderOverloadProbe(admission.token, "abandoned");
		}
	});

	it("closes the bucket on a non-streaming 2xx probe at forward time", async () => {
		globalThis.fetch = upstreamOnlyFetch(async () =>
			ok200("claude-haiku-4-5"),
		) as never;

		await tripToHalfOpen();
		const ctx = makeContext([makeAccount()]);

		const res = await callHandleProxy(
			modelRequest("claude-haiku-4-5"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		expect(res.status).toBe(200);
		expect(inspectProviderOverload("anthropic", "claude-haiku-4-5").state).toBe(
			"closed",
		);
	});

	it("trips the LOGICAL family bucket (not provider-wide) when the mapped model resolves to no family", async () => {
		globalThis.fetch = upstreamOnlyFetch(async () => overloaded529());

		// The account maps the haiku family to a model with NO Claude family —
		// the 529 must be attributed to the LOGICAL haiku bucket, not the
		// provider-wide bucket that would gate every family.
		const account = makeAccount({
			model_mappings: JSON.stringify({ haiku: "qwen/qwen-2.5" }),
		});
		const ctx = makeContext([account]);

		const res = await callHandleProxy(
			modelRequest("claude-haiku-4-5"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		expect(res.status).toBe(529);

		// The trip landed on the haiku FAMILY bucket…
		expect(inspectProviderOverload("anthropic", "claude-haiku-4-5").state).toBe(
			"open",
		);
		// …while the provider-wide bucket stayed closed: other families route.
		expect(getProviderWideOverloadUntil("anthropic")).toBeNull();
		expect(
			inspectProviderOverload("anthropic", "claude-sonnet-4-5").state,
		).toBe("closed");
	});

	it("admits a mapped-model probe by its LOGICAL family while another family's probe is in flight", async () => {
		let fetchCalls = 0;
		globalThis.fetch = upstreamOnlyFetch(async () => {
			fetchCalls++;
			return ok200("claude-haiku-4-5");
		});

		// A half-open SONNET bucket with an in-flight probe. If admission gated
		// the unresolvable mapped model by the provider-wide aggregate, the
		// sonnet probe would wrongly suppress this haiku request.
		await tripToHalfOpen("claude-sonnet-4-5");
		const sonnetProbe = tryAcquireProviderOverloadProbe(
			"anthropic",
			"claude-sonnet-4-5",
		);
		if (!sonnetProbe.admitted || !sonnetProbe.token) {
			throw new Error("expected an admitted sonnet probe");
		}

		const account = makeAccount({
			model_mappings: JSON.stringify({ haiku: "qwen/qwen-2.5" }),
		});
		const ctx = makeContext([account]);

		const res = await callHandleProxy(
			modelRequest("claude-haiku-4-5"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		// Admitted against the healthy LOGICAL haiku family — one upstream hit.
		expect(res.status).toBe(200);
		expect(fetchCalls).toBe(1);

		completeProviderOverloadProbe(sonnetProbe.token, "abandoned");
	});

	it("releases the probe lease when forwardToClient's setup throws", async () => {
		await tripToHalfOpen();
		const admission = tryAcquireProviderOverloadProbe(
			"anthropic",
			"claude-haiku-4-5",
		);
		if (!admission.admitted || !admission.token) {
			throw new Error("expected an admitted probe with a token");
		}
		const token = admission.token;

		const ctx = makeContext([makeAccount()]);
		(ctx.requestRecorder as unknown as { begin: () => void }).begin = () => {
			throw new Error("recorder begin failed");
		};

		const { forwardToClient } = await import("../response-handler");
		await expect(
			forwardToClient(
				{
					requestId: "req-setup-throw",
					method: "POST",
					path: "/v1/messages",
					account: makeAccount(),
					requestHeaders: new Headers(),
					requestBody: null,
					response: ok200("claude-haiku-4-5"),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
					overloadProbeToken: token,
				},
				ctx,
			),
		).rejects.toThrow("recorder begin failed");

		// The lease was settled "abandoned" before the rethrow — the bucket is
		// still half-open and another request can probe IMMEDIATELY, instead of
		// waiting out the lease-TTL safety valve.
		const status = inspectProviderOverload("anthropic", "claude-haiku-4-5");
		expect(status.state).toBe("half-open");
		expect(status.probeActive).toBe(false);
		const second = tryAcquireProviderOverloadProbe(
			"anthropic",
			"claude-haiku-4-5",
		);
		expect(second.admitted).toBe(true);
		if (second.admitted) {
			expect(second.token).not.toBeNull();
			completeProviderOverloadProbe(second.token, "abandoned");
		}
	});
});
