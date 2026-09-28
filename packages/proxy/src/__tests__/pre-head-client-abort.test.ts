/**
 * A client that leaves after an upstream attempt went out but before any
 * response reached it gets a Request History row with no outcome, and the
 * attempt it abandoned is stamped 499. The production shape is pi's
 * observational-memory request held by the Codex prefix peek and cancelled at
 * session shutdown.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { makeAccount as canonicalAccount } from "@clankermux/test-support";
import {
	type Account,
	CLIENT_CLOSED_REQUEST,
	type NativeResponsesContext,
	type RequestMeta,
	type RoutingAttempt,
	setNativeResponsesRequestContext,
} from "@clankermux/types";
import { resetCodexTransientHealthForTests } from "../codex-transient-health";
import { setCodexTransientHoldOverrideForTests } from "../codex-transient-hold";
import type { ProxyContext } from "../handlers";
import { createClientAbortResponse } from "../handlers/client-abort-response";
import {
	noteBridgedDispatch,
	notePreHeadAttempt,
	noteUpstreamDispatch,
	noteUpstreamSettled,
	preHeadAbortDispatch,
	trackPreHeadClientAbort,
	wasInFlightAtAbort,
} from "../pre-head-client-abort";
import type { RecordMeta } from "../request-recorder";
import { recordPreHeadClientAbort } from "../synthetic-terminal-recorder";

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
			hasRecord: mock(() => false),
			captureResponseChunk: mock(() => {}),
			finishTransport: mock(() => {}),
			attachUsageSummary: mock(() => {}),
			markUsageUnavailable: mock(() => {}),
			recordSynthetic: mock(() => {}),
			recordClientClosedBeforeHead: mock(() => {}),
			onWorkerGone: mock(() => {}),
			sweep: mock(() => {}),
			dispose: mock(() => {}),
		} as never,
	};
}

type RecorderMocks = {
	begin: { mock: { calls: unknown[][] } };
	recordSynthetic: { mock: { calls: unknown[][] } };
	recordClientClosedBeforeHead: { mock: { calls: unknown[][] } };
};
const recorder = (ctx: ProxyContext) =>
	ctx.requestRecorder as unknown as RecorderMocks;
const closedRows = (ctx: ProxyContext) =>
	recorder(ctx).recordClientClosedBeforeHead.mock.calls.map(
		(call) => call[0] as RecordMeta,
	);

const NATIVE_BODY = {
	model: "gpt-5.5-codex",
	instructions: "Be brief.",
	input: [
		{
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "observational memory" }],
		},
	],
	stream: true,
};

function makeRequest(signal?: AbortSignal): Request {
	const req = new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "translated" }],
			max_tokens: 16,
			stream: true,
		}),
		signal,
	});
	const native: NativeResponsesContext = {
		nativeBody: JSON.stringify(NATIVE_BODY),
	};
	setNativeResponsesRequestContext(req, native);
	return req;
}

const PRELUDE =
	"event: response.created\n" +
	`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n`;

const PRELUDE_FAILURE =
	PRELUDE +
	"event: error\n" +
	`data: ${JSON.stringify({
		type: "error",
		error: { type: "service_unavailable_error", code: "server_is_overloaded" },
	})}\n\n`;

/** A stream that sends its prelude and then stalls until `release()`. */
function stallingStream() {
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
			c.enqueue(new TextEncoder().encode(PRELUDE));
		},
	});
	return {
		response: new Response(body, { status: 200 }),
		release: () => {
			try {
				controller?.close();
			} catch {}
		},
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await sleep(5);
	}
}

async function callHandleProxy(req: Request, ctx: ProxyContext) {
	const { handleProxy } = await import("./fixtures/routing-harness");
	return handleProxy(req, new URL(req.url), ctx);
}
async function attemptsOf(ctx: ProxyContext): Promise<RoutingAttempt[]> {
	const { routingAttempts } = await import("./fixtures/routing-harness");
	return routingAttempts(ctx);
}

