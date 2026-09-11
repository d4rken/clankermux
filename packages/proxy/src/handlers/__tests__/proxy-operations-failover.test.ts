import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import {
	DevinSessionAuthenticationError,
	devinClient,
} from "@clankermux/providers";
import type { Account, RequestMeta } from "@clankermux/types";
import { encodeConnect } from "../../../../providers/src/providers/devin/connect";
import { GetChatMessageResponseSchema } from "../../../../providers/src/providers/devin/vendor/devin-proto";
import {
	create,
	toBinary,
} from "../../../../providers/src/providers/devin/vendor/protobuf";
import { devinInfo, devinReply } from "../../__tests__/devin-fixtures";
import type { ProxyAttemptOutcome } from "../../__tests__/fixtures/routing-harness";
import {
	isCodexEntitlementModelError,
	isModelUnavailableError,
	proxyWithAccount,
	routingAttempts,
} from "../../__tests__/fixtures/routing-harness";
import { cacheBodyStore } from "../../cache-body-store";
import {
	clearProviderOverloadCooldown,
	isProviderOverloaded,
} from "../../provider-overload-cooldown";
import {
	isAccountWideFailure,
	isOrdinaryAttemptFailure,
} from "../../recovery-holds";
import type { ProxyContext } from "../proxy-types";

describe("Zai 1305 recovery through the account/model loop", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
		cacheBodyStore.discardStaged("req-1");
	});
	const overloaded = () =>
		new Response('data: {"error":{"code":1305}}\n\n', {
			headers: { "content-type": "text/event-stream" },
		});
	const success = () =>
		Response.json({
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			usage: { input_tokens: 1, output_tokens: 1 },
		});
	async function run(
		account: Account,
		ctx: ProxyContext,
		terminal = false,
		body = makeRequestBody(),
		onOutcome?: (outcome: ProxyAttemptOutcome) => void,
	) {
		return proxyWithAccount(
			makeRequest(body),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			body,
			() => undefined,
			0,
			ctx,
			undefined,
			undefined,
			undefined,
			undefined,
			terminal,
			{ onOutcome },
		);
	}
	const account = (fallbacks = false) =>
		makeAccount({
			provider: "zai",
			custom_endpoint: null,
			model_mappings: JSON.stringify({
				sonnet: fallbacks ? ["glm-primary", "glm-fallback"] : "glm-primary",
			}),
		});
	it("fails over after one retry without mutating quota cooldowns", async () => {
		const fetcher = mock(async () => overloaded());
		globalThis.fetch = fetcher as unknown as typeof fetch;
		const ctx = makeProxyContext();
		const acc = account();
		expect(await run(acc, ctx)).toBeNull();
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
		expect(acc.rate_limited_until).toBeNull();
	});
	it("does not seed an Anthropic recovery hold or exclude other models on the account", async () => {
		globalThis.fetch = (async () => overloaded()) as typeof fetch;
		const outcomes: ProxyAttemptOutcome[] = [];
		await run(
			account(),
			makeProxyContext(),
			false,
			makeRequestBody(),
			(outcome) => outcomes.push(outcome),
		);
		expect(outcomes).toHaveLength(1);
		expect(isOrdinaryAttemptFailure(outcomes[0])).toBe(true);
		expect(isAccountWideFailure(outcomes[0])).toBe(false);
	});
	it("returns an overload terminal rather than successful SSE when all accounts are exhausted", async () => {
		globalThis.fetch = (async () => overloaded()) as typeof fetch;
		const ctx = makeProxyContext();
		const response = await run(account(), ctx, true);
		expect(response?.status).toBe(529);
		if (!response) throw new Error("missing overload response");
		expect((await response.json()).error.code).toBe(1305);
		expect(ctx.requestRecorder.begin).toHaveBeenCalled();
		expect(ctx.requestRecorder.finishTransport).toHaveBeenCalled();
		expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
	});

	it("retries overload on the same target and never cycles retired model arrays", async () => {
		const models: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const body = await (input as Request).json();
			models.push(body.model);
			return models.length <= 2 ? overloaded() : success();
		}) as typeof fetch;
		const response = await run(account(true), makeProxyContext());
		expect(response).toBeNull();
		await response?.text();
		expect(models).toHaveLength(2);
		expect(models[0]).toBe(models[1]);
		expect(models).not.toContain("glm-fallback");
	});
	it("bounds overload retries without cycling targets or writing a quota lock", async () => {
		const fetcher = mock(async () => overloaded());
		globalThis.fetch = fetcher as unknown as typeof fetch;
		const ctx = makeProxyContext();
		expect(await run(account(true), ctx)).toBeNull();
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
	});
	it("keeps the cache-control-stripped body for overload retries", async () => {
		const bodies: unknown[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			bodies.push(await (input as Request).json());
			if (bodies.length === 1)
				return Response.json(
					{ error: { message: "unknown field cache_control" } },
					{ status: 400 },
				);
			return bodies.length === 2 ? overloaded() : success();
		}) as typeof fetch;
		const ctx = makeProxyContext();
		const body = new TextEncoder().encode(
			JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: "hi",
								cache_control: { type: "ephemeral" },
							},
						],
					},
				],
				max_tokens: 10,
			}),
		).buffer;
		const response = await run(account(), ctx, false, body);
		expect(response?.status).toBe(200);
		await response?.text();
		expect(bodies).toHaveLength(3);
		expect(JSON.stringify(bodies[0])).toContain("cache_control");
		expect(JSON.stringify(bodies[1])).not.toContain("cache_control");
		expect(bodies[2]).toEqual(bodies[1]);
	});
});

