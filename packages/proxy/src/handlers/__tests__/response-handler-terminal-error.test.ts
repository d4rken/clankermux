/**
 * Terminal-event-aware stream-error classification.
 *
 * A stream whose terminal event was already parsed (`message_stop` for
 * Anthropic SSE, `response.completed` for the Codex native path — both set
 * `sawMessageStop`) delivered the complete response to the client. If the
 * upstream read THEN errors instead of returning a clean `done: true` — seen at
 * 55–93% rates on Codex passthrough streams under the Bun 1.4 canary, whose
 * Rust HTTP client surfaces the ChatGPT backend's abrupt post-response
 * connection close as a read error where Bun 1.3.14 reported EOF — the request
 * must still be recorded as what the client observed: a complete success, with
 * the provider's reported token counts (NOT the bytes/4 truncation fallback,
 * which inflated reasoning-heavy Codex streams up to ~180x).
 *
 * Streams that error WITHOUT having seen their terminal event keep the
 * existing error classification and the bytes/4 anti-undercount fallback.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Account } from "@clankermux/types";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
	inspectProviderOverload,
	tryAcquireProviderOverloadProbe,
} from "../../provider-overload-cooldown";
import { forwardToClient } from "../../response-handler";
import { clearAnthropicBurstThrottle } from "../burst-cooldown";
import type { ProxyContext } from "../proxy-types";

const enc = new TextEncoder();

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acct-term-1",
		name: "terminal-error-test",
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
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	} as Account;
}

interface RecorderCalls {
	finishTransport: Array<{
		requestId: string;
		outcome: string;
		errorMessage?: string;
	}>;
	summaries: Array<{
		requestId: string;
		outputTokens: number;
		outputApproximate?: boolean;
	}>;
}

function makeStreamCtx(providerName = "anthropic"): {
	ctx: ProxyContext;
	calls: RecorderCalls;
} {
	const calls: RecorderCalls = { finishTransport: [], summaries: [] };
	const ctx = {
		dbOps: {
			markAccountRateLimited: () => Promise.resolve(1),
			markAccountRateLimitedDeadlineOnly: () => Promise.resolve(),
			updateAccountUsage: () => {},
			updateAccountRateLimitMeta: () => {},
			getAdapter: () => ({
				get: async () => ({ rate_limited_until: null }),
				run: async () => {},
			}),
			updateRequestUsage: async () => {},
		},
		runtime: { port: 8080, tlsEnabled: false },
		config: { getStorePayloads: () => false },
		provider: { name: providerName, isStreamingResponse: () => true },
		refreshInFlight: new Map<string, Promise<string>>(),
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				void job();
				return Promise.resolve();
			},
		},
		requestRecorder: {
			begin: () => {},
			captureResponseChunk: () => {},
			finishTransport: (
				requestId: string,
				outcome: string,
				errorMessage?: string,
			) => {
				calls.finishTransport.push({ requestId, outcome, errorMessage });
			},
			attachUsageSummary: (
				requestId: string,
				summary: {
					usage: { outputTokens: number };
					outputApproximate?: boolean;
				},
			) => {
				calls.summaries.push({
					requestId,
					outputTokens: summary.usage.outputTokens,
					outputApproximate: summary.outputApproximate,
				});
			},
			markUsageUnavailable: () => {},
			recordSynthetic: () => {},
			sweep: () => {},
			dispose: () => {},
		},
	} as unknown as ProxyContext;
	return { ctx, calls };
}

/**
 * Pull-based source: serves one chunk per read (matching real network
 * delivery), then errors — or hangs open for client-cancel tests. A start()-
 * based source that enqueues everything and then calls controller.error()
 * would DISCARD its queued chunks (spec: error() clears the queue), so the
 * analytics would never see a single byte.
 */
function streamFrom(
	chunks: string[],
	end: { error?: Error; hang?: boolean } = {},
): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i < chunks.length) {
				controller.enqueue(enc.encode(chunks[i] as string));
				i++;
			} else if (end.error) {
				controller.error(end.error);
			} else if (!end.hang) {
				controller.close();
			}
		},
	});
}

/** Padding deltas so bytes/4 would dwarf the provider count if it wrongly won. */
function codexChunks(opts: {
	terminalEvent: boolean;
	unterminatedFinalLine?: boolean;
}): string[] {
	const chunks = [
		'event: response.created\ndata: {"type":"response.created","response":{"model":"gpt-5.6-sol"}}\n\n',
	];
	for (let i = 0; i < 20; i++) {
		chunks.push(
			`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"${"x".repeat(400)}"}\n\n`,
		);
	}
	if (opts.terminalEvent) {
		const completed =
			'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-5.6-sol","usage":{"input_tokens":9008,"input_tokens_details":{"cached_tokens":8473},"output_tokens":135,"total_tokens":9143}}}';
		chunks.push(opts.unterminatedFinalLine ? completed : `${completed}\n\n`);
	}
	return chunks;
}