describe("pre-head client abort tracking", () => {
	const meta = () =>
		({
			id: crypto.randomUUID(),
			routing: {
				strategy: "session",
				decision: "round_robin",
				candidatesCount: 2,
			},
		}) as unknown as RequestMeta;
	const account = canonicalAccount({ name: "A", provider: "codex" });
	const send = (attemptId: string) => ({
		attemptId,
		account,
		providerName: "codex",
		resolvedModel: "gpt-6-astra",
	});

	it("keeps the routing that applied to the send", () => {
		const m = meta();
		trackPreHeadClientAbort(m, new AbortController().signal);
		notePreHeadAttempt(m, 1);
		noteUpstreamDispatch(m, send("a1"));
		m.routing = {
			strategy: "session",
			decision: "alias_stage_2",
			candidatesCount: 1,
		};
		const tracked = preHeadAbortDispatch(m);
		expect(tracked?.dispatch.routing).toMatchObject({ candidatesCount: 2 });
		expect(tracked?.dispatch.failoverAttempts).toBe(1);
		expect(Object.isFrozen(tracked?.dispatch)).toBe(true);
	});

	it("freezes the in-flight state at the moment the client leaves", () => {
		const m = meta();
		const client = new AbortController();
		trackPreHeadClientAbort(m, client.signal);
		noteUpstreamDispatch(m, send("a1"));
		client.abort();
		// Whatever the abort sets off afterwards must not rewrite the verdict.
		noteUpstreamSettled(m, "a1");
		expect(wasInFlightAtAbort(m, "a1")).toBe(true);
		expect(wasInFlightAtAbort(m, "other")).toBe(false);
		expect(preHeadAbortDispatch(m)?.inFlightAtAbort).toBe(true);
	});

	it("does not count a send that settled before the client left", () => {
		const m = meta();
		const client = new AbortController();
		trackPreHeadClientAbort(m, client.signal);
		noteUpstreamDispatch(m, send("a1"));
		noteUpstreamSettled(m, "a1");
		client.abort();
		expect(wasInFlightAtAbort(m, "a1")).toBe(false);
		expect(preHeadAbortDispatch(m)?.dispatch.attemptId).toBe("a1");
	});

	it("ignores a send that starts after the client left", () => {
		const m = meta();
		const client = new AbortController();
		trackPreHeadClientAbort(m, client.signal);
		client.abort();
		noteUpstreamDispatch(m, send("late"));
		expect(preHeadAbortDispatch(m)).toBeNull();
	});

	it("describes nothing once the bridge served any attempt", () => {
		const m = meta();
		trackPreHeadClientAbort(m, new AbortController().signal);
		noteUpstreamDispatch(m, send("a1"));
		noteBridgedDispatch(m);
		expect(preHeadAbortDispatch(m)).toBeNull();
	});

	it("counts same-account retries as sends, never as failovers", () => {
		const m = meta();
		trackPreHeadClientAbort(m, new AbortController().signal);
		notePreHeadAttempt(m, 0);
		noteUpstreamDispatch(m, send("a1"));
		noteUpstreamSettled(m, "a1");
		noteUpstreamDispatch(m, send("a2"));
		expect(preHeadAbortDispatch(m)).toMatchObject({
			sends: 2,
			dispatch: { attemptId: "a2", failoverAttempts: 0 },
		});
	});
});

describe("recording gate", () => {
	function gateFixture(internal: boolean, headers: Record<string, string>) {
		const account = makeCodexAccount({ id: crypto.randomUUID() });
		const ctx = makeContext([account]);
		const client = new AbortController();
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers,
			body: "{}",
			signal: client.signal,
		});
		const m = {
			id: crypto.randomUUID(),
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now() - 100,
			internal,
			routing: null,
		} as unknown as RequestMeta;
		trackPreHeadClientAbort(m, client.signal);
		noteUpstreamDispatch(m, {
			attemptId: "a1",
			account,
			providerName: "codex",
			resolvedModel: "gpt-6-astra",
		});
		client.abort();
		return { ctx, req, m };
	}

	it("records nothing for an aborted internal probe", async () => {
		const { ctx, req, m } = gateFixture(true, {
			"x-clankermux-auto-refresh": "true",
		});
		const recorded = await recordPreHeadClientAbort(
			req,
			new URL(req.url),
			ctx,
			m,
			createClientAbortResponse(),
			null,
		);
		expect(recorded).toBe(false);
		expect(closedRows(ctx)).toHaveLength(0);
	});

	it("records an external request that merely carries the probe header", async () => {
		const { ctx, req, m } = gateFixture(false, {
			"x-clankermux-auto-refresh": "true",
		});
		const recorded = await recordPreHeadClientAbort(
			req,
			new URL(req.url),
			ctx,
			m,
			createClientAbortResponse(),
			null,
		);
		expect(recorded).toBe(true);
		expect(closedRows(ctx)).toHaveLength(1);
	});
});