// Minimal Account fixture for openai-compatible provider
function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "kilo-test",
		provider: "openai-compatible",
		api_key: "test-key",
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
		custom_endpoint: "https://openrouter.ai/api/v1",
		model_mappings: JSON.stringify({ sonnet: "qwen/qwen3.6-plus:free" }),
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeRequestBody(model = "claude-sonnet-4-5") {
	const body = JSON.stringify({
		model,
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 10,
	});
	return new TextEncoder().encode(body).buffer;
}

function makeProxyContext(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(
				(_accountId: string, _until: number, _reason: string) =>
					Promise.resolve(),
			),
			markAccountRateLimitedDeadlineOnly: mock(
				(_accountId: string, _until: number, _reason: string) =>
					Promise.resolve(),
			),
			saveRequest: mock((..._args: unknown[]) => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			updateAccountRateLimitMeta: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {
			name: "openai-compatible",
			canHandle: () => true,
			buildUrl: (_path: string, _search: string) =>
				"https://openrouter.ai/api/v1/messages",
			prepareHeaders: (_headers: Headers) => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: "allowed",
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
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
	};
}

function makeRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
	});
}

function jsonResponse(body: object, status: number) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("proxyWithAccount — 429 failover", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
	});

	it("returns null (failover) when upstream returns 429 and no fallback is configured", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message:
							"Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc123",
					},
				},
				429,
			),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(), // no model_fallbacks
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(result).toBeNull();
	});

	it("returns null (failover) when both primary and fallback model return 429", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				model_fallbacks: JSON.stringify({
					sonnet: "bytedance-seed/dola-seed-2.0-pro:free",
				}),
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(result).toBeNull();
	});

	it("returns null when all models in the array are exhausted", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				model_mappings: JSON.stringify({
					sonnet: [
						"qwen/qwen3.6-plus:free",
						"bytedance-seed/dola-seed-2.0-pro:free",
					],
				}),
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(result).toBeNull();
	});
});

function makeProxyContextWithAsyncExec(): ProxyContext {
	const ctx = makeProxyContext();
	return {
		...ctx,
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
	};
}

