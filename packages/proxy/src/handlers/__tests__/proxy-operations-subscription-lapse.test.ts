/**
 * Pausing an account when the REQUEST PATH confirms its subscription no longer
 * covers the service.
 *
 * Two things are under test and the second matters as much as the first: that
 * a confirmed lapse pauses without a cooldown, and that the refusals it sits
 * next to — a plain Codex rate limit, a Devin daily quota — do not.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { devinClient } from "@clankermux/providers";
import { makeAccount as canonicalAccount } from "@clankermux/test-support";
import type { Account, RequestMeta } from "@clankermux/types";
import { DevinRpcError } from "../../../../providers/src/providers/devin/connect";
import {
	proxyWithAccount,
	routingAttempts,
} from "../../__tests__/fixtures/routing-harness";
import { cacheBodyStore } from "../../cache-body-store";
import { clearProviderOverloadCooldown } from "../../provider-overload-cooldown";
import type { ProxyContext } from "../proxy-types";

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-lapse-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		project: "clankermux",
		projectAttributionSource: "wd_primary",
		requestedModel: "gpt-5.1-codex",
	} as RequestMeta;
}

function makeRequestBody(model: string) {
	return new TextEncoder().encode(
		JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
		}),
	).buffer;
}

function makeRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
	});
}

function makeProxyContext() {
	const pauseCalls: Array<{ id: string; reason: string }> = [];
	const cooldownCalls: Array<{ id: string; reason: string }> = [];
	const ctx = {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			pauseAccountIfActive: mock(async (id: string, reason: string) => {
				pauseCalls.push({ id, reason });
				return true;
			}),
			markAccountRateLimited: mock(
				async (id: string, _until: number, reason: string) => {
					cooldownCalls.push({ id, reason });
					return 1;
				},
			),
			markAccountRateLimitedDeadlineOnly: mock(
				async (id: string, _until: number, reason: string) => {
					cooldownCalls.push({ id, reason });
				},
			),
			saveRequest: mock(async () => {}),
			updateAccountUsage: mock(async () => {}),
			updateAccountRateLimitMeta: mock(async () => {}),
			getAdapter: mock(() => ({
				run: mock(async () => {}),
				get: mock(async () => null),
				runWithChanges: mock(async () => 1),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {
			name: "openai-compatible",
			canHandle: () => true,
			buildUrl: () => "https://chatgpt.com/backend-api/codex/responses",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: (response: Response) => ({
				isRateLimited: response.status === 429,
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
		config: { getStorePayloads: () => true } as never,
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
	} as unknown as ProxyContext;
	return { ctx, pauseCalls, cooldownCalls };
}

function codex429(code: string): Response {
	return new Response(
		JSON.stringify({
			error: {
				code,
				type: "usage_limit_reached",
				message: "Your ChatGPT plan does not include Codex.",
			},
		}),
		{ status: 429, headers: { "content-type": "application/json" } },
	);
}

const originalFetch = globalThis.fetch;

describe("proxyWithAccount — Codex subscription lapse", () => {
	beforeEach(() => {
		clearProviderOverloadCooldown();
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
		cacheBodyStore.discardStaged("req-lapse-1");
	});

	async function run(account: Account, response: () => Response) {
		globalThis.fetch = mock(async () => response()) as never;
		const { ctx, pauseCalls, cooldownCalls } = makeProxyContext();
		const body = makeRequestBody("gpt-5.1-codex");
		const result = await proxyWithAccount(
			makeRequest(body),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			body,
			() => undefined,
			0,
			ctx,
		);
		return { result, ctx, pauseCalls, cooldownCalls };
	}

	it("pauses on usage_not_included and fails over WITHOUT a cooldown", async () => {
		const account = canonicalAccount({
			id: "codex-lapsed",
			name: "codex-lapsed",
			provider: "codex",
			access_token: "at",
			refresh_token: "rt",
			expires_at: Date.now() + 3_600_000,
		});

		const { result, pauseCalls, cooldownCalls, ctx } = await run(account, () =>
			codex429("usage_not_included"),
		);

		expect(result).toBeNull();
		expect(pauseCalls).toEqual([
			{ id: "codex-lapsed", reason: "subscription_expired" },
		]);
		expect(account.paused).toBe(true);
		expect(account.pause_reason).toBe("subscription_expired");
		// A cooldown would schedule retries against an account that cannot serve
		// until a human renews.
		expect(cooldownCalls).toEqual([]);
		expect(account.rate_limited_until).toBeNull();
		expect(routingAttempts(ctx)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ provider: "codex", status: 429 }),
			]),
		);
	});

	it("leaves an ordinary Codex 429 to the rate-limit path", async () => {
		const account = canonicalAccount({
			id: "codex-limited",
			name: "codex-limited",
			provider: "codex",
			access_token: "at",
			refresh_token: "rt",
			expires_at: Date.now() + 3_600_000,
		});

		const { result, pauseCalls } = await run(account, () =>
			codex429("usage_limit_reached"),
		);

		expect(result).toBeNull();
		expect(pauseCalls).toEqual([]);
		expect(account.paused).toBe(false);
	});
});

describe("proxyWithAccount — Devin subscription lapse", () => {
	let lookup: ReturnType<typeof spyOn> | null = null;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		lookup?.mockRestore();
		lookup = null;
		cacheBodyStore.discardStaged("req-lapse-1");
	});

	async function run(message: string) {
		lookup = spyOn(devinClient, "getAccount").mockRejectedValue(
			new DevinRpcError("permission_denied", message),
		);
		globalThis.fetch = mock(async () => {
			throw new Error("must not send");
		}) as never;
		const { ctx, pauseCalls, cooldownCalls } = makeProxyContext();
		const account = canonicalAccount({
			id: "devin-lapsed",
			name: "devin-lapsed",
			provider: "devin",
			api_key: "session",
			// A Devin seat is an api-key account: API_KEY_PROVIDERS.devin sets
			// mirrorKeyToTokens: false and no write path stores a refresh token.
			// With one present, getValidAccessToken would try a refresh that
			// DevinProvider rejects by design, and the request would die before
			// the seat lookup under test ever runs.
			refresh_token: "",
			custom_endpoint: null,
		});
		const body = makeRequestBody("swe-2-high");
		const result = await proxyWithAccount(
			makeRequest(body),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			body,
			() => undefined,
			0,
			ctx,
		);
		return { result, account, pauseCalls, cooldownCalls };
	}

	it("pauses a lapsed seat and fails over", async () => {
		const { result, account, pauseCalls, cooldownCalls } = await run(
			"free user account exceeded, please use an existing account or upgrade to a paid plan",
		);

		expect(result).toBeNull();
		expect(pauseCalls).toEqual([
			{ id: "devin-lapsed", reason: "subscription_expired" },
		]);
		expect(account.paused).toBe(true);
		expect(cooldownCalls).toEqual([]);
	});

	it("pauses a seat the team disabled", async () => {
		const { pauseCalls } = await run("user is disabled by team");

		expect(pauseCalls).toEqual([
			{ id: "devin-lapsed", reason: "subscription_expired" },
		]);
	});

	it("never pauses on daily quota exhaustion", async () => {
		const { account, pauseCalls } = await run(
			"failed_precondition: Your daily usage quota has been exhausted",
		);

		expect(pauseCalls).toEqual([]);
		expect(account.paused).toBe(false);
	});
});
