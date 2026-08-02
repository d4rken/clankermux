import { describe, expect, it } from "bun:test";
import { getProvider } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../proxy-types";
import { updateAccountMetadata } from "../response-processor";

/**
 * GATING tests for the usage-extractor disposable-response contract.
 *
 * Usage extraction runs inside a floating `(async () => {...})()` whose catch
 * only logs a warning, so a broken extractor fails SILENTLY: no crash, no failed
 * request — just `updateRequestUsage` never called and NULL cost/token
 * accounting for the request. That path covers the overwhelming majority of
 * traffic (~141k of the last 30 days' 158k requests), so "no exception was
 * thrown" is worthless as an assertion here.
 *
 * These tests therefore assert the VALUES handed to `updateRequestUsage`, for
 * both response shapes the extractor has to handle:
 *   - a streaming SSE response (usage read from the `message_start` event), and
 *   - a non-streaming JSON response (usage read from the response body).
 *
 * They exist because the extractors stopped cloning internally: they now consume
 * the Response the caller hands them, per the contract documented on
 * `Provider.extractUsageInfo`. If that consumption ever breaks — a body read
 * twice, a reader never released, a clone reintroduced in the wrong place —
 * these fail loudly instead of the accounting quietly going NULL.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acct-usage-1",
		name: "usage-test-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3_600_000,
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
		cross_region_mode: null,
		model_mappings: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

type UsageCall = {
	requestId: string;
	usage: Record<string, unknown>;
};

/**
 * ProxyContext wired to the REAL Anthropic provider — the point of these tests
 * is the provider's extractor, so stubbing it would defeat them. Only the DB and
 * writer surface is spied.
 */
function makeCtx(): { ctx: ProxyContext; usageCalls: UsageCall[] } {
	const usageCalls: UsageCall[] = [];
	const ctx = {
		provider: getProvider("anthropic"),
		dbOps: {
			updateAccountUsage: async () => {},
			updateAccountRateLimitMeta: async () => {},
			updateRequestUsage: async (
				requestId: string,
				usage: Record<string, unknown>,
			) => {
				usageCalls.push({ requestId, usage });
			},
			getAdapter: () => ({
				get: async () => null,
				run: async () => {},
			}),
		},
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => Promise.resolve(job()),
		},
	} as unknown as ProxyContext;
	return { ctx, usageCalls };
}

/** Poll: extraction is a floating async task, so it lands after the call returns. */
async function waitForUsage(
	usageCalls: UsageCall[],
	timeoutMs = 5_000,
): Promise<UsageCall> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (usageCalls.length > 0) return usageCalls[0];
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(
		`updateRequestUsage was never called within ${timeoutMs}ms — usage extraction is silently broken`,
	);
}

/** A response whose body is a real stream, as the upstream one would be. */
function streamedResponse(
	chunks: string[],
	headers: Record<string, string>,
): Response {
	const encoder = new TextEncoder();
	let i = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i >= chunks.length) {
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(chunks[i]));
			i += 1;
		},
	});
	return new Response(body, { status: 200, headers });
}

describe("usage extraction feeds updateRequestUsage", () => {
	it("streaming SSE: extracts message_start usage and records the token values", async () => {
		const { ctx, usageCalls } = makeCtx();
		const sse = [
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01","model":"claude-sonnet-4-5","usage":{"input_tokens":100,"output_tokens":5,"cache_creation_input_tokens":20,"cache_read_input_tokens":30}}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		];
		const response = streamedResponse(sse, {
			"content-type": "text/event-stream",
		});

		updateAccountMetadata(makeAccount(), response, ctx, "req-stream-1");

		const call = await waitForUsage(usageCalls);
		expect(call.requestId).toBe("req-stream-1");
		expect(call.usage.model).toBe("claude-sonnet-4-5");
		expect(call.usage.inputTokens).toBe(100);
		expect(call.usage.cacheCreationInputTokens).toBe(20);
		expect(call.usage.cacheReadInputTokens).toBe(30);
		expect(call.usage.outputTokens).toBe(5);
		// promptTokens = input + cacheCreation + cacheRead; total = prompt + output.
		expect(call.usage.promptTokens).toBe(150);
		expect(call.usage.completionTokens).toBe(5);
		expect(call.usage.totalTokens).toBe(155);
	});

	it("non-streaming JSON: extracts body usage and records the token values", async () => {
		const { ctx, usageCalls } = makeCtx();
		const response = streamedResponse(
			[
				JSON.stringify({
					id: "msg_02",
					type: "message",
					model: "claude-opus-4-8",
					content: [{ type: "text", text: "hi" }],
					usage: {
						input_tokens: 7,
						output_tokens: 11,
						cache_creation_input_tokens: 13,
						cache_read_input_tokens: 17,
					},
				}),
			],
			{ "content-type": "application/json" },
		);

		updateAccountMetadata(makeAccount(), response, ctx, "req-json-1");

		const call = await waitForUsage(usageCalls);
		expect(call.requestId).toBe("req-json-1");
		expect(call.usage.model).toBe("claude-opus-4-8");
		expect(call.usage.inputTokens).toBe(7);
		expect(call.usage.cacheCreationInputTokens).toBe(13);
		expect(call.usage.cacheReadInputTokens).toBe(17);
		expect(call.usage.outputTokens).toBe(11);
		expect(call.usage.promptTokens).toBe(37);
		expect(call.usage.completionTokens).toBe(11);
		expect(call.usage.totalTokens).toBe(48);
	});

	it("leaves the caller's response readable: extraction only consumes its own clone", async () => {
		const { ctx, usageCalls } = makeCtx();
		const payload = JSON.stringify({
			model: "claude-sonnet-4-5",
			usage: { input_tokens: 3, output_tokens: 4 },
		});
		const response = streamedResponse([payload], {
			"content-type": "application/json",
		});

		updateAccountMetadata(makeAccount(), response, ctx, "req-json-2");
		await waitForUsage(usageCalls);

		// The client-facing response must still be fully readable afterwards —
		// extraction consumes the clone the caller made for it, never this one.
		expect(await response.text()).toBe(payload);
	});
});