function anthropicChunks(opts: { messageStop: boolean }): string[] {
	const chunks = [
		'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":50,"output_tokens":1}}}\n\n',
	];
	for (let i = 0; i < 20; i++) {
		chunks.push(
			`event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"${"y".repeat(400)}"}}\n\n`,
		);
	}
	chunks.push(
		'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n',
	);
	if (opts.messageStop) {
		chunks.push('event: message_stop\ndata: {"type":"message_stop"}\n\n');
	}
	return chunks;
}

const readError = () => new Error("connection closed unexpectedly");

function codexStream(opts: {
	terminalEvent: boolean;
	unterminatedFinalLine?: boolean;
}): ReadableStream<Uint8Array> {
	return streamFrom(codexChunks(opts), { error: readError() });
}

function anthropicStream(opts: {
	messageStop: boolean;
}): ReadableStream<Uint8Array> {
	return streamFrom(anthropicChunks(opts), { error: readError() });
}

function forward(
	body: ReadableStream<Uint8Array>,
	ctx: ProxyContext,
	opts: {
		requestId: string;
		nativeResponses?: boolean;
		overloadProbeToken?: unknown;
	},
) {
	const headers: Record<string, string> = {
		"content-type": "text/event-stream",
	};
	if (opts.nativeResponses) headers["x-clankermux-responses-native"] = "1";
	return forwardToClient(
		{
			requestId: opts.requestId,
			method: "POST",
			path: "/v1/messages",
			account: makeAccount(),
			requestHeaders: new Headers({ "content-type": "application/json" }),
			requestBody: enc.encode("{}").buffer as ArrayBuffer,
			response: new Response(body, { status: 200, headers }),
			timestamp: Date.now(),
			retryAttempt: 0,
			failoverAttempts: 0,
			// biome-ignore lint/suspicious/noExplicitAny: probe token is opaque here
			overloadProbeToken: (opts.overloadProbeToken as any) ?? null,
		},
		ctx,
	);
}

/** Drain the client stream, swallowing the propagated read error. */
async function drain(response: Response): Promise<void> {
	try {
		await response.text();
	} catch {
		// the wrapper propagates the upstream read error to the client — expected
	}
	// let the tracked finalize promise settle
	await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
	clearAnthropicBurstThrottle();
	clearProviderOverloadCooldown();
});
afterEach(() => {
	clearAnthropicBurstThrottle();
	clearProviderOverloadCooldown();
});