describe("proxyWithAccount — rate limit audit trail (issue #178)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("calls markAccountRateLimited with reason='model_fallback_429' on no-fallback 429", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message:
							"Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(), // no model_fallbacks
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// The asyncWriter.enqueue mock captures calls; the cooldown setter is
		// called inside the enqueued job. Since asyncWriter.enqueue is mocked
		// (does not execute the job), we verify via the setter mocks directly.
		// Lever B: a 429 carrying a server-directed reset routes through the
		// non-incrementing deadline-only setter; a no-reset 429 routes through the
		// incrementing one. Either way the `reason` arg must be plumbed through.
		const calls = [
			...(ctx.dbOps.markAccountRateLimited as ReturnType<typeof mock>).mock
				.calls,
			...(
				ctx.dbOps.markAccountRateLimitedDeadlineOnly as ReturnType<typeof mock>
			).mock.calls,
		];
		expect(calls.length).toBeGreaterThan(0);
		const reasons = calls.map((args: unknown[]) => args[2] as string);
		expect(reasons).toContain("model_fallback_429");
	});

	it("calls markAccountRateLimited with reason='model_fallback_429' when the resolved target fails despite a legacy fallback array", async () => {
		// All fetch calls return 429 — primary + every fallback model
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				model_mappings: JSON.stringify({
					sonnet: [
						"qwen/qwen3.6-plus:free",
						"bytedance-seed/dola-seed-2.0-pro:free",
					],
				}),
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// At least one cooldown call should carry the model_fallback_429
		// reason. Lever B may route a reset-bearing 429 through the deadline-only
		// setter, so check both setters' calls.
		const calls = [
			...(ctx.dbOps.markAccountRateLimited as ReturnType<typeof mock>).mock
				.calls,
			...(
				ctx.dbOps.markAccountRateLimitedDeadlineOnly as ReturnType<typeof mock>
			).mock.calls,
		];
		const reasons = calls.map((args: unknown[]) => args[2] as string);
		expect(reasons).toContain("model_fallback_429");
	});
});

describe("proxyWithAccount — in-memory cooldown mutation (issue #178 fix)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sets account.rate_limited_until on model_fallback_429 path", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message:
							"Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount();
		const before = Date.now();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// In-memory mutation should be set immediately (before DB write completes)
		expect(account.rate_limited_until).not.toBeNull();
		expect(account.rate_limited_until ?? 0).toBeGreaterThan(before);
		// Adaptive backoff: first 429 in a streak = RATE_LIMIT_BACKOFF_BASE_MS (30s by default)
		expect(account.rate_limited_until ?? 0).toBeGreaterThanOrEqual(
			before + 30_000,
		);
	});

	it("sets account.rate_limited_until on all_models_exhausted_429 path", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount({
			model_mappings: JSON.stringify({
				sonnet: [
					"qwen/qwen3.6-plus:free",
					"bytedance-seed/dola-seed-2.0-pro:free",
				],
			}),
		});
		const before = Date.now();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(account.rate_limited_until).not.toBeNull();
		expect(account.rate_limited_until ?? 0).toBeGreaterThan(before);
		// Adaptive backoff: first 429 in a streak = RATE_LIMIT_BACKOFF_BASE_MS (30s by default)
		expect(account.rate_limited_until ?? 0).toBeGreaterThanOrEqual(
			before + 30_000,
		);
	});
});

describe("getModelList — model_fallbacks merge", () => {});

