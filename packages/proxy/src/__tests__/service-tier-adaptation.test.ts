import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { makeAccount as canonicalAccount } from "@clankermux/test-support";
import {
	type Account,
	type NativeResponsesContext,
	SERVICE_TIER_ADAPTATION_HEADER,
	setNativeResponsesRequestContext,
} from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import { setForcedAccount } from "../handlers";
import { routingAttempts } from "./fixtures/routing-harness";

/**
 * An account's fast mode sets `service_tier: "priority"` on what it sends, and
 * the attempt row records it. Per attempt, because a failover from a fast-mode
 * account to one without it must send — and record — the next body unchanged.
 */

async function callHandleProxy(req: Request, url: URL, ctx: ProxyContext) {
	const { handleProxy } = await import("./fixtures/routing-harness");
	return handleProxy(req, url, ctx);
}

function makeCodexAccount(overrides: Partial<Account> = {}): Account {
	return canonicalAccount({
		id: "codex-1",
		name: "Codex",
		provider: "codex",
		// An API-key account: a 401 then fails straight over instead of taking
		// the stale-token refresh rung, which would need a live OAuth endpoint.
		api_key: "sk-codex",
		refresh_token: "",
		created_at: Date.now(),
		...overrides,
	});
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
			// Carries the client's headers through, so a missing scrub would show.
			prepareHeaders: (headers: Headers) => new Headers(headers),
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
	`data: ${JSON.stringify({ response: { id: "resp_1", model: "gpt-6-astra" } })}`,
	"",
	"event: response.output_text.delta",
	`data: ${JSON.stringify({ delta: "Hello" })}`,
	"",
	"event: response.completed",
	`data: ${JSON.stringify({
		response: {
			model: "gpt-6-astra",
			usage: { input_tokens: 1, output_tokens: 1 },
		},
	})}`,
	"",
	"",
].join("\n");

function isProxyCall(input: RequestInfo | URL): boolean {
	const url = input instanceof Request ? input.url : String(input);
	return (
		url.includes("chatgpt.com") ||
		url.includes("upstream.local") ||
		url.includes("/v1/messages")
	);
}

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

function makeNativeRequest(serviceTier?: string): Request {
	return makeRequest(
		{
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "translated" }],
			max_tokens: 16,
			stream: true,
		},
		{
			nativeBody: JSON.stringify({
				model: "gpt-6-astra",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "native" }],
					},
				],
				stream: true,
				...(serviceTier ? { service_tier: serviceTier } : {}),
			}),
		},
	);
}

function makeTranslatedRequest(): Request {
	return makeRequest({
		model: "gpt-6-astra",
		messages: [{ role: "user", content: "translated" }],
		max_tokens: 16,
		stream: true,
	});
}

function tierOf(bodyText: string | undefined): unknown {
	return (JSON.parse(bodyText ?? "{}") as { service_tier?: unknown })
		.service_tier;
}

