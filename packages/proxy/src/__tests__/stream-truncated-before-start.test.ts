/**
 * A streaming `/v1/messages` 200 that dies before `message_start` was recorded
 * as a SUCCESS.
 *
 * `forwardToClient` computed its outcome upfront from path + status only, so a
 * Bun-clean `done:true` close midway through the content still produced
 * `success=1` — with a NULL model and NULL token counts, because the stream
 * never produced anything to count. Measured at 7 rows in 7 days out of 72,357
 * `/v1/messages` 200s.
 *
 * The existing missing-`message_stop` diagnostic cannot see these: it requires
 * `providerReportedOutput === true`, which a stream that died before
 * `message_start` can never reach.
 */
import { describe, expect, it } from "bun:test";
import type { Account } from "@clankermux/types";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
	inspectProviderOverload,
	tryAcquireProviderOverloadProbe,
} from "../provider-overload-cooldown";
import type { TransportOutcome } from "../request-recorder";
import { forwardToClient } from "../response-handler";
import {
	createUsageState,
	expectsMessageStart,
	feedChunk,
	flushPendingSseLine,
} from "../usage-collector";

const enc = new TextEncoder();
const MODEL = "claude-haiku-4-5";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "account",
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
		notes: null,
		refresh_token_issued_at: null,
		...overrides,
	} as Account;
}

type FinishCall = { outcome: TransportOutcome; reason: string | undefined };

function makeCtx(finishCalls: FinishCall[], providerName = "anthropic") {
	return {
		strategy: {},
		dbOps: {
			markAccountRateLimited: async () => 1,
			markAccountRateLimitedDeadlineOnly: async () => {},
			updateAccountUsage: () => {},
			updateAccountRateLimitMeta: () => {},
			updateRequestUsage: async () => {},
			getAdapter: () => ({
				get: async () => ({ rate_limited_until: null }),
				run: async () => {},
			}),
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
				_id: string,
				outcome: TransportOutcome,
				reason?: string,
			) => {
				finishCalls.push({ outcome, reason });
			},
			attachUsageSummary: () => {},
			markUsageUnavailable: () => {},
		},
	} as never;
}

/** An SSE stream of raw chunks that closes cleanly (Bun `done:true`). */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const c of chunks) controller.enqueue(enc.encode(c));
			controller.close();
		},
	});
}

const MESSAGE_START =
	'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":5}}}\n\n';
const MESSAGE_DELTA =
	'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n';
const MESSAGE_STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

async function runStream(
	chunks: string[],
	options: {
		path?: string;
		method?: string;
		status?: number;
		contentType?: string;
		providerName?: string;
	} = {},
): Promise<FinishCall[]> {
	const finishCalls: FinishCall[] = [];
	const response = await forwardToClient(
		{
			requestId: `req-${Math.random()}`,
			method: options.method ?? "POST",
			path: options.path ?? "/v1/messages",
			account: makeAccount(),
			requestHeaders: new Headers({ "content-type": "application/json" }),
			requestBody: enc.encode("{}").buffer as ArrayBuffer,
			response: new Response(sseStream(chunks), {
				status: options.status ?? 200,
				headers: {
					"content-type": options.contentType ?? "text/event-stream",
				},
			}),
			timestamp: Date.now(),
			retryAttempt: 0,
			failoverAttempts: 0,
		},
		makeCtx(finishCalls, options.providerName),
	);
	// Drain so the single-reader passthrough runs the inline analytics.
	await response.text();
	return finishCalls;
}

describe("expectsMessageStart (the gate)", () => {
	const base = {
		method: "POST",
		path: "/v1/messages",
		status: 200,
		contentType: "text/event-stream",
	};

	it("matches a streaming POST /v1/messages 200", () => {
		expect(expectsMessageStart(base)).toBe(true);
		expect(
			expectsMessageStart({
				...base,
				contentType: "text/event-stream; charset=utf-8",
			}),
		).toBe(true);
	});

	it("does NOT match the native Codex Responses path", () => {
		// A healthy native Codex stream speaks response.created / response.completed
		// and never emits message_start — a broad "any SSE" gate would record every
		// one of them as truncated.
		expect(expectsMessageStart({ ...base, path: "/v1/responses" })).toBe(false);
	});

	it("does NOT match other SSE paths, non-200s, non-POSTs or non-SSE bodies", () => {
		expect(expectsMessageStart({ ...base, path: "/v1/chat/completions" })).toBe(
			false,
		);
		expect(
			expectsMessageStart({ ...base, path: "/v1/messages/count_tokens" }),
		).toBe(false);
		expect(expectsMessageStart({ ...base, status: 201 })).toBe(false);
		expect(expectsMessageStart({ ...base, method: "GET" })).toBe(false);
		expect(
			expectsMessageStart({ ...base, contentType: "application/json" }),
		).toBe(false);
		expect(expectsMessageStart({ ...base, contentType: null })).toBe(false);
	});
});