describe("proxyWithAccount — 529 failover", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
	});

	it("returns null (failover) when upstream returns 529 and provider parseRateLimit says isRateLimited:true", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(
					'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
					{
						status: 529,
						headers: { "content-type": "application/json" },
					},
				),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		// Override the proxy context to have a provider that treats 529 as rate-limited
		// (matching the Anthropic provider's parseRateLimit behaviour for 529).
		const ctx = makeProxyContext();
		(ctx as { provider: typeof ctx.provider }).provider = {
			...ctx.provider,
			parseRateLimit: (r: Response) => ({
				isRateLimited: r.status === 529 || r.status === 429,
				resetTime: r.status === 529 ? Date.now() + 60_000 : undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
		} as typeof ctx.provider;

		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				provider: "anthropic",
				api_key: "test-key",
				access_token: null,
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
	});

	it("marks provider overloaded without marking the individual account rate-limited", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(
					'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
					{
						status: 529,
						headers: {
							"content-type": "application/json",
							"retry-after": "45",
						},
					},
				),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount({
			provider: "anthropic",
			api_key: "test-key",
			access_token: null,
		});

		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		expect(isProviderOverloaded("anthropic")).toBe(true);
		expect(account.rate_limited_until).toBeNull();
		expect(account.consecutive_rate_limits).toBe(0);
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock
		>;
		expect(markMock.mock.calls).toHaveLength(0);
	});

	it("shares the official Anthropic overload group with Claude console API accounts", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(
					'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
					{
						status: 529,
						headers: {
							"content-type": "application/json",
							"retry-after": "45",
						},
					},
				),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const ctx = makeProxyContextWithAsyncExec();
		(ctx as { provider: typeof ctx.provider }).provider = {
			...ctx.provider,
			name: "anthropic",
			parseRateLimit: (r: Response) => ({
				isRateLimited: r.status === 529 || r.status === 429,
				resetTime: r.status === 529 ? Date.now() + 45_000 : undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
		} as typeof ctx.provider;
		const account = makeAccount({
			provider: "claude-console-api",
			api_key: "test-key",
			access_token: null,
		});

		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		expect(isProviderOverloaded("anthropic")).toBe(true);
		expect(isProviderOverloaded("claude-console-api")).toBe(true);
		expect(account.rate_limited_until).toBeNull();
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock
		>;
		expect(markMock.mock.calls).toHaveLength(0);
	});

	it("returns upstream 529 on the final account attempt instead of pool exhaustion", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(
					'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
					{
						status: 529,
						headers: { "content-type": "application/json" },
					},
				),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const ctx = makeProxyContext();
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				provider: "anthropic",
				api_key: "test-key",
				access_token: null,
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
			undefined,
			undefined,
			undefined,
			undefined,
			true,
		);

		expect(result).not.toBeNull();
		if (!result) throw new Error("Expected final 529 response");
		expect(result.status).toBe(529);
		const body = (await result.json()) as {
			error: { type: string; message: string };
		};
		expect(body.error.type).toBe("overloaded_error");
		expect(body.error.message).toBe("Overloaded");
	});

	it("isModelUnavailableError returns false for 529 overloaded responses", async () => {
		const response = new Response(
			'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
			{ status: 529, headers: { "content-type": "application/json" } },
		);
		expect(await isModelUnavailableError(response)).toBe(false);
	});

	it("both predicates match the ChatGPT-account entitlement 400", async () => {
		const body = JSON.stringify({
			detail:
				"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
		});
		expect(
			await isModelUnavailableError(
				new Response(body, {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
			),
		).toBe(true);
		expect(
			await isCodexEntitlementModelError(
				new Response(body, {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
			),
		).toBe(true);
	});

	it("neither predicate matches an unrelated top-level detail", async () => {
		const body = JSON.stringify({ detail: "Not authenticated" });
		expect(
			await isModelUnavailableError(
				new Response(body, {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
			),
		).toBe(false);
		expect(
			await isCodexEntitlementModelError(
				new Response(body, {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
			),
		).toBe(false);
	});

	// Pins the tier split: the broad predicate takes any "model … not supported"
	// detail, the entitlement predicate only the account-scoped Codex/ChatGPT one.
	it("a non-entitlement unsupported-model detail is broad-only", async () => {
		const body = JSON.stringify({
			detail: "The model input field is not supported by this endpoint",
		});
		expect(
			await isModelUnavailableError(
				new Response(body, {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
			),
		).toBe(true);
		expect(
			await isCodexEntitlementModelError(
				new Response(body, {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
			),
		).toBe(false);
	});
});

describe("proxyWithAccount — 401 failover", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns null (failover) when upstream returns 401", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{ error: { type: "authentication_error", message: "Invalid API key" } },
				401,
			),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(result).toBeNull();
	});

	it("does not failover on successful 200 response", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					model: "qwen/qwen3.6-plus:free",
					stop_reason: "end_turn",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
				200,
			),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(result).not.toBeNull();
		expect(result?.status).toBe(200);
	});
});

describe("proxyWithAccount — staged-body cleanup on direct model-not-found return (B4)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		cacheBodyStore.setEnabled(true);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		cacheBodyStore.setEnabled(false);
		mock.restore();
	});

	// A cacheable body: /v1/messages + a cache_control hint so stageRequest stages it.
	function _makeCacheableBody() {
		const body = JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			system: [
				{ type: "text", text: "sys", cache_control: { type: "ephemeral" } },
			],
			max_tokens: 10,
		});
		return new TextEncoder().encode(body).buffer;
	}
});

