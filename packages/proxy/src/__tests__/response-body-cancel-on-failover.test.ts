import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getProvider } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";

/**
 * Regression: failover/return-null paths in proxy-operations.ts MUST dispose the
 * abandoned upstream response body. At Bun 1.3.x a fetch() Response body that is
 * neither read to EOF nor cancelled keeps its socket + ~512 KB native read
 * buffer committed forever — an off-heap leak that ratchets up with every 429 /
 * 401 / 529 failover under load (observed: ~1.6 GB/h on the live proxy).
 *
 * WHAT THESE TESTS PIN, AND WHAT THEY DO NOT
 * ------------------------------------------
 * They pin the CONTRACT: a native upstream body on a failover path is DRAINED
 * to EOF, not merely cancelled. That distinction is the whole point of
 * `discardUpstreamBody` — cancelling alone does not reliably return Bun's native
 * read allocation, which is why the previous version of this file (which
 * asserted only `state.cancelled`) looked green while the leak was still live.
 * Asserting "the call happened" is not asserting "the memory was released".
 *
 * They do NOT pin native memory behaviour. That was established out-of-band with
 * RSS measurements against Bun 1.3.14; no soak test is added to this suite,
 * because a memory soak is neither fast nor deterministic enough to belong here.
 *
 * Because disposal is fire-and-forget (it must not block failover), `fullyRead`
 * is NOT true synchronously when handleProxy returns — every assertion below
 * polls for it.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
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
		custom_endpoint: null,
		model_mappings: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

/**
 * Drive handleProxy and swallow the ServiceUnavailableError it throws once every
 * attempted account has failed over (it only RETURNS a 503 for an empty pool).
 * The body cancellation we assert on happens inside proxyWithAccount before the
 * failover `return null`, so it occurs regardless of the terminal throw.
 */
async function runFailover(ctx: ProxyContext): Promise<void> {
	const { handleProxy } = await import("../proxy");
	try {
		await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
	} catch {
		// Expected: all attempted accounts failed → ServiceUnavailableError.
	}
}

function makeRequest(headers: Record<string, string> = {}): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

function makeContext(
	accounts: Account[],
	providerOverride?: unknown,
): ProxyContext {
	return {
		strategy: {
			select: mock((allAccounts: Account[]) => allAccounts),
		},
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
			updateAccountUsage: mock(async () => undefined),
			updateAccountRateLimitMeta: mock(async () => undefined),
			updateAccountTokens: mock(async () => true),
			updateRequestUsage: mock(async () => undefined),
			resetAccountSession: mock(async () => undefined),
			markAccountRateLimited: mock(async () => 1),
			markAccountRateLimitedDeadlineOnly: mock(async () => {}),
			saveRequest: mock(async () => undefined),
			getAdapter: mock(() => ({
				run: mock(async () => undefined),
				get: mock(async () => null),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getCacheWarmingEnabled: () => false,
			getCacheWarmingMinTokens: () => 100_000,
			getStorePayloads: () => true,
		} as never,
		provider: (providerOverride ?? getProvider("anthropic")) as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => undefined) } as never,
		requestRecorder: {
			begin: mock(() => undefined),
			captureResponseChunk: mock(() => undefined),
			finishTransport: mock(() => undefined),
			attachUsageSummary: mock(() => undefined),
			markUsageUnavailable: mock(() => undefined),
			recordSynthetic: mock(() => undefined),
			sweep: mock(() => undefined),
			dispose: mock(() => undefined),
		} as never,
	};
}

/**
 * Poll until `predicate()` holds, or fail the test after `timeoutMs`.
 *
 * Required because body disposal is intentionally fire-and-forget: the failover
 * path returns as soon as the drain is LAUNCHED, so the drain completes a few
 * microtasks later. A synchronous assertion would race it.
 */
