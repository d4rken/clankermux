import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { makeAccount as canonicalAccount } from "@clankermux/test-support";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";

/**
 * A Messages request carrying an Anthropic-defined tool, here
 *
 *   tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }]
 *
 * never reaches Codex: another account serves it, or the client gets a 400
 * naming the tool when Codex was all that was left.
 */

async function callHandleProxy(req: Request, ctx: ProxyContext) {
	const { handleProxy } = await import("./fixtures/routing-harness");
	return handleProxy(req, new URL(req.url), ctx, null, null, false);
}

async function attemptedProviders(ctx: ProxyContext) {
	const { routingAttempts } = await import("./fixtures/routing-harness");
	return routingAttempts(ctx).map((row) => row.provider);
}

function makeContext(accounts: Account[]): ProxyContext {
	const byId = new Map(accounts.map((a) => [a.id, a]));
	return {
		strategy: {
			select: (accs: Account[]) => accs.filter((acc) => !acc.paused),
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

const ZAI_REPLY = {
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: "claude-sonnet-4-5",
	content: [{ type: "text", text: "searched" }],
	stop_reason: "end_turn",
	usage: { input_tokens: 1, output_tokens: 1 },
};

describe("Codex and Anthropic server tools", () => {
	let originalFetch: typeof globalThis.fetch;
	let upstreamHosts: string[];

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		upstreamHosts = [];
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const request =
					input instanceof Request ? input : new Request(String(input), init);
				if (request.url.includes("models.dev"))
					return new Response("{}", {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				upstreamHosts.push(new URL(request.url).host);
				return new Response(JSON.stringify(ZAI_REPLY), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		) as never;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("serves from another account without attempting Codex", async () => {
		const ctx = makeContext([codexAccount(), zaiAccount()]);

		const res = await callHandleProxy(messagesRequest(), ctx);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(ZAI_REPLY);
		expect(upstreamHosts).toEqual(["api.z.ai"]);
		expect(await attemptedProviders(ctx)).toEqual(["zai"]);
	});

	it("answers 400 naming the tool when Codex is the only candidate", async () => {
		const ctx = makeContext([codexAccount()]);

		const res = await callHandleProxy(messagesRequest(), ctx);

		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { type: string; param?: string; message: string };
		};
		expect(body.error.type).toBe("invalid_request_error");
		expect(body.error.param).toBe("tools");
		expect(body.error.message).toContain('"web_search_20250305"');
		expect(upstreamHosts).toEqual([]);
	});

	it("still counts tokens on Codex, which answers them locally", async () => {
		const ctx = makeContext([codexAccount()]);

		const res = await callHandleProxy(
			messagesRequest("/v1/messages/count_tokens"),
			ctx,
		);

		expect(res.status).toBe(200);
		expect(upstreamHosts).toEqual([]);
	});
});

const WEB_SEARCH_BODY = {
	model: "claude-sonnet-4-5",
	max_tokens: 16,
	messages: [{ role: "user", content: "Perform a web search" }],
	tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
};

function messagesRequest(path = "/v1/messages"): Request {
	return new Request(`https://proxy.local${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(WEB_SEARCH_BODY),
	});
}

function codexAccount(): Account {
	return canonicalAccount({
		id: crypto.randomUUID(),
		name: "Codex",
		provider: "codex",
		api_key: null,
		refresh_token: "rt-codex",
		access_token: "at-codex",
		expires_at: Date.now() + 3_600_000,
		created_at: Date.now(),
	});
}

function zaiAccount(): Account {
	return canonicalAccount({
		id: crypto.randomUUID(),
		name: "Zai",
		provider: "zai",
		api_key: "zai-key",
		refresh_token: "",
		access_token: null,
		expires_at: null,
		created_at: Date.now(),
	});
}
