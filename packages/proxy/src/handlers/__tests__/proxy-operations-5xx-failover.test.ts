import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { makeAccount as canonicalAccount } from "@clankermux/test-support";
import type { Account, RequestMeta } from "@clankermux/types";
import type { ProxyAttemptOutcome } from "../../__tests__/fixtures/routing-harness";
import { proxyWithAccount } from "../../__tests__/fixtures/routing-harness";
import { clearProviderOverloadCooldown } from "../../provider-overload-cooldown";
import { isAccountWideFailure } from "../../recovery-holds";
import type { ProxyContext } from "../proxy-types";

/**
 * A transient upstream server error used to reach `forwardToClient` untouched:
 * nothing in the attempt ladder matched a plain 500/502/503/504, so the client
 * got the error while healthy accounts sat idle in the pool. These tests pin the
 * rung that fails over instead, and — just as importantly — the three things it
 * must NOT do: write a cooldown, retry the same account, or swallow the error
 * when there is nobody left to try.
 */

const MODEL = "claude-sonnet-4-5";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return canonicalAccount({
		name: "compat-a",
		provider: "openai-compatible",
		api_key: "test-key",
		refresh_token: "",
		created_at: Date.now(),
		custom_endpoint: "https://openrouter.ai/api/v1",
		...overrides,
	});
}

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-5xx-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeRequestBody() {
	return new TextEncoder().encode(
		JSON.stringify({
			model: MODEL,
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

function makeProxyContext(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(() => Promise.resolve(1)),
			markAccountRateLimitedDeadlineOnly: mock(() => Promise.resolve()),
			saveRequest: mock(() => Promise.resolve()),
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
			buildUrl: () => "https://openrouter.ai/api/v1/messages",
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
}

/**
 * Run one attempt. `lastAccount` mirrors the 5xx disposition the failover loop
 * hands down: `undefined` means the caller supplies no disposition at all, which
 * is a third, distinct case — not a synonym for "there are siblings".
 */
async function run(
	account: Account,
	ctx: ProxyContext,
	lastAccount: boolean | undefined,
	outcomes: ProxyAttemptOutcome[] = [],
) {
	const body = makeRequestBody();
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
		false,
		{
			onOutcome: (o) => outcomes.push(o),
			...(lastAccount === undefined
				? {}
				: { forwardTransientServerError: () => lastAccount }),
		},
	);
}

function serverError(status: number) {
	return new Response(
		JSON.stringify({ type: "error", error: { message: "upstream boom" } }),
		{
			status,
			headers: {
				"content-type": "application/json",
				"x-upstream-marker": "kept",
			},
		},
	);
}

/**
 * A response whose body is only marked `fullyRead` once something pulls it to
 * EOF. Chunked on purpose: a single-chunk stream is filled eagerly at
 * construction, so it would look drained even to a consumer that merely
 * cancelled. See response-body-cancel-on-failover.test.ts for the same pattern.
 *
 * `text/plain`, not JSON, and that is the whole point: the registered
 * OpenAI-compatible provider (which wins over `ctx.provider` — the attempt uses
 * `getProvider(account.provider)`) consumes a JSON body with
 * `await response.arrayBuffer()` inside `processResponse`, so a JSON fixture
 * arrives at the rung already at EOF and the assertion would hold with or
 * without disposal. A non-JSON body falls through `processResponse` untouched.
 */
function observableServerError(status: number) {
	const state = { fullyRead: false, cancelled: false };
	const payload = new TextEncoder().encode("upstream boom, in plain text");
	const chunkSize = Math.max(1, Math.ceil(payload.byteLength / 4));
	let offset = 0;
	const response = new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset >= payload.byteLength) {
					controller.close();
					state.fullyRead = true;
					return;
				}
				controller.enqueue(payload.slice(offset, offset + chunkSize));
				offset += chunkSize;
			},
			cancel() {
				state.cancelled = true;
			},
		}),
		{ status, headers: { "content-type": "text/plain" } },
	);
	return { response, state };
}

