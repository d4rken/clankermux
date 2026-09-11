import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	type Account,
	type NativeResponsesContext,
	setNativeResponsesRequestContext,
} from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import { routingAttempts } from "./fixtures/routing-harness";

/**
 * The proxy rewrites the client's `reasoning.effort` to fit what the target
 * backend accepts, in BOTH directions (5.x lowers `minimal` to `none`, GPT-6
 * raises it to `low`), and the only trace used to be a debug log line. These
 * cover the durable record on the attempt row, for both places an outgoing
 * effort is decided: the native Responses passthrough and the Anthropic→Codex
 * translator.
 *
 * The attempt row, not the request row, because one request can dispatch
 * several attempts against backends with different effort vocabularies.
 */

async function callHandleProxy(req: Request, url: URL, ctx: ProxyContext) {
	const { handleProxy } = await import("./fixtures/routing-harness");
	return handleProxy(req, url, ctx);
}

function makeCodexAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "codex-1",
		name: "Codex",
		provider: "codex",
		// An API-key account: a 401 then fails straight over instead of taking
		// the stale-token refresh rung, which would need a live OAuth endpoint.
		api_key: "sk-codex",
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
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

function makeContext(accounts: Account[]): ProxyContext {
	const byId = new Map(accounts.map((a) => [a.id, a]));
	return {
		strategy: {
			select: (accs: Account[]) =>
				[...accs]
					.filter((acc) => !acc.paused)
					.sort((a, b) => a.priority - b.priority),
		} as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getAccount: mock(async (id: string) => byId.get(id) ?? null),
			getActiveComboForFamily: mock(async () => null),
			markAccountRateLimited: mock(async () => 1),
			markAccountRateLimitedDeadlineOnly: mock(async () => {}),
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
			getCacheWarmingEnabled: () => false,
			getCacheWarmingMinTokens: () => 100_000,
			getStorePayloads: () => false,
		} as never,
		provider: {
			name: "test-provider",
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
			isStreamingResponse: (response: Response) =>
				response.headers.get("content-type")?.includes("text/event-stream") ??
				false,
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

const rawCodexSse = [
	"event: response.created",
	`data: ${JSON.stringify({ response: { id: "resp_1", model: "gpt-5.5-codex" } })}`,
	"",
	"event: response.output_text.delta",
	`data: ${JSON.stringify({ delta: "Hello" })}`,
	"",
	"event: response.completed",
	`data: ${JSON.stringify({
		response: {
			model: "gpt-5.5-codex",
			usage: { input_tokens: 1, output_tokens: 1 },
		},
	})}`,
	"",
	"",
].join("\n");

function codexSseResponse(): Response {
	return new Response(rawCodexSse, { status: 200 });
}

function isProxyCall(input: RequestInfo | URL): boolean {
	const url = input instanceof Request ? input.url : String(input);
	return (
		url.includes("chatgpt.com") ||
		url.includes("codex.example.com") ||
		url.includes("upstream.local") ||
		url.includes("/v1/messages")
	);
}

/** The synthetic /v1/messages request the Responses adapter forwards. */
function makeRequest(
	body: Record<string, unknown>,
	nativeCtx?: NativeResponsesContext,
): Request {
	const req = new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (nativeCtx) setNativeResponsesRequestContext(req, nativeCtx);
	return req;
}

/** A native Responses request carrying `reasoning` exactly as the client sent it. */
function makeNativeRequest(
	model: string,
	reasoning?: Record<string, unknown>,
): Request {
	return makeRequest(
		{
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "translated" }],
			max_tokens: 16,
			stream: true,
		},
		{
			nativeBody: JSON.stringify({
				model,
				instructions: "Be brief.",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "native" }],
					},
				],
				stream: true,
				...(reasoning ? { reasoning } : {}),
			}),
		},
	);
}

/** An Anthropic-shaped request for a codex model: the TRANSLATED path. */
function makeTranslatedRequest(extra: Record<string, unknown> = {}): Request {
	return makeRequest({
		model: "gpt-5.5-codex",
		messages: [{ role: "user", content: "translated" }],
		max_tokens: 16,
		stream: true,
		...extra,
	});
}

