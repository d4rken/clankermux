import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { makeAccount as canonicalAccount } from "@clankermux/test-support";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";

/**
 * Claude Code's WebSearch helper sends one Messages request whose only tool is
 * `web_search_20250305`. Codex cannot run it, so the attempt has to move on to
 * an account that can, without the Codex backend ever seeing the request.
 */

async function callHandleProxy(req: Request, ctx: ProxyContext) {
	const { handleProxy } = await import("./fixtures/routing-harness");
	return handleProxy(req, new URL(req.url), ctx, null, null, false);
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

	it("skips the Codex account without calling it and serves from the next one", async () => {
		const codex = canonicalAccount({
			id: crypto.randomUUID(),
			name: "Codex",
			provider: "codex",
			api_key: null,
			refresh_token: "rt-codex",
			access_token: "at-codex",
			expires_at: Date.now() + 3_600_000,
			created_at: Date.now(),
		});
		const zai = canonicalAccount({
			id: crypto.randomUUID(),
			name: "Zai",
			provider: "zai",
			api_key: "zai-key",
			refresh_token: "",
			access_token: null,
			expires_at: null,
			created_at: Date.now(),
		});
		const ctx = makeContext([codex, zai]);
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				max_tokens: 16,
				messages: [{ role: "user", content: "Perform a web search" }],
				tools: [
					{ type: "web_search_20250305", name: "web_search", max_uses: 8 },
				],
			}),
		});

		const res = await callHandleProxy(req, ctx);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(ZAI_REPLY);
		expect(upstreamHosts).toEqual(["api.z.ai"]);
	});
});
