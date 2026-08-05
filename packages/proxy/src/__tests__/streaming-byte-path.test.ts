/**
 * End-to-end byte-fidelity pin for the streaming `/v1/messages` happy path.
 *
 * handleProxy's response leg tees the upstream stream for inline usage
 * analytics before forwarding it. That topology is delicate (see the Bun
 * `onAbort` segfault work), so this test pins the property every refactor of
 * the function must preserve: the client receives the upstream stream frame for
 * frame, with the SSE content-type intact and exactly one documented
 * augmentation (the Anthropic provider's `finish_reason` on `message_delta`).
 */

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from "bun:test";
import { usageCache } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import { cacheBodyStore } from "../cache-body-store";
import type { ProxyContext } from "../handlers";
import { setForcedAccount } from "../handlers";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { resetOverloadHoldSlots } from "../overload-hold";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";
import { sessionPromotionTracker } from "../session-promotion";

const ACCOUNT_ID = "acc-stream";
const MODEL = "claude-sonnet-4-5";
const enc = new TextEncoder();

const MESSAGE_DELTA_UPSTREAM =
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n';
/**
 * The ONE frame the pipeline is allowed to rewrite: the Anthropic provider's
 * stream transform maps Anthropic's `stop_reason` onto an OpenAI-compatible
 * `finish_reason` on `message_delta` (provider.ts, "Transform Anthropic SSE
 * stream to add OpenAI-compatible finish_reason"). Spelled out here rather than
 * computed, so a change to that augmentation shows up as a test failure instead
 * of being absorbed silently.
 */
const MESSAGE_DELTA_FORWARDED =
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7},"finish_reason":"stop"}\n\n';

const UPSTREAM_FRAMES = [
	'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5","usage":{"input_tokens":11}}}\n\n',
	'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
	'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
	MESSAGE_DELTA_UPSTREAM,
	'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

/** What the client must receive: every frame verbatim except the one above. */
const EXPECTED_FRAMES = UPSTREAM_FRAMES.map((frame) =>
	frame === MESSAGE_DELTA_UPSTREAM ? MESSAGE_DELTA_FORWARDED : frame,
);

async function callHandleProxy(req: Request, url: URL, ctx: ProxyContext) {
	const { handleProxy } = await import("../proxy");
	return handleProxy(req, url, ctx);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: ACCOUNT_ID,
		name: "stream-main",
		provider: "anthropic",
		api_key: "test-key",
		refresh_token: null,
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
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	} as Account;
}

function makeContext(accounts: Account[]): ProxyContext {
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
			getAccount: mock(
				async (id: string) => accounts.find((a) => a.id === id) ?? null,
			),
			getActiveComboForFamily: mock(async () => null),
			markAccountRateLimited: mock(async () => 1),
			markAccountRateLimitedDeadlineOnly: mock(async () => {}),
			saveRequest: mock(async () => {}),
			updateAccountUsage: mock(async () => {}),
			updateAccountRateLimitMeta: mock(async () => {}),
			resetConsecutiveRateLimits: mock(async () => {}),
			updateRequestUsage: mock(async () => {}),
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
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://api.anthropic.com/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			isStreamingResponse: () => true,
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
			sweep: mock(() => {}),
			dispose: mock(() => {}),
		} as never,
	};
}

/** One SSE frame per chunk, so a frame-boundary regression is observable. */
function sseStream(frames: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const frame of frames) controller.enqueue(enc.encode(frame));
			controller.close();
		},
	});
}

/** Shunt unrelated background fetches (pricing catalog) — see overload-hold.test.ts. */
function upstreamOnlyFetch(
	handler: () => Response | Promise<Response>,
): typeof globalThis.fetch {
	return mock(async (input: Request | string | URL) => {
		const url = input instanceof Request ? input.url : String(input);
		if (!url.includes("api.anthropic.com")) {
			return new Response("unavailable", { status: 500 });
		}
		return handler();
	}) as never;
}

describe("streaming byte path", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeAll(async () => {
		await import("../proxy");
	});

	const reset = () => {
		setForcedAccount(null);
		cacheBodyStore.setEnabled(false);
		sessionPromotionTracker.setMode("off");
		sessionPromotionTracker.clear();
		clearProviderOverloadCooldown();
		resetOverloadHoldSlots();
		resetRateLimitProbeGatesForTests();
		usageCache.delete(ACCOUNT_ID);
	};

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		reset();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		reset();
	});

	it("forwards a multi-frame SSE response frame-for-frame with the content-type preserved", async () => {
		let upstreamCalls = 0;
		globalThis.fetch = upstreamOnlyFetch(() => {
			upstreamCalls++;
			return new Response(sseStream(UPSTREAM_FRAMES), {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
				},
			});
		});

		const res = await callHandleProxy(
			new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: MODEL,
					stream: true,
					messages: [{ role: "user", content: "hello" }],
					max_tokens: 16,
				}),
			}),
			new URL("https://proxy.local/v1/messages"),
			makeContext([makeAccount()]),
		);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		expect(upstreamCalls).toBe(1);

		// Read the client stream chunk by chunk: the concatenation must equal the
		// expected byte sequence exactly, with the frame boundaries intact.
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				chunks.push(value);
				total += value.byteLength;
			}
		}
		const received = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			received.set(chunk, offset);
			offset += chunk.byteLength;
		}

		const expected = enc.encode(EXPECTED_FRAMES.join(""));
		expect(received.byteLength).toBe(expected.byteLength);
		expect(Array.from(received)).toEqual(Array.from(expected));

		// Frame-for-frame, not just "the same total blob".
		const text = new TextDecoder().decode(received);
		const receivedFrames = text
			.split("\n\n")
			.filter((f) => f.length > 0)
			.map((f) => `${f}\n\n`);
		expect(receivedFrames).toEqual(EXPECTED_FRAMES);
		// Every frame except message_delta reaches the client untouched.
		expect(
			receivedFrames.filter((f) => !f.startsWith("event: message_delta")),
		).toEqual(
			UPSTREAM_FRAMES.filter((f) => !f.startsWith("event: message_delta")),
		);
	}, 15_000);
});