describe("proxyWithAccount — Codex entitlement model error fails over", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
	});

	// A codex account with a SCALAR model mapping: modelList.length <= 1, so a
	// model-unavailable 400 reaches the no-fallback branch.
	function makeCodexAccount(overrides: Partial<Account> = {}): Account {
		return makeAccount({
			id: "acc-codex",
			name: "codex-test",
			provider: "codex",
			api_key: null,
			refresh_token: "rt-token",
			access_token: "at-token",
			expires_at: Date.now() + 3_600_000,
			custom_endpoint: null,
			model_mappings: JSON.stringify({ sonnet: "gpt-5.3-codex" }),
			...overrides,
		});
	}

	it("returns null (failover) when the plan does not entitle the account to the model", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					detail:
						"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
				},
				400,
			),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeCodexAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		// Account-scoped error: another account on a different plan can serve the
		// same model, so this fails over instead of forwarding the 400.
		expect(result).toBeNull();
	});

	it("fails over on a generic model-not-found 400", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{ error: { code: "model_not_found", message: "model does not exist" } },
				400,
			),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeCodexAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(result).toBeNull();
	});
});

describe("Anthropic organization access denial", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
		cacheBodyStore.discardStaged("req-1");
	});
	const body = {
		error: {
			type: "permission_error",
			details: { error_code: "oauth_not_allowed_for_organization" },
		},
	};
	it("benches, audits and fails over without model retries or recovery holds", async () => {
		globalThis.fetch = mock(async () =>
			Response.json(body, { status: 403 }),
		) as never;
		const acc = makeAccount({
			provider: "anthropic",
			custom_endpoint: null,
			model_mappings: null,
			model_fallbacks: JSON.stringify({
				"claude-sonnet-4-5": "claude-haiku-4-5",
			}),
		});
		const ctx = makeProxyContextWithAsyncExec();
		const outcomes: ProxyAttemptOutcome[] = [];
		const reqBody = makeRequestBody();
		const res = await proxyWithAccount(
			makeRequest(reqBody),
			new URL("https://proxy.local/v1/messages"),
			acc,
			makeRequestMeta(),
			reqBody,
			() => {},
			0,
			ctx,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			{ onOutcome: (o) => outcomes.push(o) },
		);
		expect(res).toBeNull();
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(acc.rate_limited_reason).toBe("org_permission_denied");
		expect(acc.rate_limited_until).toBeGreaterThan(Date.now());
		expect(routingAttempts(ctx)).toContainEqual(
			expect.objectContaining({
				status: 403,
				error: "org_permission_denied",
				account_id: acc.id,
			}),
		);
		expect(outcomes).toEqual([{ kind: "org_permission_denied" }]);
		expect(isAccountWideFailure(outcomes[0])).toBe(true);
	});
	it("passes through the same body from an unmaintained compatible provider", async () => {
		globalThis.fetch = mock(async () =>
			Response.json(body, { status: 403 }),
		) as never;
		const acc = makeAccount();
		const ctx = makeProxyContext();
		const reqBody = makeRequestBody();
		const res = await proxyWithAccount(
			makeRequest(reqBody),
			new URL("https://proxy.local/v1/messages"),
			acc,
			makeRequestMeta(),
			reqBody,
			() => {},
			0,
			ctx,
		);
		expect(res?.status).toBe(403);
		expect(acc.rate_limited_until).toBeNull();
		await res?.text();
	});
});