async function waitFor(
	predicate: () => boolean,
	label: string,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

/**
 * Build an error Response whose body is a ReadableStream we can observe.
 *
 * `fullyRead` flips true only when the stream is actually pulled to EOF — i.e.
 * when the proxy DRAINED the body and Bun can release the native read buffer.
 * `cancelled` flips true on a bare `cancel()`, which is what the OLD (leaky)
 * behaviour did: it proves a call was made, not that anything was released.
 * The assertions below therefore key on `fullyRead`.
 *
 * The payload is deliberately emitted in SEVERAL chunks. A single-chunk stream
 * cannot distinguish the two behaviours: with the default highWaterMark of 1 the
 * stream calls `pull` eagerly at construction to fill its queue, so a one-shot
 * `enqueue`+`close` would set `fullyRead` before anyone read anything — and the
 * assertion would pass even for cancel-only disposal. Chunking forces one `pull`
 * per `read()`, so EOF is reached only by a consumer that actually drains.
 * Concatenated, the chunks are byte-identical to `json`, so any other reader on
 * the path still parses the same body.
 */
function errorResponseWithObservableBody(
	status: number,
	json: string,
	headers: Record<string, string> = {},
): { response: Response; state: { cancelled: boolean; fullyRead: boolean } } {
	const state = { cancelled: false, fullyRead: false };
	const payload = new TextEncoder().encode(json);
	const chunkSize = Math.max(1, Math.ceil(payload.byteLength / 4));
	let offset = 0;
	const body = new ReadableStream<Uint8Array>({
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
	});
	const response = new Response(body, {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
	return { response, state };
}

describe("failover drains the abandoned upstream response body", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("drains the 429 body on the no-model-fallback failover (return null)", async () => {
		const account = makeAccount({ id: "anthropic-a", provider: "anthropic" });
		const { response, state } = errorResponseWithObservableBody(
			429,
			'{"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}',
			{ "retry-after": "60" },
		);

		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));
			// Don't let the pricing-catalogue fetch (models.dev) interfere.
			if (request.url.includes("models.dev")) {
				return new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return response;
		}) as never;

		const ctx = makeContext([account]);
		await runFailover(ctx);

		// The abandoned 429 body must be READ TO EOF, not merely cancelled: only
		// a drain returns Bun's native read buffer. Polled because the drain is
		// launched fire-and-forget so failover isn't blocked by it.
		await waitFor(() => state.fullyRead, "the abandoned 429 body to drain");
		expect(state.fullyRead).toBe(true);
	});

	it("drains the 401 body on the auth-failure failover (return null)", async () => {
		const account = makeAccount({ id: "anthropic-a", provider: "anthropic" });
		const { response, state } = errorResponseWithObservableBody(
			401,
			'{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
		);

		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));
			if (request.url.includes("models.dev")) {
				return new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return response;
		}) as never;

		const ctx = makeContext([account]);
		await runFailover(ctx);

		await waitFor(() => state.fullyRead, "the abandoned 401 body to drain");
		expect(state.fullyRead).toBe(true);
	});
});

/**
 * The ONE failover site where drain is the wrong primitive.
 *
 * The rate-limited failover runs AFTER processProxyResponse →
 * updateAccountMetadata, which — whenever a requestId is set, i.e. always on
 * this path — hands a `response.clone()` to a floating usage-extraction IIFE.
 * The response being disposed there is a tee branch whose twin may still be
 * reading, and draining a branch makes the tee pull and buffer the whole body
 * for that twin. So this site cancels; every other fail() site still drains.
 *
 * The context below deliberately supplies a provider WITHOUT extractUsageInfo /
 * parseUsage, so no extraction clone is made and the disposal primitive is
 * observable at the stream source (with a live twin the tee absorbs the
 * difference: the twin's own read pulls the source to EOF either way, and a
 * single branch cancelling never runs the source's cancel algorithm). That is
 * the only way to see WHICH primitive the site used; it does not change which
 * one it uses.
 */
describe("the rate-limited failover cancels its tee branch instead of draining", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("cancels the body of a 200 whose unified-status header reports the account is rate-limited", async () => {
		// A rate-limited verdict is driven by the unified-status header
		// INDEPENDENTLY of the HTTP status, so a successful 200 completion can
		// take this branch — which is exactly why usage extraction still runs
		// here (and therefore why the body is a tee branch).
		const account = makeAccount({
			id: "stub-a",
			provider: "test-provider" as Account["provider"],
		});
		const { response, state } = errorResponseWithObservableBody(
			200,
			'{"type":"message","usage":{"input_tokens":10,"output_tokens":20}}',
			{ "anthropic-ratelimit-unified-status": "rate_limited" },
		);

		// No extractUsageInfo / parseUsage: see the block comment above.
		const stubProvider = {
			name: "test-provider",
			canHandle: () => true,
			buildUrl: () => "https://upstream.local/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: (r: Response) => {
				const statusHeader = r.headers.get(
					"anthropic-ratelimit-unified-status",
				);
				return {
					isRateLimited: statusHeader === "rate_limited" || r.status === 429,
					resetTime: undefined,
					statusHeader: statusHeader ?? undefined,
					remaining: undefined,
				};
			},
			isStreamingResponse: () => false,
		};

		let upstreamCalls = 0;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));
			if (request.url.includes("models.dev")) {
				return new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			upstreamCalls++;
			return response;
		}) as never;

		const ctx = makeContext([account], stubProvider);
		await runFailover(ctx);

		// Non-vacuity: the attempt really happened and really was classified
		// rate-limited (so the disposal below is the rate-limited fail() site,
		// not some other path). The cooldown is read off the in-memory account —
		// this file's asyncWriter mock never runs the enqueued DB job.
		expect(upstreamCalls).toBe(1);
		expect(account.rate_limited_until ?? 0).toBeGreaterThan(Date.now());

		// Disposal is fire-and-forget, so wait for whichever primitive ran.
		await waitFor(
			() => state.cancelled || state.fullyRead,
			"the rate-limited body to be disposed",
		);
		expect(state.cancelled).toBe(true);
		// Never pulled to EOF: draining is what would make the tee buffer the
		// whole body for a live twin.
		expect(state.fullyRead).toBe(false);
	});
});
