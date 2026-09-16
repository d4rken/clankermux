import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { makeAccount as canonicalAccount } from "@clankermux/test-support";
import {
	type Account,
	NATIVE_RESPONSES_RESPONSE_HEADER,
	type NativeResponsesContext,
	setNativeResponsesRequestContext,
} from "@clankermux/types";
import {
	getCodexTransientFailureUntil,
	resetCodexTransientHealthForTests,
} from "../codex-transient-health";
import { setCodexTransientHoldOverrideForTests } from "../codex-transient-hold";
import type { ProxyContext } from "../handlers";

/**
 * A Codex backend failure can arrive as HTTP 200 with an in-band SSE `error`
 * event and nothing generated yet. Forwarded, the Codex CLI renders it as
 * "Selected model is at capacity. Please try a different model." while healthy
 * siblings sit idle. These tests pin the rung that discards such a response
 * before it is committed and hands the request to the next account — and the
 * cases it must leave alone: a stream that already produced content, a
 * translated (non-native) response, an internal dispatch, and a pool with
 * nobody left to try.
 */

async function callHandleProxy(
	req: Request,
	ctx: ProxyContext,
	isInternal = false,
) {
	const { handleProxy } = await import("./fixtures/routing-harness");
	return handleProxy(req, new URL(req.url), ctx, null, null, isInternal);
}