describe("stream read error AFTER the terminal event → recorded as success", () => {
	it("Codex native passthrough: response.completed seen → success + provider token count", async () => {
		const { ctx, calls } = makeStreamCtx("codex");
		const response = await forward(codexStream({ terminalEvent: true }), ctx, {
			requestId: "req-term-codex",
			nativeResponses: true,
		});
		await drain(response);

		expect(calls.finishTransport).toHaveLength(1);
		expect(calls.finishTransport[0]?.outcome).toBe("success");
		expect(calls.summaries).toHaveLength(1);
		// Provider-reported count, NOT max(provider, bytes/4): the padding deltas
		// above make bytes/4 ≈ 2000+, so any inflation fails this assertion.
		expect(calls.summaries[0]?.outputTokens).toBe(135);
		expect(calls.summaries[0]?.outputApproximate).toBeFalsy();
	});

	it("Anthropic SSE: message_stop seen → success + provider token count", async () => {
		const { ctx, calls } = makeStreamCtx("anthropic");
		const response = await forward(
			anthropicStream({ messageStop: true }),
			ctx,
			{
				requestId: "req-term-anthropic",
			},
		);
		await drain(response);

		expect(calls.finishTransport).toHaveLength(1);
		expect(calls.finishTransport[0]?.outcome).toBe("success");
		expect(calls.summaries[0]?.outputTokens).toBe(42);
		expect(calls.summaries[0]?.outputApproximate).toBeFalsy();
	});

	it("abrupt close mid-line: terminal event WITHOUT trailing newline is flushed and still counts", async () => {
		// The provider closed right after the last data byte — the terminal
		// `response.completed` line is sitting unterminated in the SSE line
		// buffer when the read error hits. onError must flush before classifying
		// (mirrors the onEnd ordering rationale).
		const { ctx, calls } = makeStreamCtx("codex");
		const response = await forward(
			codexStream({ terminalEvent: true, unterminatedFinalLine: true }),
			ctx,
			{ requestId: "req-term-flush", nativeResponses: true },
		);
		await drain(response);

		expect(calls.finishTransport[0]?.outcome).toBe("success");
		expect(calls.summaries[0]?.outputTokens).toBe(135);
	});

	it("client disconnect after the terminal event → outcome stays 'disconnect' but provider counts are trusted", async () => {
		// An ENQUEUED terminal chunk does not prove the client consumed it, so the
		// transport outcome stays truthful — but the terminal event makes the
		// provider's token counts authoritative (no bytes/4 inflation).
		const { ctx, calls } = makeStreamCtx("codex");
		// Terminal event, then the stream stays open (no error) — the CLIENT cancels.
		const body = streamFrom(
			[
				'event: response.created\ndata: {"type":"response.created","response":{"model":"gpt-5.6-sol"}}\n\n',
				'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":7,"total_tokens":17}}}\n\n',
			],
			{ hang: true },
		);
		const response = await forward(body, ctx, {
			requestId: "req-term-cancel",
			nativeResponses: true,
		});
		const reader = (response.body as ReadableStream<Uint8Array>).getReader();
		await reader.read();
		await reader.read();
		await reader.cancel();
		await new Promise((r) => setTimeout(r, 20));

		expect(calls.finishTransport).toHaveLength(1);
		expect(calls.finishTransport[0]?.outcome).toBe("disconnect");
		expect(calls.summaries[0]?.outputTokens).toBe(7);
		expect(calls.summaries[0]?.outputApproximate).toBeFalsy();
	});

	it("a fired in-band error frame wins: terminal event + rate_limit_error frame → stays 'error'", async () => {
		// Protocol-invalid but defensive: if the sniffer fired mid-stream, neither
		// the transport reclassification nor the count trust applies.
		const { ctx, calls } = makeStreamCtx("anthropic");
		const chunks = [
			'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":50,"output_tokens":1}}}\n\n',
			'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"x"}}\n\n',
			'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		];
		const response = await forward(
			streamFrom(chunks, { error: readError() }),
			ctx,
			{ requestId: "req-term-sniffer" },
		);
		await drain(response);

		expect(calls.finishTransport[0]?.outcome).toBe("error");
	});

	it("reclassified probe stream closes the overload bucket (recovered, like a clean EOF)", async () => {
		const account = makeAccount();
		// Trip the family bucket, let the short cooldown lapse → half-open, then
		// acquire the probe lease (mirrors tripToHalfOpen in
		// overload-probe-lifecycle.test.ts).
		applyProviderOverloadCooldown(
			account.provider,
			Date.now() + 5,
			"claude-sonnet-5",
		);
		await new Promise((r) => setTimeout(r, 15));
		expect(
			inspectProviderOverload(account.provider, "claude-sonnet-5").state,
		).toBe("half-open");
		const admission = tryAcquireProviderOverloadProbe(
			account.provider,
			"claude-sonnet-5",
		);
		expect(admission.admitted).toBe(true);

		const { ctx, calls } = makeStreamCtx("anthropic");
		const response = await forward(
			anthropicStream({ messageStop: true }),
			ctx,
			{
				requestId: "req-term-probe",
				overloadProbeToken: admission.admitted ? admission.token : null,
			},
		);
		await drain(response);

		expect(calls.finishTransport[0]?.outcome).toBe("success");
		expect(
			inspectProviderOverload(account.provider, "claude-sonnet-5").state,
		).toBe("closed");
	});
});

describe("stream read error WITHOUT the terminal event → unchanged error path", () => {
	it("Codex: no response.completed → outcome 'error' + bytes/4 approximate output", async () => {
		const { ctx, calls } = makeStreamCtx("codex");
		const response = await forward(codexStream({ terminalEvent: false }), ctx, {
			requestId: "req-noterm-codex",
			nativeResponses: true,
		});
		await drain(response);

		expect(calls.finishTransport).toHaveLength(1);
		expect(calls.finishTransport[0]?.outcome).toBe("error");
		expect(calls.summaries).toHaveLength(1);
		// bytes/4 anti-undercount fallback stays for genuinely truncated streams
		expect(calls.summaries[0]?.outputTokens).toBeGreaterThan(1000);
		expect(calls.summaries[0]?.outputApproximate).toBe(true);
	});

	it("Anthropic: no message_stop → outcome 'error'", async () => {
		const { ctx, calls } = makeStreamCtx("anthropic");
		const response = await forward(
			anthropicStream({ messageStop: false }),
			ctx,
			{ requestId: "req-noterm-anthropic" },
		);
		await drain(response);

		expect(calls.finishTransport[0]?.outcome).toBe("error");
		// provider reported 42 via message_delta but the stream died after it —
		// max(42, bytes/4) wins with the padding, flagged approximate
		expect(calls.summaries[0]?.outputTokens).toBeGreaterThan(42);
		expect(calls.summaries[0]?.outputApproximate).toBe(true);
	});
});
