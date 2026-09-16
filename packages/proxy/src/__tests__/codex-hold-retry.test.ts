import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { makeAccount as canonicalAccount } from "@clankermux/test-support";
import {
	type Account,
	type NativeResponsesContext,
	setNativeResponsesRequestContext,
} from "@clankermux/types";
import {
	getCodexTransientFailureUntil,
	resetCodexTransientHealthForTests,
} from "../codex-transient-health";
import {
	setCodexTransientHoldOverrideForTests,
	setCodexTransientHoldTotalBudgetOverrideForTests,
} from "../codex-transient-hold";
import type { ProxyContext } from "../handlers";

/**
 * A Codex account that fails in-band before generating content usually recovers
 * within seconds, so the request holds and retries the SAME account once before
 * handing the work to a sibling. These tests pin the resulting call order, the
 * per-request hold budget that bounds it, and the two ways the hold is skipped:
 * a client that disconnected while we waited, and an attempt that already spent
 * its retry before a 401 sent it round again.
 */

async function callHandleProxy(req: Request, ctx: ProxyContext) {
	const { handleProxy } = await import("./fixtures/routing-harness");
	return handleProxy(req, new URL(req.url), ctx, null, null, false);
}

function makeCodexAccount(overrides: Partial<Account> = {}): Account {
	return canonicalAccount({
		name: "Codex",
		provider: "codex",
		api_key: null,
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
			updateAccountTokens: mock(async () => true),
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
function makeRequest(signal?: AbortSignal): Request {
	const req = new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "translated marker hello" }],
			max_tokens: 16,
			stream: true,
		}),
		...(signal ? { signal } : {}),
	});
	setNativeResponsesRequestContext(req, makeNativeContext());
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

/** The failure as the very first event — the shape the rung discards. */
const errorFirstSse =
	"event: error\n" +
	'data: {"type":"error","error":{"type":"server_error","code":"server_error","message":"capacity"}}\n\n';

const AUTH_ERROR_BODY =
	'{"type":"error","error":{"type":"authentication_error","message":"invalid bearer token"}}';

const CODEX_TOKEN_URL = "auth.openai.com/oauth/token";

/**
 * Deliberately NO content-type header: the real Codex backend frequently omits
 * it on SSE, and the provider's native fix-up is what supplies it.
 */
function codexResponse(body: string): Response {
	return new Response(body, { status: 200 });
}

type UpstreamStep = string | { status: number; body: string };

/**
 * Mocked upstream keyed by Authorization header: each bearer consumes its own
 * `steps` in order and serves `healthySse` once they run out. `refreshedToken`
 * is what the mocked Codex OAuth exchange installs; neither the token endpoint
 * nor the pricing catalogue is recorded in `calls`, which holds upstream
 * attempts only. The catalogue is fetched lazily once per process, so a test
 * that recorded it would fail or pass depending on which one ran first.
 */
