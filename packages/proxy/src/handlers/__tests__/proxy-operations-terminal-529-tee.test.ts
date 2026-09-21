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
	makeAccount as canonicalAccount,
	mockFetch,
} from "@clankermux/test-support";
import type { Account, RequestMeta } from "@clankermux/types";
import { proxyWithAccount } from "../../__tests__/fixtures/routing-harness";
import type { ProxyContext } from "../proxy-types";
import * as responseProcessor from "../response-processor";

/**
 * The final-529 attempt hands `processProxyResponse` a `response.clone()` — a
 * TEE BRANCH whose twin is the response about to be forwarded. The attempt-wide
 * catch disposes only `liveUpstream` (the original), so nothing else owns the
 * branch: if the rate-limit check throws, the branch has to be released on the
 * way out or it keeps the tee buffering for a reader that will never arrive.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return canonicalAccount({
		name: "tee-test",
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
		id: "req-tee-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeRequestBody(): ArrayBuffer {
	return new TextEncoder().encode(
		JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
		}),
	).buffer as ArrayBuffer;
}

function makeProxyContext(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(() => Promise.resolve()),
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

/** A 529 whose body is a multi-chunk stream, so the tee has something to hold. */
function overloadedResponse(): Response {
	const payload = new TextEncoder().encode(
		'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
	);
	let offset = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= payload.byteLength) {
				controller.close();
				return;
			}
			controller.enqueue(payload.slice(offset, offset + 16));
			offset += 16;
		},
	});
	return new Response(body, {
		status: 529,
		headers: { "content-type": "application/json" },
	});
}

describe("proxyWithAccount — terminal 529 rate-limit-check clone", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		mock.restore();
	});

	it("releases the tee branch when the rate-limit check throws", async () => {
		globalThis.fetch = mockFetch(mock(async () => overloadedResponse()));

		let checked: Response | null = null;
		spyOn(responseProcessor, "processProxyResponse").mockImplementation(
			async (response: Response) => {
				checked = response;
				throw new Error("rate-limit check exploded");
			},
		);

		const bodyBuffer = makeRequestBody();
		const result = await proxyWithAccount(
			new Request("https://proxy.local/v1/messages", {
				method: "POST",
				body: bodyBuffer,
				headers: { "Content-Type": "application/json" },
			}),
			new URL("https://proxy.local/v1/messages"),
			makeAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
			undefined,
			undefined,
			undefined,
			undefined,
			// Terminal attempt: this is what makes the 529 path clone the response.
			true,
		);

		expect(result).toBeNull();
		const branch = checked as Response | null;
		expect(branch).not.toBeNull();
		expect(branch?.status).toBe(529);
		expect(branch?.bodyUsed).toBe(true);
	});
});