describe("Codex prefix peek abandoned by the client", () => {
	let originalFetch: typeof globalThis.fetch;
	const releases: Array<() => void> = [];

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		resetCodexTransientHealthForTests();
	});
	afterEach(() => {
		for (const release of releases.splice(0)) release();
		globalThis.fetch = originalFetch;
		resetCodexTransientHealthForTests();
		setCodexTransientHoldOverrideForTests(null);
	});

	function codexPool() {
		const first = makeCodexAccount({ id: crypto.randomUUID(), name: "one" });
		const second = makeCodexAccount({ id: crypto.randomUUID(), name: "two" });
		return { first, second, ctx: makeContext([first, second]) };
	}

	/** Upstream answers per call with the next handler; stalls by default. */
	function upstream(handlers: Array<() => Response>) {
		const calls: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input as Request;
			calls.push(request.headers.get("authorization") ?? "");
			const handler = handlers[calls.length - 1];
			if (handler) return handler();
			const stall = stallingStream();
			releases.push(stall.release);
			return stall.response;
		}) as never;
		return calls;
	}

	it("records one row for the stalled account and stamps its attempt", async () => {
		const { first, ctx } = codexPool();
		const calls = upstream([]);
		const client = new AbortController();
		const pending = callHandleProxy(makeRequest(client.signal), ctx);
		await waitFor(() => calls.length === 1);
		await sleep(50);
		const abortedAt = Date.now();
		client.abort();
		const response = await pending;

		expect(response.status).toBe(499);
		// No failover into a fan-out nobody is waiting for.
		expect(calls).toHaveLength(1);
		expect(recorder(ctx).recordSynthetic.mock.calls).toHaveLength(0);
		const rows = closedRows(ctx);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			accountId: first.id,
			accountName: "one",
			responseStatus: 499,
			authed: true,
			synthetic: false,
			failureSource: CLIENT_CLOSED_REQUEST,
			failoverAttempts: 0,
			model: "gpt-5.5-codex",
			providerName: "codex",
		});
		// Stamped with the arrival, so the row's response time is the wait.
		expect(abortedAt - rows[0].timestamp).toBeGreaterThanOrEqual(50);

		const attempts = await attemptsOf(ctx);
		expect(attempts).toHaveLength(1);
		expect(attempts[0]).toMatchObject({
			status: 499,
			error: CLIENT_CLOSED_REQUEST,
		});

		// The abandoned body ends later; its observer must not undo the stamp.
		for (const release of releases.splice(0)) release();
		await sleep(20);
		expect(attempts[0]).toMatchObject({
			status: 499,
			error: CLIENT_CLOSED_REQUEST,
		});
	});

	it("records the row even when the stamp cannot be written", async () => {
		const { ctx } = codexPool();
		const calls = upstream([]);
		const { provisionRouting } = await import("./fixtures/routing-harness");
		await provisionRouting(ctx, "gpt-5.5-codex");
		ctx.dbOps.routing.finishAttemptClientClosed = mock(async () => {
			throw new Error("database locked");
		}) as never;
		const client = new AbortController();
		const pending = callHandleProxy(makeRequest(client.signal), ctx);
		await waitFor(() => calls.length === 1);
		client.abort();
		expect((await pending).status).toBe(499);
		expect(closedRows(ctx)).toHaveLength(1);
		const [attempt] = await attemptsOf(ctx);
		expect(attempt.error).not.toBe(CLIENT_CLOSED_REQUEST);
	});

	it("records nothing when the client left before the fetch went out", async () => {
		const { ctx } = codexPool();
		const calls = upstream([]);
		const { provisionRouting } = await import("./fixtures/routing-harness");
		await provisionRouting(ctx, "gpt-5.5-codex");
		let resume: () => void = () => {};
		const paused = new Promise<void>((r) => {
			resume = r;
		});
		let entered = false;
		const record = ctx.dbOps.routing.recordAttempt;
		ctx.dbOps.routing.recordAttempt = mock(
			async (...args: Parameters<typeof record>) => {
				entered = true;
				await paused;
				return record(...args);
			},
		) as never;
		const client = new AbortController();
		const pending = callHandleProxy(makeRequest(client.signal), ctx);
		await waitFor(() => entered);
		client.abort();
		resume();
		expect((await pending).status).toBe(499);
		expect(closedRows(ctx)).toHaveLength(0);
		expect(calls.length).toBeLessThanOrEqual(1);
		for (const attempt of await attemptsOf(ctx))
			expect(attempt.error).not.toBe(CLIENT_CLOSED_REQUEST);
	});

	it("keeps an in-band failure's verdict when the client leaves during the retry hold", async () => {
		setCodexTransientHoldOverrideForTests(2_000);
		const { first, ctx } = codexPool();
		const calls = upstream([
			() => new Response(PRELUDE_FAILURE, { status: 200 }),
		]);
		const client = new AbortController();
		const pending = callHandleProxy(makeRequest(client.signal), ctx);
		await waitFor(() => calls.length === 1);
		await sleep(50);
		client.abort();
		expect((await pending).status).toBe(499);

		expect(calls).toHaveLength(1);
		const rows = closedRows(ctx);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ accountId: first.id, failoverAttempts: 0 });
		const attempts = await attemptsOf(ctx);
		expect(attempts).toHaveLength(1);
		expect(attempts[0].error).not.toBe(CLIENT_CLOSED_REQUEST);
		expect(attempts[0].status).toBe(200);
	});

	it("does not count a same-account retry as a failover", async () => {
		setCodexTransientHoldOverrideForTests(1);
		const { first, ctx } = codexPool();
		const calls = upstream([
			() => new Response(PRELUDE_FAILURE, { status: 200 }),
		]);
		const client = new AbortController();
		const pending = callHandleProxy(makeRequest(client.signal), ctx);
		await waitFor(() => calls.length === 2);
		await sleep(20);
		client.abort();
		expect((await pending).status).toBe(499);

		const rows = closedRows(ctx);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ accountId: first.id, failoverAttempts: 0 });
		const attempts = await attemptsOf(ctx);
		expect(attempts.map((a) => a.error === CLIENT_CLOSED_REQUEST)).toEqual([
			false,
			true,
		]);
	});

	it("counts the move to another account as one failover", async () => {
		setCodexTransientHoldOverrideForTests(1);
		const { second, ctx } = codexPool();
		const calls = upstream([
			() => new Response(PRELUDE_FAILURE, { status: 200 }),
			() => new Response(PRELUDE_FAILURE, { status: 200 }),
		]);
		const client = new AbortController();
		const pending = callHandleProxy(makeRequest(client.signal), ctx);
		await waitFor(() => calls.length === 3);
		await sleep(20);
		client.abort();
		expect((await pending).status).toBe(499);

		const rows = closedRows(ctx);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			accountId: second.id,
			failoverAttempts: 1,
		});
	});

	it("leaves a request whose response already started to the stream recorder", async () => {
		const { ctx } = codexPool();
		const content =
			PRELUDE +
			"event: response.output_text.delta\n" +
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}\n\n`;
		let release: () => void = () => {};
		globalThis.fetch = mock(async () => {
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new TextEncoder().encode(content));
					release = () => {
						try {
							c.close();
						} catch {}
					};
				},
			});
			return new Response(body, { status: 200 });
		}) as never;
		const client = new AbortController();
		const response = await callHandleProxy(makeRequest(client.signal), ctx);
		expect(response.status).toBe(200);
		client.abort();
		release();
		await response.body?.cancel().catch(() => {});

		expect(recorder(ctx).begin.mock.calls).toHaveLength(1);
		expect(closedRows(ctx)).toHaveLength(0);
		for (const attempt of await attemptsOf(ctx))
			expect(attempt.error).not.toBe(CLIENT_CLOSED_REQUEST);
	});
});

describe("a non-OK head whose preparation fails", () => {
	let originalFetch: typeof globalThis.fetch;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it.each([
		429, 400, 503,
	])("keeps the %i the upstream answered when the client leaves during preparation", async (status) => {
		const account = canonicalAccount({
			id: crypto.randomUUID(),
			name: "plain",
			provider: "test-provider",
			api_key: "k",
			refresh_token: "",
			access_token: null,
			expires_at: null,
			refresh_token_issued_at: null,
		});
		const ctx = makeContext([account]);
		const client = new AbortController();
		Object.assign(ctx.provider, {
			normalizeUpstreamResponse: async () => {
				client.abort();
				throw new Error("normalization failed");
			},
		});
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			return Response.json({ error: { type: "x" } }, { status });
		}) as never;

		const response = await callHandleProxy(
			new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "claude-sonnet-4-5",
					messages: [{ role: "user", content: "hi" }],
					max_tokens: 8,
				}),
				signal: client.signal,
			}),
			ctx,
		);

		expect(response.status).toBe(499);
		expect(calls).toBe(1);
		const [attempt] = await attemptsOf(ctx);
		expect(attempt).toMatchObject({
			status,
			error: `Upstream HTTP ${status}`,
		});
		expect(closedRows(ctx)).toHaveLength(1);
	});
});