function effortOf(bodyText: string | null): unknown {
	return (JSON.parse(bodyText ?? "{}") as { reasoning?: { effort?: unknown } })
		.reasoning?.effort;
}

describe("reasoning-effort adaptation capture", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	/** Captures the body of every upstream call and answers with Codex SSE. */
	function captureUpstream(
		respond: (url: string) => Response = () => codexSseResponse(),
	): { byUrl: Map<string, string> } {
		const byUrl = new Map<string, string>();
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, _init?: RequestInit) => {
				// Anything else (a token endpoint, the pricing catalog) is refused
				// locally rather than reaching the network.
				if (!isProxyCall(input))
					return new Response("unavailable", { status: 500 });
				const request = input as Request;
				byUrl.set(new URL(request.url).host, await request.clone().text());
				return respond(request.url);
			},
		) as never;
		return { byUrl };
	}

	it("native passthrough: a clamped effort is recorded as requested, effective and why", async () => {
		const captured = captureUpstream();
		const ctx = makeContext([makeCodexAccount()]);
		const req = makeNativeRequest("gpt-5.5-codex", { effort: "minimal" });

		const res = await callHandleProxy(req, new URL(req.url), ctx);
		expect(res.status).toBe(200);

		// `minimal` is not in the 5.x backend vocabulary; `none` is the neighbour
		// below it.
		expect(effortOf(captured.byUrl.get("chatgpt.com") ?? null)).toBe("none");
		expect(routingAttempts(ctx)).toHaveLength(1);
		expect(routingAttempts(ctx)[0]).toMatchObject({
			reasoning_effort_requested: "minimal",
			reasoning_effort_effective: "none",
			reasoning_effort_reason: "chatgpt_backend_clamp",
		});
	});

	it("translated path: the recorded request is the CLIENT's effort, not the proxy's default", async () => {
		const captured = captureUpstream();
		const ctx = makeContext([makeCodexAccount()]);
		const req = makeTranslatedRequest({ reasoning: { effort: "minimal" } });

		const res = await callHandleProxy(req, new URL(req.url), ctx);
		expect(res.status).toBe(200);

		const attempt = routingAttempts(ctx)[0];
		expect(attempt).toMatchObject({
			reasoning_effort_requested: "minimal",
			reasoning_effort_effective: "none",
			reasoning_effort_reason: "chatgpt_backend_clamp",
		});
		// The translator supplies `medium` for a client that asked for nothing,
		// and the clamp only ever sees the resolved value — recording that as the
		// client's request is exactly the lie this capture exists to avoid.
		expect(attempt?.reasoning_effort_requested).not.toBe("medium");
		// The row agrees with the bytes: `effective` is what went on the wire.
		expect(effortOf(captured.byUrl.get("chatgpt.com") ?? null)).toBe(
			attempt?.reasoning_effort_effective,
		);
	});

	it("records a RAISE as an adaptation, not only a downgrade", async () => {
		const captured = captureUpstream();
		const ctx = makeContext([makeCodexAccount()]);
		const req = makeNativeRequest("gpt-6-astra", { effort: "minimal" });

		const res = await callHandleProxy(req, new URL(req.url), ctx);
		expect(res.status).toBe(200);

		// GPT-6 lists no level below `low`, so the same `minimal` moves UP here.
		expect(effortOf(captured.byUrl.get("chatgpt.com") ?? null)).toBe("low");
		expect(routingAttempts(ctx)[0]).toMatchObject({
			reasoning_effort_requested: "minimal",
			reasoning_effort_effective: "low",
			reasoning_effort_reason: "chatgpt_backend_clamp",
		});
	});

	it("records no adaptation for an unrecognised effort that passes through", async () => {
		const captured = captureUpstream();
		const ctx = makeContext([makeCodexAccount()]);
		const req = makeNativeRequest("gpt-5.5-codex", { effort: "ludicrous" });

		const res = await callHandleProxy(req, new URL(req.url), ctx);
		expect(res.status).toBe(200);

		expect(effortOf(captured.byUrl.get("chatgpt.com") ?? null)).toBe(
			"ludicrous",
		);
		expect(routingAttempts(ctx)[0]).toMatchObject({
			reasoning_effort_requested: "ludicrous",
			reasoning_effort_effective: "ludicrous",
			reasoning_effort_reason: null,
		});
	});

	it("native passthrough: no client effort records absence, not a guessed backend default", async () => {
		const captured = captureUpstream();
		const ctx = makeContext([makeCodexAccount()]);
		const req = makeNativeRequest("gpt-5.5-codex");

		const res = await callHandleProxy(req, new URL(req.url), ctx);
		expect(res.status).toBe(200);

		// Nothing was sent, so the backend's own default applies and we do not
		// know what it is.
		expect(effortOf(captured.byUrl.get("chatgpt.com") ?? null)).toBeUndefined();
		expect(routingAttempts(ctx)[0]).toMatchObject({
			reasoning_effort_requested: null,
			reasoning_effort_effective: null,
			reasoning_effort_reason: null,
		});
	});

	it("translated path: a proxy-supplied default is recorded as the proxy's, with no client request", async () => {
		const captured = captureUpstream();
		const ctx = makeContext([makeCodexAccount()]);
		const req = makeTranslatedRequest();

		const res = await callHandleProxy(req, new URL(req.url), ctx);
		expect(res.status).toBe(200);

		// This path always serializes an effort, so absence cannot be preserved
		// on the wire — but it is preserved in who is recorded as having asked.
		expect(effortOf(captured.byUrl.get("chatgpt.com") ?? null)).toBe("medium");
		expect(routingAttempts(ctx)[0]).toMatchObject({
			reasoning_effort_requested: null,
			reasoning_effort_effective: "medium",
			reasoning_effort_reason: "proxy_default",
		});
	});

	it("two attempts against different backends record their own adaptation, failed one included", async () => {
		const chatgpt = makeCodexAccount({ id: "codex-chatgpt", priority: 0 });
		const custom = makeCodexAccount({
			id: "codex-custom",
			name: "Codex custom",
			priority: 1,
			// A Codex-compatible endpoint that is NOT the ChatGPT backend: its
			// parameter vocabulary is its own, so nothing is clamped for it.
			custom_endpoint: "https://codex.example.com/v1/responses",
		});
		const captured = captureUpstream((url) =>
			url.includes("chatgpt.com")
				? new Response(JSON.stringify({ error: "unauthorized" }), {
						status: 401,
						headers: { "content-type": "application/json" },
					})
				: codexSseResponse(),
		);
		const ctx = makeContext([chatgpt, custom]);
		const req = makeNativeRequest("gpt-5.5-codex", { effort: "minimal" });

		const res = await callHandleProxy(req, new URL(req.url), ctx);
		expect(res.status).toBe(200);

		expect(effortOf(captured.byUrl.get("chatgpt.com") ?? null)).toBe("none");
		expect(effortOf(captured.byUrl.get("codex.example.com") ?? null)).toBe(
			"minimal",
		);
		const attempts = routingAttempts(ctx);
		expect(attempts).toHaveLength(2);
		// The failed attempt keeps its own adaptation — it is the only record
		// that the request it actually sent was not the request it was given.
		expect(attempts[0]).toMatchObject({
			account_id: "codex-chatgpt",
			status: 401,
			reasoning_effort_requested: "minimal",
			reasoning_effort_effective: "none",
			reasoning_effort_reason: "chatgpt_backend_clamp",
		});
		expect(attempts[1]).toMatchObject({
			account_id: "codex-custom",
			reasoning_effort_requested: "minimal",
			reasoning_effort_effective: "minimal",
			reasoning_effort_reason: null,
		});
	});

	it("ignores a client-supplied adaptation header", async () => {
		captureUpstream();
		const ctx = makeContext([makeCodexAccount()]);
		const req = makeNativeRequest("gpt-5.5-codex", { effort: "high" });
		req.headers.set(
			"x-clankermux-reasoning-effort",
			btoa('{"requested":"max","effective":"none","reason":"forged"}'),
		);

		const res = await callHandleProxy(req, new URL(req.url), ctx);
		expect(res.status).toBe(200);

		// `high` is accepted as-is, so the attempt records no adaptation at all.
		expect(routingAttempts(ctx)[0]).toMatchObject({
			reasoning_effort_requested: "high",
			reasoning_effort_effective: "high",
			reasoning_effort_reason: null,
		});
	});
});