describe("UsageState.sawMessageStart", () => {
	it("is set by a message_start event and stays false without one", () => {
		const withStart = createUsageState();
		feedChunk(withStart, enc.encode(MESSAGE_START), Date.now());
		expect(withStart.sawMessageStart).toBe(true);

		const without = createUsageState();
		feedChunk(without, enc.encode("event: ping\ndata: {}\n\n"), Date.now());
		expect(without.sawMessageStart).toBe(false);
	});

	it("is set by a FINAL message_start with no trailing newline, once flushed", () => {
		// The ordering trap: the buffered trailing line is only parsed by the flush,
		// so classifying before it would call a complete stream truncated.
		const state = createUsageState();
		feedChunk(state, enc.encode(MESSAGE_START.trimEnd()), Date.now());
		expect(state.sawMessageStart).toBe(false);
		flushPendingSseLine(state);
		expect(state.sawMessageStart).toBe(true);
	});
});

describe("forwardToClient — premature SSE termination", () => {
	it("records a stream that died before message_start as an error, not a success", async () => {
		const calls = await runStream([
			"event: ping\ndata: {}\n\n",
			": keep-alive\n\n",
		]);
		expect(calls).toHaveLength(1);
		expect(calls[0].outcome).toBe("error");
		expect(calls[0].reason).toBe("stream_truncated_mid_content");
	});

	it("records a stream with no bytes at all as an error", async () => {
		const calls = await runStream([]);
		expect(calls[0].outcome).toBe("error");
		expect(calls[0].reason).toBe("stream_truncated_mid_content");
	});

	it("records a complete stream as a success", async () => {
		const calls = await runStream([MESSAGE_START, MESSAGE_DELTA, MESSAGE_STOP]);
		expect(calls[0].outcome).toBe("success");
		expect(calls[0].reason).toBeUndefined();
	});

	it("does NOT misclassify a final message_start that lacks a trailing newline", async () => {
		// Classification happens AFTER the flush, so the buffered last line counts.
		const calls = await runStream([MESSAGE_START.trimEnd()]);
		expect(calls[0].outcome).toBe("success");
		expect(calls[0].reason).toBeUndefined();
	});

	it("leaves a NATIVE Codex /v1/responses stream alone", async () => {
		// response.created / response.completed, no message_start anywhere — and a
		// perfectly healthy stream.
		const calls = await runStream(
			[
				'event: response.created\ndata: {"type":"response.created","response":{"model":"gpt-5.5"}}\n\n',
				'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":4}}}\n\n',
			],
			{ path: "/v1/responses", providerName: "codex" },
		);
		expect(calls[0].outcome).toBe("success");
		expect(calls[0].reason).toBeUndefined();
	});

	it("leaves other SSE paths alone", async () => {
		const calls = await runStream(['data: {"choices":[]}\n\n'], {
			path: "/v1/chat/completions",
		});
		expect(calls[0].outcome).toBe("success");
	});

	it("keeps the in-band SSE error frame as the more specific diagnosis", async () => {
		// A rate_limit_error frame arrives before any message_start; the sniffer's
		// reason must win over the truncation reason.
		const calls = await runStream([
			'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"x"}}\n\n',
		]);
		expect(calls[0].outcome).toBe("error");
		expect(calls[0].reason).toBe("rate_limit_error");
	});

	it("still marks the overload probe RECOVERED for a truncated stream (deliberate coupling)", async () => {
		// A truncated stream still means the provider returned 200 headers and
		// streamed bytes, which IS evidence the family is not overloaded. The probe
		// verdict is deliberately NOT tied to the truncation check — marking it
		// "abandoned" would keep a healthy bucket half-open for no reason. Pinned
		// here so the coupling stays a decision rather than an accident.
		clearProviderOverloadCooldown();
		try {
			applyProviderOverloadCooldown("anthropic", Date.now() + 5, MODEL);
			await new Promise((r) => setTimeout(r, 15));
			expect(inspectProviderOverload("anthropic", MODEL).state).toBe(
				"half-open",
			);
			const admission = tryAcquireProviderOverloadProbe("anthropic", MODEL);
			if (!admission.admitted || !admission.token) {
				throw new Error("expected an admitted probe with a token");
			}

			const finishCalls: FinishCall[] = [];
			const response = await forwardToClient(
				{
					requestId: "req-truncated-probe",
					method: "POST",
					path: "/v1/messages",
					account: makeAccount(),
					requestHeaders: new Headers({ "content-type": "application/json" }),
					requestBody: enc.encode("{}").buffer as ArrayBuffer,
					response: new Response(sseStream(["event: ping\ndata: {}\n\n"]), {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
					upstreamModel: MODEL,
					overloadProbeToken: admission.token,
				},
				makeCtx(finishCalls),
			);
			await response.text();

			// The row is an error…
			expect(finishCalls[0].outcome).toBe("error");
			expect(finishCalls[0].reason).toBe("stream_truncated_mid_content");
			// …but the breaker CLOSED: the probe recovered.
			expect(inspectProviderOverload("anthropic", MODEL).state).toBe("closed");
		} finally {
			clearProviderOverloadCooldown();
		}
	});
});