function installFetch(
	steps: Record<string, UpstreamStep[]>,
	calls: string[],
	refreshedToken?: string,
): void {
	const consumed = new Map<string, number>();
	globalThis.fetch = mock(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request =
				input instanceof Request ? input : new Request(String(input), init);
			if (request.url.includes("models.dev")) {
				return new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (request.url.includes(CODEX_TOKEN_URL)) {
				return new Response(
					JSON.stringify({
						access_token: refreshedToken ?? "refreshed",
						refresh_token: "rt-codex-new",
						expires_in: 3600,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			const auth = request.headers.get("authorization") ?? "";
			calls.push(auth);
			const index = consumed.get(auth) ?? 0;
			consumed.set(auth, index + 1);
			const step = steps[auth]?.[index] ?? healthySse;
			if (typeof step === "string") return codexResponse(step);
			return new Response(step.body, {
				status: step.status,
				headers: { "content-type": "application/json" },
			});
		},
	) as never;
}

function makePair(): { first: Account; second: Account } {
	return {
		first: makeCodexAccount({ id: crypto.randomUUID(), access_token: "first" }),
		second: makeCodexAccount({
			id: crypto.randomUUID(),
			access_token: "second",
		}),
	};
}

describe("Codex in-band failure: hold and retry the same account", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		resetCodexTransientHealthForTests();
		// The real hold is 30s; every test below would otherwise outrun bun's
		// default per-test timeout.
		setCodexTransientHoldOverrideForTests(5);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		resetCodexTransientHealthForTests();
		setCodexTransientHoldOverrideForTests(null);
		setCodexTransientHoldTotalBudgetOverrideForTests(null);
	});

	it("retries the same account after the hold and serves its own stream", async () => {
		const { first, second } = makePair();
		const ctx = makeContext([first, second]);
		const calls: string[] = [];
		installFetch({ "Bearer first": [errorFirstSse] }, calls);

		const res = await callHandleProxy(makeRequest(), ctx);
		const body = await res.text();

		// The sibling is never touched: the account that failed answers its own
		// request one hold later.
		expect(calls).toEqual(["Bearer first", "Bearer first"]);
		expect(body).toBe(healthySse);
	});

	it("leaves no routing demotion behind when the retry succeeds", async () => {
		const { first, second } = makePair();
		const ctx = makeContext([first, second]);
		const calls: string[] = [];
		installFetch({ "Bearer first": [errorFirstSse] }, calls);

		await (await callHandleProxy(makeRequest(), ctx)).text();

		// An account that recovered on its own retry must not be demoted for the
		// next request — the memo is only written on the paths that give up.
		expect(getCodexTransientFailureUntil(first.id)).toBeNull();
	});

	it("falls over to the sibling when the held retry fails too", async () => {
		const { first, second } = makePair();
		const ctx = makeContext([first, second]);
		const calls: string[] = [];
		installFetch({ "Bearer first": [errorFirstSse, errorFirstSse] }, calls);

		const res = await callHandleProxy(makeRequest(), ctx);
		const body = await res.text();

		expect(calls).toEqual(["Bearer first", "Bearer first", "Bearer second"]);
		expect(body).toBe(healthySse);
		expect(getCodexTransientFailureUntil(first.id)).not.toBeNull();
	});

	it("forwards the failure once every account has spent its retry", async () => {
		const { first, second } = makePair();
		const ctx = makeContext([first, second]);
		const calls: string[] = [];
		installFetch(
			{
				"Bearer first": [errorFirstSse, errorFirstSse],
				"Bearer second": [errorFirstSse, errorFirstSse],
			},
			calls,
		);

		const res = await callHandleProxy(makeRequest(), ctx);

		expect(calls).toEqual([
			"Bearer first",
			"Bearer first",
			"Bearer second",
			"Bearer second",
		]);
		// The upstream stream, unchanged — exactly what a pool with nothing left
		// forwards today.
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(errorFirstSse);
	});

	it("stops holding when the request budget is spent", async () => {
		setCodexTransientHoldOverrideForTests(2);
		setCodexTransientHoldTotalBudgetOverrideForTests(3);
		const { first, second } = makePair();
		const ctx = makeContext([first, second]);
		const calls: string[] = [];
		installFetch(
			{
				"Bearer first": [errorFirstSse, errorFirstSse],
				"Bearer second": [errorFirstSse, errorFirstSse],
			},
			calls,
		);

		const res = await callHandleProxy(makeRequest(), ctx);
		await res.text();

		// The budget covers one hold, so the second account fails over/forwards
		// without one.
		expect(calls).toEqual(["Bearer first", "Bearer first", "Bearer second"]);
	});

	it("does not retry when the client disconnects during the hold", async () => {
		// Long enough that the abort scheduled below lands inside the wait.
		setCodexTransientHoldOverrideForTests(600);
		const { first, second } = makePair();
		const ctx = makeContext([first, second]);
		const calls: string[] = [];
		const controller = new AbortController();
		installFetch({ "Bearer first": [errorFirstSse] }, calls);
		setTimeout(() => controller.abort(), 150);

		const res = await callHandleProxy(makeRequest(controller.signal), ctx);
		await res.text().catch(() => {});

		// Neither a retry of the failed account nor a fan-out to the sibling: the
		// client is gone.
		expect(calls).toEqual(["Bearer first"]);
	});

	it("spends the retry only once when a 401 sends the attempt round again", async () => {
		const { first, second } = makePair();
		const ctx = makeContext([first, second]);
		const calls: string[] = [];
		installFetch(
			{
				// Hold + retry, then a stale token: the refresh recursion must carry
				// the spent retry with it.
				"Bearer first": [errorFirstSse, { status: 401, body: AUTH_ERROR_BODY }],
				"Bearer first-refreshed": [errorFirstSse],
			},
			calls,
			"first-refreshed",
		);

		const res = await callHandleProxy(makeRequest(), ctx);
		const body = await res.text();

		expect(calls).toEqual([
			"Bearer first",
			"Bearer first",
			"Bearer first-refreshed",
			"Bearer second",
		]);
		expect(body).toBe(healthySse);
	});
});