describe("Devin binary proxy integration", () => {
	it("uses the actual daily reset for a synthetic quota rejection without network traffic", async () => {
		const original = globalThis.fetch;
		const info = devinInfo();
		const reset = Date.now() + 6 * 60 * 60 * 1000;
		info.usage.daily = { utilization: 100, resetAt: reset };
		const auth = spyOn(devinClient, "getAccount").mockResolvedValue(info);
		globalThis.fetch = mock(async () => {
			throw new Error("must not send");
		}) as never;
		try {
			const body = makeRequestBody("swe-2-high");
			const account = makeAccount({
				provider: "devin",
				custom_endpoint: null,
				auto_pause_on_overage_enabled: true,
			});
			const result = await proxyWithAccount(
				makeRequest(body),
				new URL("https://proxy.local/v1/messages"),
				account,
				makeRequestMeta(),
				body,
				() => {},
				0,
				makeProxyContext(),
			);
			expect(result).toBeNull();
			expect(globalThis.fetch).not.toHaveBeenCalled();
			expect(Math.abs((account.rate_limited_until ?? 0) - reset)).toBeLessThan(
				2000,
			);
		} finally {
			globalThis.fetch = original;
			auth.mockRestore();
		}
	});
	it("classifies HTTP-200 Connect quota errors before deciding failover", async () => {
		const original = globalThis.fetch;
		const auth = spyOn(devinClient, "getAccount").mockResolvedValue(
			devinInfo(),
		);
		const calls: Request[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			calls.push(input as Request);
			return devinReply(true);
		}) as typeof fetch;
		try {
			const body = makeRequestBody("swe-2-high");
			const ctx = makeProxyContext();
			const account = makeAccount({
				provider: "devin",
				custom_endpoint: null,
			});
			const result = await proxyWithAccount(
				makeRequest(body),
				new URL("https://proxy.local/v1/messages"),
				account,
				makeRequestMeta(),
				body,
				() => {},
				0,
				ctx,
			);
			expect(result).toBeNull();
			expect(calls).toHaveLength(1);
			expect(calls[0]?.headers.get("content-type")).toBe(
				"application/connect+proto",
			);
			expect(
				[...(calls[0]?.headers.keys() ?? [])].some((k) =>
					k.startsWith("x-clankermux-"),
				),
			).toBe(false);
			expect(account.rate_limited_until).toBeGreaterThan(Date.now());
			expect(routingAttempts(ctx)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						provider: "devin",
						status: 429,
						error: expect.any(String),
						reported_model: null,
					}),
				]),
			);
		} finally {
			globalThis.fetch = original;
			auth.mockRestore();
		}
	});
});