function makeCodexAccount(overrides: Partial<Account> = {}): Account {
	return canonicalAccount({
		name: "Codex",
		provider: "codex",
		refresh_token: "rt-codex",
		access_token: "at-codex",
		expires_at: Date.now() + 3_600_000,
		created_at: Date.now(),
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
	stream: true,
};

function makeNativeContext(): NativeResponsesContext {
	return { nativeBody: JSON.stringify(NATIVE_RESPONSES_BODY) };
}

/** The synthetic /v1/messages request the responses adapter would forward. */
function makeRequest(native = true): Request {
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
	if (native) setNativeResponsesRequestContext(req, makeNativeContext());
	return req;
}

const healthySse = [
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

/** Prelude only, then the in-band failure — the 85-of-94 shape. */
const preludeFailureSse =
	"event: response.created\n" +
	`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n` +
	"event: response.in_progress\n" +
	`data: ${JSON.stringify({ type: "response.in_progress", response: { id: "resp_1" } })}\n\n` +
	"event: error\n" +
	`data: ${JSON.stringify({
		type: "error",
		error: { type: "service_unavailable_error", code: "server_is_overloaded" },
	})}\n\n`;

/**
 * The failure as the very first event, with no prelude in front of it. This is
 * the shape whose translation keeps a transient code: the provider returns on
 * the upstream error before `ensureMessageStart()`, so the translated stream has
 * no `message_start` either, and `toAnthropicErrorPayload` rewrites the error's
 * `type` while carrying its `code` through untouched.
 */
const errorFirstSse =
	"event: error\n" +
	'data: {"type":"error","error":{"type":"server_error","code":"server_error","message":"capacity"}}\n\n';

/** Content first, then the same failure — must never be discarded. */
const contentThenFailureSse =
	"event: response.created\n" +
	`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n` +
	"event: response.output_text.delta\n" +
	`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial output" })}\n\n` +
	"event: error\n" +
	`data: ${JSON.stringify({ type: "error", error: { type: "server_error" } })}\n\n`;

/**
 * Deliberately NO content-type header: the real Codex backend frequently omits
 * it on SSE, and the provider's native fix-up is what supplies it. The peek
 * guards on that header, so a fixture that set it here would pass whether or not
 * the rung actually sits downstream of the fix-up.
 */
function codexResponse(body: string): Response {
	return new Response(body, { status: 200 });
}

/** The parsed payload of the first SSE frame named `event: <name>`, else null. */
function parseSseEvent(body: string, name: string): unknown {
	for (const frame of body.split(/\r?\n\r?\n/)) {
		const lines = frame.split(/\r?\n/);
		if (!lines.includes(`event: ${name}`)) continue;
		const data = lines.find((line) => line.startsWith("data:"));
		if (data) return JSON.parse(data.slice(5).trim());
	}
	return null;
}

describe("Codex stream-prefix failover", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		resetCodexTransientHealthForTests();
		// Every discarded prefix now buys the account one held retry first. At the
		// real 30s these tests would each outrun bun's per-test timeout; the order
		// they assert is what they are here for, not the wait.
		setCodexTransientHoldOverrideForTests(1);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		resetCodexTransientHealthForTests();
		setCodexTransientHoldOverrideForTests(null);
	});

	function routeByAuth(bodies: Record<string, string>, calls: string[]) {
		return mock(async (input: RequestInfo | URL) => {
			const auth = (input as Request).headers.get("authorization") ?? "";
			calls.push(auth);
			return codexResponse(bodies[auth] ?? healthySse);
		}) as never;
	}

	it("serves the sibling's stream when the prefix fails before any content", async () => {
		const first = makeCodexAccount({
			id: crypto.randomUUID(),
			access_token: "first",
		});
		const second = makeCodexAccount({
			id: crypto.randomUUID(),
			access_token: "second",
		});
		const ctx = makeContext([first, second]);
		const calls: string[] = [];
		globalThis.fetch = routeByAuth(
			{ "Bearer first": preludeFailureSse },
			calls,
		);

		const res = await callHandleProxy(makeRequest(), ctx);
		const body = await res.text();

		// The failing account is held and retried once; the sibling takes over only
		// after that retry fails too.
		expect(calls).toEqual(["Bearer first", "Bearer first", "Bearer second"]);
		// The client never sees the failure — it gets the sibling's answer.
		expect(body).toBe(healthySse);
		expect(body).not.toContain("server_is_overloaded");
		expect(res.headers.get(NATIVE_RESPONSES_RESPONSE_HEADER)).toBe("1");
		// A routing hint only: no quota state is invented from a server failure.
		expect(getCodexTransientFailureUntil(first.id)).not.toBeNull();
		expect(first.rate_limited_until).toBeNull();
		expect(first.rate_limited_reason).toBeNull();
		expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
	});

	it("forwards a stream that already produced content, byte for byte", async () => {
		const first = makeCodexAccount({
			id: crypto.randomUUID(),
			access_token: "first",
		});
		const second = makeCodexAccount({
			id: crypto.randomUUID(),
			access_token: "second",
		});
		const ctx = makeContext([first, second]);
		const calls: string[] = [];
		globalThis.fetch = routeByAuth(
			{ "Bearer first": contentThenFailureSse },
			calls,
		);

		const res = await callHandleProxy(makeRequest(), ctx);

		// One attempt: a partial answer is the client's, not something to discard.
		expect(calls).toEqual(["Bearer first"]);
		expect(await res.text()).toBe(contentThenFailureSse);
	});

	it("forwards a healthy stream byte for byte", async () => {
		const only = makeCodexAccount({
			id: crypto.randomUUID(),
			access_token: "only",
		});
		const ctx = makeContext([only]);
		const calls: string[] = [];
		globalThis.fetch = routeByAuth({}, calls);

		const res = await callHandleProxy(makeRequest(), ctx);

		expect(calls).toEqual(["Bearer only"]);
		expect(await res.text()).toBe(healthySse);
		expect(getCodexTransientFailureUntil(only.id)).toBeNull();
	});

	it("forwards the failure when it is the only account in the pool", async () => {
		const only = makeCodexAccount({
			id: crypto.randomUUID(),
			access_token: "only",
		});
		const ctx = makeContext([only]);
		const calls: string[] = [];
		globalThis.fetch = routeByAuth({ "Bearer only": preludeFailureSse }, calls);

		const res = await callHandleProxy(makeRequest(), ctx);

		// Held and retried once even with nobody to fail over to, then forwarded.
		expect(calls).toEqual(["Bearer only", "Bearer only"]);
		// The upstream stream, not a synthetic proxy error.
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(preludeFailureSse);
		// Detection still records the routing hint, so the NEXT request prefers a
		// sibling if one appears.
		expect(getCodexTransientFailureUntil(only.id)).not.toBeNull();
	});

	it("fails over an error-first stream that never sent a prelude", async () => {
		const first = makeCodexAccount({
			id: crypto.randomUUID(),
			access_token: "first",
		});
		const second = makeCodexAccount({
			id: crypto.randomUUID(),
			access_token: "second",
		});
		const ctx = makeContext([first, second]);
		const calls: string[] = [];
		globalThis.fetch = routeByAuth({ "Bearer first": errorFirstSse }, calls);

		const res = await callHandleProxy(makeRequest(), ctx);

		expect(calls).toEqual(["Bearer first", "Bearer first", "Bearer second"]);
		expect(await res.text()).toBe(healthySse);
		expect(getCodexTransientFailureUntil(first.id)).not.toBeNull();
	});

	it("does not peek a translated (non-native) codex response", async () => {
		const first = makeCodexAccount({
			id: crypto.randomUUID(),
			access_token: "first",
		});
		const second = makeCodexAccount({
			id: crypto.randomUUID(),
			access_token: "second",
		});
		const ctx = makeContext([first, second]);
		const calls: string[] = [];
		globalThis.fetch = routeByAuth({ "Bearer first": errorFirstSse }, calls);

		const res = await callHandleProxy(makeRequest(false), ctx);
		const body = await res.text();

		// The same fixture the native test above fails over on, so the single
		// fetch here is the native-marker gate's doing and not the fixture going
		// undetected. It has to be THIS fixture: translation rewrites the error's
		// `type` but carries its `code` through, and `streamFailureCode` prefers
		// the code, so these translated bytes still read as transient — the peek
		// would discard them if it ran. That path keeps its post-commit
		// `observeCodexStreamHealth` demotion instead.
		expect(calls).toEqual(["Bearer first"]);
		expect(res.headers.get(NATIVE_RESPONSES_RESPONSE_HEADER)).toBeNull();
		expect(body).not.toContain("response.created");
		expect(parseSseEvent(body, "error")).toMatchObject({
			type: "error",
			error: { type: "api_error", code: "server_error" },
		});
	});

	it("skips the peek entirely on an internal dispatch", async () => {
		const only = makeCodexAccount({
			id: crypto.randomUUID(),
			access_token: "only",
		});
		const ctx = makeContext([only]);
		const calls: string[] = [];
		globalThis.fetch = routeByAuth({ "Bearer only": preludeFailureSse }, calls);

		// An internal dispatch is pinned to one account and names its maintenance
		// purpose; this is the shape a cache-keepalive replay arrives in.
		const req = makeRequest();
		req.headers.set("x-clankermux-account-id", only.id);
		req.headers.set("x-clankermux-keepalive", "1");
		const res = await callHandleProxy(req, ctx, true);
		await res.text();

		expect(calls).toEqual(["Bearer only"]);
		// A keepalive replay or refresh probe has no client to protect, and must
		// not demote a live account against real client traffic.
		expect(getCodexTransientFailureUntil(only.id)).toBeNull();
	});
});
