import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { makeAccount as canonicalAccount } from "@clankermux/test-support";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import { MODEL_SUBSTITUTION_SUPPRESSION_REASON } from "../handlers/model-substitution";

/**
 * The rung that notices an upstream answering as a DIFFERENT model than it was
 * sent, and the two things it must never do: fire on the Anthropic path that
 * carries 96k attempts and zero observed substitutions, and fire when the
 * setting is not `enforce`.
 *
 * Every other suite leaves the setting `off` — their config doubles predate the
 * feature and carry arbitrary mock bodies. This is the lane that turns it on.
 */

type Mode = "off" | "observe" | "enforce";

/**
 * The harness installs the whole `routing` double itself, and skips doing so
 * if the context already carries one — so the suppression spy is attached
 * AFTER it has run, not supplied up front.
 */
async function callHandleProxy(req: Request, ctx: ProxyContext) {
	const { handleProxy, provisionRouting } = await import(
		"./fixtures/routing-harness"
	);
	const model = (await req.clone().json()).model as string;
	await provisionRouting(ctx, model, await ctx.dbOps.getAllAccounts());
	const routing = ctx.dbOps.routing as unknown as Record<string, unknown>;
	routing.suppressModel = mock(
		async (
			accountId: string,
			_scope: string,
			suppressedModel: string,
			_until: number,
			reason: string,
		) => {
			suppressed.push({ accountId, model: suppressedModel, reason });
		},
	);
	return handleProxy(req, new URL(req.url), ctx, null, null, false);
}

/**
 * Through the dispatcher, not `handleProxy`: the terminal is THROWN there and
 * only becomes a status and an error type in `dispatchProxyRequest`. Asserting
 * the thrown class would pass while the client still received a generic 503.
 */
async function callDispatch(req: Request, ctx: ProxyContext) {
	const { provisionRouting } = await import("./fixtures/routing-harness");
	const { dispatchProxyRequest } = await import("../dispatch");
	const model = (await req.clone().json()).model as string;
	await provisionRouting(ctx, model, await ctx.dbOps.getAllAccounts());
	return dispatchProxyRequest(req, new URL(req.url), ctx, null, null, false);
}

/**
 * `id` is always overridden: the canonical helper defaults every account to
 * `acc-1`, and the within-request exclusion is keyed on (account id, model), so
 * two accounts sharing an id would exclude each other and make a failover test
 * silently assert the wrong thing.
 */
function makeAnthropicAccount(overrides: Partial<Account> = {}): Account {
	return canonicalAccount({
		id: `acc-${Math.random().toString(36).slice(2, 10)}`,
		name: "Claude",
		provider: "anthropic",
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3_600_000,
		created_at: Date.now(),
		...overrides,
	});
}

const suppressed: Array<{ accountId: string; model: string; reason: string }> =
	[];

function makeContext(
	accounts: Account[],
	mode: Mode,
	exceptions: string[] = [],
): ProxyContext {
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
			getServedModelSubstitutionMode: () => mode,
			getServedModelSubstitutionExceptions: () => exceptions,
		} as never,
		provider: {
			name: "anthropic",
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

/** An ordinary Anthropic stream that names the model it was sent. */
function anthropicSse(model: string): string {
	return (
		"event: message_start\n" +
		`data: ${JSON.stringify({
			type: "message_start",
			message: { id: "msg_1", model, usage: { input_tokens: 1 } },
		})}\n\n` +
		"event: content_block_delta\n" +
		`data: ${JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "hello" },
		})}\n\n` +
		"event: message_stop\n" +
		`data: ${JSON.stringify({ type: "message_stop" })}\n\n`
	);
}

function sseResponse(body: string): Response {
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function makeRequest(model: string): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 16,
			stream: true,
		}),
	});
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
	originalFetch = globalThis.fetch;
	suppressed.length = 0;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("served-model substitution — the Anthropic path must not regress", () => {
	it("forwards a stream that names the model it was sent, byte for byte", async () => {
		const body = anthropicSse("claude-sonnet-4-5");
		globalThis.fetch = mock(async () => sseResponse(body)) as never;

		const account = makeAnthropicAccount();
		const res = await callHandleProxy(
			makeRequest("claude-sonnet-4-5"),
			makeContext([account], "enforce"),
		);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe(body);
		expect(suppressed).toEqual([]);
	});

	it("accepts a dated snapshot answer for an undated request", async () => {
		// Anthropic's separator-less snapshot spelling. Treating this as a
		// substitution would fail over the highest-volume path in the deployment.
		const body = anthropicSse("claude-haiku-4-5-20251001");
		globalThis.fetch = mock(async () => sseResponse(body)) as never;

		const res = await callHandleProxy(
			makeRequest("claude-haiku-4-5"),
			makeContext([makeAnthropicAccount()], "enforce"),
		);

		expect(res.status).toBe(200);
		expect(suppressed).toEqual([]);
	});
});