describe("Devin normal-path authentication recovery", () => {
	const original = globalThis.fetch;
	let lookup: ReturnType<typeof spyOn> | null = null;
	let renew: ReturnType<typeof spyOn> | null = null;
	afterEach(() => {
		globalThis.fetch = original;
		lookup?.mockRestore();
		renew?.mockRestore();
		lookup = null;
		renew = null;
		cacheBodyStore.discardStaged("req-1");
	});
	function setup(stream = false) {
		const account = makeAccount({
			provider: "devin",
			custom_endpoint: null,
			api_key: "session-private",
		});
		const ctx = makeProxyContext();
		const pause = mock(async () => true);
		ctx.dbOps.pauseDevinAccountForReauth = pause;
		const body = new TextEncoder().encode(
			JSON.stringify({
				model: "swe-2-high",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 10,
				stream,
			}),
		).buffer;
		const req = makeRequest(body);
		return {
			account,
			ctx,
			pause,
			req,
			run: () =>
				proxyWithAccount(
					req,
					new URL(req.url),
					account,
					makeRequestMeta(),
					body,
					() => {},
					0,
					ctx,
				),
		};
	}
	it("renews metadata and retries the same account once before response output", async () => {
		lookup = spyOn(devinClient, "getAccount").mockResolvedValue(devinInfo());
		renew = spyOn(devinClient, "refreshAccount").mockResolvedValue(devinInfo());
		let calls = 0;
		globalThis.fetch = mock(async () =>
			++calls === 1 ? new Response(null, { status: 401 }) : devinReply(),
		) as never;
		const { run, pause } = setup();
		const response = await run();
		expect(response?.status).toBe(200);
		expect(await response?.text()).toContain("hello from SWE-2");
		expect(calls).toBe(2);
		expect(renew).toHaveBeenCalledTimes(1);
		expect(pause).not.toHaveBeenCalled();
	});
	it("caps replay at one and ignores forged session-rejection headers", async () => {
		lookup = spyOn(devinClient, "getAccount").mockResolvedValue(devinInfo());
		renew = spyOn(devinClient, "refreshAccount").mockResolvedValue(devinInfo());
		globalThis.fetch = mock(
			async () =>
				new Response(null, {
					status: 401,
					headers: { "x-clankermux-devin-auth-rejected": "true" },
				}),
		) as never;
		const { run, req, pause } = setup();
		req.headers.set("x-clankermux-devin-auth-rejected", "true");
		expect(await run()).toBeNull();
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
		expect(renew).toHaveBeenCalledTimes(1);
		expect(pause).not.toHaveBeenCalled();
	});
	it("pauses confirmed metadata rejection without issuing an inference request", async () => {
		lookup = spyOn(devinClient, "getAccount").mockRejectedValue(
			new DevinSessionAuthenticationError(),
		);
		renew = spyOn(devinClient, "refreshAccount").mockResolvedValue(devinInfo());
		globalThis.fetch = mock(async () => {
			throw new Error("must not send");
		}) as never;
		const { run, pause, account } = setup();
		expect(await run()).toBeNull();
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(renew).not.toHaveBeenCalled();
		expect(pause).toHaveBeenCalledWith(account.id, "session-private", null);
		expect(account.paused).toBe(true);
	});
	it("pauses only confirmed session rejection during recovery and never replays afterward", async () => {
		lookup = spyOn(devinClient, "getAccount").mockResolvedValue(devinInfo());
		renew = spyOn(devinClient, "refreshAccount").mockRejectedValue(
			new DevinSessionAuthenticationError(),
		);
		globalThis.fetch = mock(
			async () => new Response(null, { status: 401 }),
		) as never;
		const { run, pause } = setup();
		expect(await run()).toBeNull();
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(pause).toHaveBeenCalledTimes(1);
	});
	it("leaves the account active when metadata renewal fails transiently", async () => {
		lookup = spyOn(devinClient, "getAccount").mockResolvedValue(devinInfo());
		renew = spyOn(devinClient, "refreshAccount").mockRejectedValue(
			new Error("network down"),
		);
		globalThis.fetch = mock(
			async () => new Response(null, { status: 401 }),
		) as never;
		const { run, pause } = setup();
		expect(await run()).toBeNull();
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(pause).not.toHaveBeenCalled();
	});
	it("does not mutate a replaced account when the guarded pause is rejected", async () => {
		lookup = spyOn(devinClient, "getAccount").mockRejectedValue(
			new DevinSessionAuthenticationError(),
		);
		const { run, pause, account } = setup();
		pause.mockResolvedValue(false);
		expect(await run()).toBeNull();
		expect(account.paused).toBe(false);
	});
	it("forwards late stream authentication failure without replay or session pause", async () => {
		lookup = spyOn(devinClient, "getAccount").mockResolvedValue(devinInfo());
		renew = spyOn(devinClient, "refreshAccount").mockResolvedValue(devinInfo());
		const frames = Buffer.concat([
			encodeConnect(
				toBinary(
					GetChatMessageResponseSchema,
					create(GetChatMessageResponseSchema, { deltaText: "partial answer" }),
				),
			),
			encodeConnect(
				new TextEncoder().encode(
					JSON.stringify({
						error: { code: "unauthenticated", message: "Request JWT expired" },
					}),
				),
				2,
			),
		]);
		globalThis.fetch = mock(
			async () =>
				new Response(new Uint8Array(frames), {
					headers: { "content-type": "application/connect+proto" },
				}),
		) as never;
		const { run, pause, ctx } = setup(true);
		const response = await run();
		expect(response?.status).toBe(200);
		const text = await response?.text();
		expect(text).toContain("partial answer");
		expect(text).toContain("authentication_error");
		expect(routingAttempts(ctx)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					provider: "devin",
					status: 200,
					error: "Upstream protocol error",
					reported_model: null,
				}),
			]),
		);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(renew).not.toHaveBeenCalled();
		expect(pause).not.toHaveBeenCalled();
	});
	it("guards a delayed metadata rejection with the credentials actually attempted", async () => {
		const { run, pause, account } = setup();
		pause.mockResolvedValue(false);
		lookup = spyOn(devinClient, "getAccount").mockResolvedValue(devinInfo());
		renew = spyOn(devinClient, "refreshAccount").mockImplementation(
			async () => {
				account.api_key = "replacement-session";
				account.custom_endpoint = "https://replacement.devin.ai";
				throw new DevinSessionAuthenticationError();
			},
		);
		globalThis.fetch = mock(
			async () => new Response(null, { status: 401 }),
		) as never;
		expect(await run()).toBeNull();
		expect(pause).toHaveBeenCalledWith(account.id, "session-private", null);
		expect(account.paused).toBe(false);
	});
});