describe("service-tier adaptation capture", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		setForcedAccount(null);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		setForcedAccount(null);
	});

	/** Every upstream call in order, answered by `respond`. */
	function captureUpstream(
		respond: (index: number) => Response = () =>
			new Response(rawCodexSse, { status: 200 }),
	): Array<{ body: string; headers: Headers }> {
		const calls: Array<{ body: string; headers: Headers }> = [];
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, _init?: RequestInit) => {
				if (!isProxyCall(input))
					return new Response("unavailable", { status: 500 });
				const request = input as Request;
				calls.push({
					body: await request.clone().text(),
					headers: new Headers(request.headers),
				});
				return respond(calls.length - 1);
			},
		) as never;
		return calls;
	}

	it("native passthrough: fast mode sends priority over the client's default and records both", async () => {
		const calls = captureUpstream();
		const ctx = makeContext([
			makeCodexAccount({ codex_fast_mode_enabled: true }),
		]);
		const req = makeNativeRequest("default");

		const res = await callHandleProxy(req, new URL(req.url), ctx);
		expect(res.status).toBe(200);

		expect(tierOf(calls[0]?.body)).toBe("priority");
		expect(routingAttempts(ctx)[0]).toMatchObject({
			service_tier_requested: "default",
			service_tier_sent: "priority",
			service_tier_reason: "account_fast_mode",
		});
		// The carrier never reaches the backend.
		expect(calls[0]?.headers.get(SERVICE_TIER_ADAPTATION_HEADER)).toBeNull();
	});

	it("translated path: fast mode sends priority with no client tier recorded", async () => {
		const calls = captureUpstream();
		const ctx = makeContext([
			makeCodexAccount({ codex_fast_mode_enabled: true }),
		]);
		const req = makeTranslatedRequest();

		const res = await callHandleProxy(req, new URL(req.url), ctx);
		expect(res.status).toBe(200);

		expect(tierOf(calls[0]?.body)).toBe("priority");
		expect(routingAttempts(ctx)[0]).toMatchObject({
			service_tier_requested: null,
			service_tier_sent: "priority",
			service_tier_reason: "account_fast_mode",
		});
	});

	it("a failover to an account without fast mode sends and records the client's own body", async () => {
		const fast = makeCodexAccount({
			id: "codex-fast",
			priority: 0,
			codex_fast_mode_enabled: true,
		});
		const plain = makeCodexAccount({ id: "codex-plain", priority: 1 });
		const calls = captureUpstream((index) =>
			index === 0
				? new Response(JSON.stringify({ error: "unauthorized" }), {
						status: 401,
						headers: { "content-type": "application/json" },
					})
				: new Response(rawCodexSse, { status: 200 }),
		);
		const ctx = makeContext([fast, plain]);
		const req = makeNativeRequest();

		const res = await callHandleProxy(req, new URL(req.url), ctx);
		expect(res.status).toBe(200);

		expect(calls).toHaveLength(2);
		expect(tierOf(calls[0]?.body)).toBe("priority");
		expect(tierOf(calls[1]?.body)).toBeUndefined();
		const attempts = routingAttempts(ctx);
		expect(attempts[0]).toMatchObject({
			account_id: "codex-fast",
			status: 401,
			service_tier_sent: "priority",
			service_tier_reason: "account_fast_mode",
		});
		expect(attempts[1]).toMatchObject({
			account_id: "codex-plain",
			service_tier_requested: null,
			service_tier_sent: null,
			service_tier_reason: null,
		});
	});

	it("the cache_control retry resends priority and records it again", async () => {
		const calls = captureUpstream((index) =>
			index === 0
				? Response.json(
						{
							error: {
								message: "cache_control: Extra inputs are not permitted",
							},
						},
						{ status: 400 },
					)
				: new Response(rawCodexSse, { status: 200 }),
		);
		// A unique id: the rejector memo is process-wide and keyed by account.
		const ctx = makeContext([
			makeCodexAccount({
				id: "codex-cache-control-rejector",
				codex_fast_mode_enabled: true,
			}),
		]);
		const req = makeTranslatedRequest();

		const res = await callHandleProxy(req, new URL(req.url), ctx);
		expect(res.status).toBe(200);

		expect(calls).toHaveLength(2);
		expect(tierOf(calls[0]?.body)).toBe("priority");
		expect(tierOf(calls[1]?.body)).toBe("priority");
		expect(routingAttempts(ctx).length).toBeGreaterThan(0);
		for (const attempt of routingAttempts(ctx))
			expect(attempt).toMatchObject({
				service_tier_sent: "priority",
				service_tier_reason: "account_fast_mode",
			});
	});

	// Forgery has to be tested against a provider that never writes the
	// carrier, or the provider's own overwrite would hide a missing scrub.
	const forged = btoa('{"requested":null,"sent":"priority","reason":"forged"}');

	function plainRequest(): Request {
		const req = makeRequest({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "plain" }],
			max_tokens: 16,
		});
		req.headers.set(SERVICE_TIER_ADAPTATION_HEADER, forged);
		return req;
	}

	function plainReply(): Response {
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
	}

	for (const forcedDispatch of [false, true]) {
		it(`ignores a client-supplied tier header${forcedDispatch ? " on a forced dispatch" : ""}`, async () => {
			const account = makeCodexAccount({
				id: "plain-1",
				provider: "test-provider",
			});
			const calls = captureUpstream(() => plainReply());
			const ctx = makeContext([account]);
			if (forcedDispatch) setForcedAccount(account.id);
			const req = plainRequest();

			const res = await callHandleProxy(req, new URL(req.url), ctx);
			expect(res.status).toBe(200);

			expect(routingAttempts(ctx)[0]).toMatchObject({
				service_tier_requested: null,
				service_tier_sent: null,
				service_tier_reason: null,
			});
			expect(calls[0]?.headers.get(SERVICE_TIER_ADAPTATION_HEADER)).toBeNull();
		});
	}
});
