import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	type Account,
	NATIVE_RESPONSES_REQUEST_HEADER,
	NATIVE_RESPONSES_RESPONSE_HEADER,
	type NativeResponsesContext,
	type RequestMeta,
	setNativeResponsesMetaContext,
	setNativeResponsesRequestContext,
} from "@clankermux/types";
import type { ProxyContext } from "../handlers";

mock.module("../inline-worker", () => ({ EMBEDDED_WORKER_CODE: "" }));

/**
 * Stage A native Responses passthrough — per-attempt branch in
 * proxyWithAccount (driven end-to-end through handleProxy so the
 * Request→RequestMeta re-keying in proxy.ts is covered too):
 * - codex account + native context + clientStream:true → upstream fetch
 *   receives the ORIGINAL Responses body (model override / built-in tools
 *   intact) and the response comes back as raw Codex SSE with the marker.
 * - non-codex account (same request) → receives the TRANSLATED body.
 * - clientStream:false → translated even on a codex account.
 */

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

function makeCodexAccount(overrides: Partial<Account> = {}): Account {
	return makeAccount({
		id: "codex-1",
		name: "Codex",
		provider: "codex",
		refresh_token: "rt-codex",
		access_token: "at-codex",
		expires_at: Date.now() + 3_600_000,
		...overrides,
	});
}

function makeContext(accounts: Account[]): ProxyContext {
	const byId = new Map(accounts.map((a) => [a.id, a]));
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
		// Fallback provider for unregistered provider names ("test-provider"):
		// pass-through transforms with a deterministic upstream URL.
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

const NATIVE_RESPONSES_BODY = {
	model: "gpt-5.5-codex",
	instructions: "Be brief.",
	input: [
		{
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "native marker hello" }],
		},
	],
	tools: [{ type: "web_search" }],
	stream: true,
};

function makeNativeContext(
	overrides: Partial<NativeResponsesContext> = {},
): NativeResponsesContext {
	return {
		nativeBody: JSON.stringify(NATIVE_RESPONSES_BODY),
		clientStream: true,
		...overrides,
	};
}

/** The synthetic /v1/messages request the responses adapter would forward. */
function makeTranslatedRequest(nativeCtx?: NativeResponsesContext): Request {
	const req = new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "translated marker hello" }],
			max_tokens: 16,
			stream: true,
		}),
	});
	if (nativeCtx) {
		setNativeResponsesRequestContext(req, nativeCtx);
	}
	return req;
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