describe("served-model substitution — enforcement", () => {
	it("fails over to a sibling that serves the model it was sent", async () => {
		const first = makeAnthropicAccount({ name: "Substitutes", priority: 1 });
		const second = makeAnthropicAccount({ name: "Honest", priority: 2 });
		const served = anthropicSse("claude-sonnet-4-5");
		let call = 0;
		globalThis.fetch = mock(async () => {
			call += 1;
			// The first account answers as a cheaper model than it was sent.
			return sseResponse(
				call === 1 ? anthropicSse("claude-haiku-4-5") : served,
			);
		}) as never;

		const res = await callHandleProxy(
			makeRequest("claude-sonnet-4-5"),
			makeContext([first, second], "enforce"),
		);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe(served);
		expect(call).toBe(2);
		expect(suppressed).toHaveLength(1);
		expect(suppressed[0]?.reason).toBe(MODEL_SUBSTITUTION_SUPPRESSION_REASON);
		expect(suppressed[0]?.model).toBe("claude-sonnet-4-5");
	});

	it("returns a retryable 503 naming both models when every account substitutes", async () => {
		globalThis.fetch = mock(async () =>
			sseResponse(anthropicSse("claude-haiku-4-5")),
		) as never;

		const res = await callDispatch(
			makeRequest("claude-sonnet-4-5"),
			makeContext(
				[
					makeAnthropicAccount({ name: "A", priority: 1 }),
					makeAnthropicAccount({ name: "B", priority: 2 }),
				],
				"enforce",
			),
		);

		expect(res.status).toBe(503);
		const payload = (await res.json()) as {
			error: { type: string; message: string };
		};
		// Its own type, not the generic service_unavailable_error every other 503
		// collapses into, and not the non-retryable 400 the model-rejection
		// terminal produces.
		expect(payload.error.type).toBe("model_substituted_error");
		expect(payload.error.message).toContain("claude-haiku-4-5");
		expect(payload.error.message).toContain("claude-sonnet-4-5");
	});

	it("observes without failing over or suppressing", async () => {
		const body = anthropicSse("claude-haiku-4-5");
		globalThis.fetch = mock(async () => sseResponse(body)) as never;

		const res = await callHandleProxy(
			makeRequest("claude-sonnet-4-5"),
			makeContext([makeAnthropicAccount()], "observe"),
		);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe(body);
		expect(suppressed).toEqual([]);
	});

	it("serves an accepted swap instead of failing it over", async () => {
		// The swap an operator has approved. Enforcement is still ON, and the
		// sibling that would have served the request correctly must not be
		// reached: the point of the exception is that the answer in hand is fine.
		const body = anthropicSse("claude-haiku-4-5");
		let call = 0;
		globalThis.fetch = mock(async () => {
			call += 1;
			return sseResponse(body);
		}) as never;

		const res = await callHandleProxy(
			makeRequest("claude-sonnet-4-5"),
			makeContext(
				[
					makeAnthropicAccount({ name: "Swaps", priority: 1 }),
					makeAnthropicAccount({ name: "Honest", priority: 2 }),
				],
				"enforce",
				["claude-sonnet-4-5>claude-haiku-4-5"],
			),
		);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe(body);
		expect(call).toBe(1);
		expect(suppressed).toEqual([]);
	});

	it("still enforces a swap the exception does not name", async () => {
		// One accepted pair must not read as "substitution is fine on this
		// account": a different served model is a different decision.
		const first = makeAnthropicAccount({ name: "Swaps", priority: 1 });
		const second = makeAnthropicAccount({ name: "Honest", priority: 2 });
		const served = anthropicSse("claude-sonnet-4-5");
		let call = 0;
		globalThis.fetch = mock(async () => {
			call += 1;
			return sseResponse(call === 1 ? anthropicSse("claude-opus-5") : served);
		}) as never;

		const res = await callHandleProxy(
			makeRequest("claude-sonnet-4-5"),
			makeContext([first, second], "enforce", [
				"claude-sonnet-4-5>claude-haiku-4-5",
			]),
		);

		expect(res.status).toBe(200);
		expect(call).toBe(2);
		expect(suppressed).toHaveLength(1);
	});

	it("does nothing at all when switched off", async () => {
		const body = anthropicSse("claude-haiku-4-5");
		globalThis.fetch = mock(async () => sseResponse(body)) as never;

		const res = await callHandleProxy(
			makeRequest("claude-sonnet-4-5"),
			makeContext([makeAnthropicAccount()], "off"),
		);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe(body);
		expect(suppressed).toEqual([]);
	});
});