async function waitFor(predicate: () => boolean, label: string) {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for: ${label}`);
}

describe("proxyWithAccount — transient upstream 5xx", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
	});

	for (const status of [500, 502, 503, 504]) {
		it(`fails over on ${status} while another account can still be tried`, async () => {
			const fetcher = mock(async () => serverError(status));
			globalThis.fetch = fetcher as unknown as typeof fetch;
			const ctx = makeProxyContext();
			const account = makeAccount();
			const outcomes: ProxyAttemptOutcome[] = [];

			expect(await run(account, ctx, false, outcomes)).toBeNull();

			// One attempt only: the same account is not re-sent to.
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(outcomes).toEqual([{ kind: "server_error", status }]);
			// Held against the account for the rest of the request, so a recovery
			// hold entered later cannot be served by the account that just failed.
			expect(isAccountWideFailure(outcomes[0])).toBe(true);
			// No quota state invented from a server error.
			expect(account.rate_limited_until).toBeNull();
			expect(account.rate_limited_reason).toBeNull();
			expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
			expect(
				ctx.dbOps.markAccountRateLimitedDeadlineOnly,
			).not.toHaveBeenCalled();
		});
	}

	it("forwards the upstream error unchanged on the last attemptable account", async () => {
		globalThis.fetch = mock(async () =>
			serverError(503),
		) as unknown as typeof fetch;
		const outcomes: ProxyAttemptOutcome[] = [];

		const response = await run(
			makeAccount(),
			makeProxyContext(),
			true,
			outcomes,
		);

		expect(response?.status).toBe(503);
		expect((await response?.json())?.error?.message).toBe("upstream boom");
		// The upstream envelope survives, not just the status: an operator reading
		// this response should see what the backend actually said.
		expect(response?.headers.get("x-upstream-marker")).toBe("kept");
		expect(outcomes).toEqual([]);
	});

	it("ignores isLastAccountAttempt, which governs a different policy", async () => {
		// Regression guard. `isLastAccountAttempt` also decides where an
		// `org_permission_denied` 403 fails over, so a caller that set it purely
		// to describe its 5xx policy would move that 403 boundary as a side
		// effect. The 5xx rung must read only its own option.
		globalThis.fetch = mock(async () =>
			serverError(500),
		) as unknown as typeof fetch;
		const body = makeRequestBody();
		const outcomes: ProxyAttemptOutcome[] = [];

		const response = await proxyWithAccount(
			makeRequest(body),
			new URL("https://proxy.local/v1/messages"),
			makeAccount(),
			makeRequestMeta(),
			body,
			() => undefined,
			0,
			makeProxyContext(),
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			{
				onOutcome: (o) => outcomes.push(o),
				isLastAccountAttempt: () => false,
			},
		);

		expect(response?.status).toBe(500);
		await response?.text();
		expect(outcomes).toEqual([]);
	});

	it("forwards unchanged when the caller supplies no 5xx disposition", async () => {
		globalThis.fetch = mock(async () =>
			serverError(500),
		) as unknown as typeof fetch;
		const outcomes: ProxyAttemptOutcome[] = [];

		const response = await run(
			makeAccount(),
			makeProxyContext(),
			undefined,
			outcomes,
		);

		expect(response?.status).toBe(500);
		await response?.text();
		expect(outcomes).toEqual([]);
	});

	it("drains the abandoned body rather than only cancelling it", async () => {
		const { response, state } = observableServerError(502);
		globalThis.fetch = mock(async () => response) as unknown as typeof fetch;

		expect(await run(makeAccount(), makeProxyContext(), false)).toBeNull();

		await waitFor(() => state.fullyRead, "the 502 body to be drained to EOF");
		// Drained, not cancelled: cancelling alone does not reliably return Bun's
		// native read allocation, which is the entire reason discardUpstreamBody
		// exists.
		expect(state.cancelled).toBe(false);
	});

	it("leaves a 5xx carrying hard quota headers on the quota path", async () => {
		// Anthropic marks a response rate-limited off the unified-status header
		// whatever the HTTP status is, so a 503 with `rate_limited` is a quota
		// rejection wearing a server-error status. The rung must sit BELOW that
		// classification, or the cooldown and the reason would be lost.
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({ type: "error", error: { message: "boom" } }),
					{
						status: 503,
						headers: {
							"content-type": "application/json",
							"anthropic-ratelimit-unified-status": "rate_limited",
							"anthropic-ratelimit-unified-reset": String(
								Math.floor((Date.now() + 60_000) / 1000),
							),
						},
					},
				),
		) as unknown as typeof fetch;
		const account = makeAccount({
			provider: "anthropic",
			api_key: null,
			access_token: "at-token",
			refresh_token: "rt-token",
			expires_at: Date.now() + 3_600_000,
			custom_endpoint: null,
		});
		const outcomes: ProxyAttemptOutcome[] = [];

		expect(await run(account, makeProxyContext(), false, outcomes)).toBeNull();

		expect(outcomes).toHaveLength(1);
		expect(outcomes[0].kind).toBe("hard_429");
	});

	it("does not treat a 501 as transient", async () => {
		globalThis.fetch = mock(async () =>
			serverError(501),
		) as unknown as typeof fetch;
		const outcomes: ProxyAttemptOutcome[] = [];

		const response = await run(
			makeAccount(),
			makeProxyContext(),
			false,
			outcomes,
		);

		expect(response?.status).toBe(501);
		await response?.text();
		expect(outcomes).toEqual([]);
	});
});