function codexSseResponse() {
	return new Response(rawCodexSse, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function isProxyCall(input: RequestInfo | URL): boolean {
	const url = input instanceof Request ? input.url : String(input);
	return (
		url.includes("chatgpt.com") ||
		url.includes("upstream.local") ||
		url.includes("/v1/messages")
	);
}

describe("native Responses passthrough (Stage A, request leg)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("codex account + clientStream:true → upstream receives the NATIVE body, response is raw marked SSE", async () => {
		const codex = makeCodexAccount();
		let capturedBody: string | null = null;
		let capturedNativeHeader: string | null = null;

		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				const upstreamReq = input as Request;
				capturedBody = await upstreamReq.clone().text();
				capturedNativeHeader = upstreamReq.headers.get(
					NATIVE_RESPONSES_REQUEST_HEADER,
				);
				return codexSseResponse();
			},
		) as never;

		const ctx = makeContext([codex]);
		const req = makeTranslatedRequest(makeNativeContext());
		const res = await callHandleProxy(req, new URL(req.url), ctx);

		expect(res.status).toBe(200);
		expect(capturedBody).not.toBeNull();
		const upstreamBody = JSON.parse(capturedBody ?? "{}");
		// The ORIGINAL Responses body went upstream (lightly patched) — built-in
		// tool types survive, no Anthropic messages array.
		expect(upstreamBody.tools).toEqual([{ type: "web_search" }]);
		expect(upstreamBody.model).toBe("gpt-5.5-codex");
		expect(upstreamBody.messages).toBeUndefined();
		expect(JSON.stringify(upstreamBody)).toContain("native marker hello");
		expect(JSON.stringify(upstreamBody)).not.toContain(
			"translated marker hello",
		);
		expect(upstreamBody.stream).toBe(true);
		expect(upstreamBody.store).toBe(false);
		// The internal native flag is an in-proxy relay signal only — it must be
		// stripped before the request leaves for the Codex backend.
		expect(capturedNativeHeader).toBeNull();

		// Response leg: raw Codex-Responses SSE, marked for the adapter.
		expect(res.headers.get(NATIVE_RESPONSES_RESPONSE_HEADER)).toBe("1");
		const resText = await res.text();
		expect(resText).toContain("response.created");
		expect(resText).not.toContain("message_start");
	});

	it("non-codex account with the same native context → upstream receives the TRANSLATED body", async () => {
		const generic = makeAccount({
			id: "generic-1",
			name: "Generic",
			provider: "test-provider" as Account["provider"],
			api_key: "test-key",
			refresh_token: "",
			access_token: null,
			expires_at: null,
		});
		let capturedBody: string | null = null;
		let capturedNativeHeader: string | null = null;

		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				const upstreamReq = input as Request;
				capturedBody = await upstreamReq.clone().text();
				capturedNativeHeader = upstreamReq.headers.get(
					NATIVE_RESPONSES_REQUEST_HEADER,
				);
				return new Response(
					JSON.stringify({
						id: "msg_1",
						type: "message",
						role: "assistant",
						content: [{ type: "text", text: "hi" }],
						model: "claude-sonnet-4-5",
						stop_reason: "end_turn",
						usage: { input_tokens: 1, output_tokens: 1 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		) as never;

		const ctx = makeContext([generic]);
		const req = makeTranslatedRequest(makeNativeContext());
		const res = await callHandleProxy(req, new URL(req.url), ctx);

		expect(res.status).toBe(200);
		expect(capturedBody).not.toBeNull();
		const upstreamBody = JSON.parse(capturedBody ?? "{}");
		// Translated Anthropic body — untouched by the native side-channel.
		expect(Array.isArray(upstreamBody.messages)).toBe(true);
		expect(JSON.stringify(upstreamBody)).toContain("translated marker hello");
		expect(JSON.stringify(upstreamBody)).not.toContain("native marker hello");
		expect(capturedNativeHeader).toBeNull();
		expect(res.headers.get(NATIVE_RESPONSES_RESPONSE_HEADER)).toBeNull();
	});

	it("clientStream:false → translated body even on a codex account", async () => {
		const codex = makeCodexAccount();
		let capturedBody: string | null = null;
		let capturedNativeHeader: string | null = null;

		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				const upstreamReq = input as Request;
				capturedBody = await upstreamReq.clone().text();
				capturedNativeHeader = upstreamReq.headers.get(
					NATIVE_RESPONSES_REQUEST_HEADER,
				);
				return codexSseResponse();
			},
		) as never;

		const ctx = makeContext([codex]);
		const req = makeTranslatedRequest(
			makeNativeContext({ clientStream: false }),
		);
		const res = await callHandleProxy(req, new URL(req.url), ctx);

		expect(res.status).toBe(200);
		expect(capturedBody).not.toBeNull();
		const upstreamBody = JSON.parse(capturedBody ?? "{}");
		// Translated path: Anthropic→Codex conversion ran (input items, no
		// built-in web_search tool, model mapped by family default).
		expect(JSON.stringify(upstreamBody)).toContain("translated marker hello");
		expect(JSON.stringify(upstreamBody)).not.toContain("native marker hello");
		expect(JSON.stringify(upstreamBody)).not.toContain("web_search");
		expect(Array.isArray(upstreamBody.input)).toBe(true);
		expect(capturedNativeHeader).toBeNull();
		expect(res.headers.get(NATIVE_RESPONSES_RESPONSE_HEADER)).toBeNull();
	});

	it("failover: codex 401 with native body, then non-codex sibling gets the translated body", async () => {
		const codex = makeCodexAccount({ priority: 0 });
		const generic = makeAccount({
			id: "generic-2",
			name: "Generic2",
			provider: "test-provider" as Account["provider"],
			api_key: "test-key",
			refresh_token: "",
			access_token: null,
			expires_at: null,
			priority: 1,
		});
		const bodiesByTarget: Record<string, string> = {};

		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				const upstreamReq = input as Request;
				const text = await upstreamReq.clone().text();
				if (upstreamReq.url.includes("chatgpt.com")) {
					bodiesByTarget.codex = text;
					return new Response(JSON.stringify({ error: "unauthorized" }), {
						status: 401,
						headers: { "content-type": "application/json" },
					});
				}
				bodiesByTarget.generic = text;
				return new Response(
					JSON.stringify({
						id: "msg_1",
						type: "message",
						role: "assistant",
						content: [{ type: "text", text: "hi" }],
						model: "claude-sonnet-4-5",
						stop_reason: "end_turn",
						usage: { input_tokens: 1, output_tokens: 1 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		) as never;

		const ctx = makeContext([codex, generic]);
		const req = makeTranslatedRequest(makeNativeContext());
		const res = await callHandleProxy(req, new URL(req.url), ctx);

		expect(res.status).toBe(200);
		// Per-attempt decision: the codex attempt went native, the failover
		// sibling re-entered the branch and picked the translated buffer.
		expect(bodiesByTarget.codex).toContain("native marker hello");
		expect(bodiesByTarget.codex).toContain("web_search");
		expect(bodiesByTarget.generic).toContain("translated marker hello");
		expect(bodiesByTarget.generic).not.toContain("native marker hello");
	});

	it("Stage B marker survival: full round-trip keeps the marker through forwardToClient/sanitization with the raw body byte-identical", async () => {
		// The /v1/responses adapter (Stage B) keys its passthrough decision on
		// this marker — it must survive every Response reconstruction between
		// CodexProvider.processResponse and the handleProxy caller (forwardToClient
		// + proxy header sanitization only strip encoding/length headers).
		const codex = makeCodexAccount();

		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				return codexSseResponse();
			},
		) as never;

		const ctx = makeContext([codex]);
		const req = makeTranslatedRequest(makeNativeContext());
		const res = await callHandleProxy(req, new URL(req.url), ctx);

		expect(res.status).toBe(200);
		expect(res.headers.get(NATIVE_RESPONSES_RESPONSE_HEADER)).toBe("1");
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		// Raw Codex SSE, byte-identical — no translation happened anywhere.
		const text = await res.text();
		expect(text).toBe(rawCodexSse);
	});

	it("applies an active per-attempt model override to the native body", async () => {
		const codex = makeCodexAccount();
		let capturedBody: string | null = null;

		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				capturedBody = await (input as Request).clone().text();
				return codexSseResponse();
			},
		) as never;

		const { proxyWithAccount } = await import("../handlers/proxy-operations");
		const ctx = makeContext([codex]);
		const req = makeTranslatedRequest();
		const requestBodyBuffer = await req.clone().arrayBuffer();
		const requestMeta: RequestMeta = {
			id: "req-override-1",
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
		};
		setNativeResponsesMetaContext(requestMeta, makeNativeContext());

		const res = await proxyWithAccount(
			req,
			new URL(req.url),
			codex,
			requestMeta,
			requestBodyBuffer,
			() => undefined,
			0,
			ctx,
			"gpt-5.4-override",
		);

		expect(res?.status).toBe(200);
		expect(capturedBody).not.toBeNull();
		const upstreamBody = JSON.parse(capturedBody ?? "{}");
		// Native body forwarded with the override patched into `.model`; the rest
		// of the native payload survives.
		expect(upstreamBody.model).toBe("gpt-5.4-override");
		expect(upstreamBody.tools).toEqual([{ type: "web_search" }]);
		expect(JSON.stringify(upstreamBody)).toContain("native marker hello");
	});

	it("corrupt nativeBody → falls back to the TRANSLATED body, no native flag upstream, response not native-marked", async () => {
		const codex = makeCodexAccount();
		let capturedBody: string | null = null;
		let capturedNativeHeader: string | null = null;

		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!isProxyCall(input)) return originalFetch(input as never, init);
				const upstreamReq = input as Request;
				capturedBody = await upstreamReq.clone().text();
				capturedNativeHeader = upstreamReq.headers.get(
					NATIVE_RESPONSES_REQUEST_HEADER,
				);
				return codexSseResponse();
			},
		) as never;

		const ctx = makeContext([codex]);
		const req = makeTranslatedRequest(
			makeNativeContext({ nativeBody: "{not json" }),
		);
		const res = await callHandleProxy(req, new URL(req.url), ctx);

		expect(res.status).toBe(200);
		expect(capturedBody).not.toBeNull();
		// The corrupt native body never goes upstream: the translated Anthropic
		// body takes over (Anthropic→Codex translation ran on the codex account).
		expect(JSON.stringify(capturedBody)).toContain("translated marker hello");
		expect(JSON.stringify(capturedBody)).not.toContain("native marker hello");
		expect(JSON.stringify(capturedBody)).not.toContain("web_search");
		expect(capturedNativeHeader).toBeNull();
		// And the response is NOT native-marked — the back-translation ran.
		expect(res.headers.get(NATIVE_RESPONSES_RESPONSE_HEADER)).toBeNull();
		const resText = await res.text();
		expect(resText).toContain("message_start");
	});
});
