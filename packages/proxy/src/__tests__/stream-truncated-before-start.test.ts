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
import {
	type Account,
	NATIVE_RESPONSES_RESPONSE_HEADER,
} from "@clankermux/types";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
	inspectProviderOverload,
	tryAcquireProviderOverloadProbe,
} from "../provider-overload-cooldown";
import type { TransportOutcome } from "../request-recorder";
import { forwardToClient } from "../response-handler";
import {
	classifyNativeResponsesEnd,
	createUsageState,
	expectsMessageStart,
	expectsResponsesTerminal,
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
const RESPONSE_CREATED =
	'event: response.created\ndata: {"type":"response.created","response":{"model":"gpt-5.5"}}\n\n';
const RESPONSE_COMPLETED =
	'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":4}}}\n\n';
const RESPONSE_FAILED =
	'event: response.failed\ndata: {"type":"response.failed","response":{"usage":{"input_tokens":3,"output_tokens":1}}}\n\n';

async function runStream(
	chunks: string[],
	options: {
		path?: string;
		method?: string;
		status?: number;
		contentType?: string;
		providerName?: string;
		/** Sets x-clankermux-responses-native, as the Codex provider does. */
		nativeMarker?: boolean;
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
					...(options.nativeMarker
						? { [NATIVE_RESPONSES_RESPONSE_HEADER]: "1" }
						: {}),
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

	it("does NOT match a native-MARKED response on /v1/messages", () => {
		// Production shape: the /v1/responses adapter rewrites the request to
		// /v1/messages, so the path arm above never fires for real traffic. The
		// marker the Codex provider sets on a native passthrough is the only
		// discriminator left.
		expect(expectsMessageStart({ ...base, nativeResponsesMarker: "1" })).toBe(
			false,
		);
		// Absent / any other value keeps the ordinary Anthropic-SSE contract.
		expect(expectsMessageStart({ ...base, nativeResponsesMarker: null })).toBe(
			true,
		);
		expect(expectsMessageStart({ ...base, nativeResponsesMarker: "0" })).toBe(
			true,
		);
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

describe("expectsResponsesTerminal (the native gate)", () => {
	it("matches only a native-MARKED 200", () => {
		expect(
			expectsResponsesTerminal({ status: 200, nativeResponsesMarker: "1" }),
		).toBe(true);
		expect(
			expectsResponsesTerminal({ status: 502, nativeResponsesMarker: "1" }),
		).toBe(false);
		expect(
			expectsResponsesTerminal({ status: 200, nativeResponsesMarker: null }),
		).toBe(false);
		expect(expectsResponsesTerminal({ status: 200 })).toBe(false);
	});

	it("is the exact complement of expectsMessageStart on a native stream", () => {
		// The native exemption in one gate is what creates the need for the other;
		// if both ever return false for the same response, that stream has no
		// in-band check at all — which is the bug this pair exists to prevent.
		const opts = {
			method: "POST",
			path: "/v1/messages",
			status: 200,
			contentType: "text/event-stream",
			nativeResponsesMarker: "1",
		};
		expect(expectsMessageStart(opts)).toBe(false);
		expect(expectsResponsesTerminal(opts)).toBe(true);
	});
});

describe("classifyNativeResponsesEnd", () => {
	it("returns null for a clean completion", () => {
		expect(
			classifyNativeResponsesEnd({
				sawMessageStop: true,
				responsesTerminalKind: "completed",
			}),
		).toBeNull();
	});

	it("names a failed terminal and a missing terminal differently", () => {
		expect(
			classifyNativeResponsesEnd({
				sawMessageStop: false,
				responsesTerminalKind: "failed",
			}),
		).toBe("native_responses_stream_failed");
		expect(
			classifyNativeResponsesEnd({
				sawMessageStop: false,
				responsesTerminalKind: null,
			}),
		).toBe("native_responses_no_terminal");
	});

	it("treats an incomplete terminal as a NON-error", () => {
		// The backend stopped short and said so. The translated path renders the
		// same condition as Anthropic `stop_reason: "max_tokens"` and records a
		// success; counting it here would fill the error rate with non-incidents
		// and split one upstream condition across two verdicts by internal path.
		expect(
			classifyNativeResponsesEnd({
				sawMessageStop: false,
				responsesTerminalKind: "incomplete",
			}),
		).toBeNull();
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

	it("records a NATIVE stream ending in response.failed as an error", async () => {
		// The backend accepted the request and returned 200 headers, then failed
		// mid-generation. Nothing else in this classifier can see that: the SSE
		// sniffer matches only Anthropic's rate_limit_error / overloaded_error, and
		// expectsMessageStart exempts native streams by construction. Before this
		// the outcome came from the HTTP status alone — a recorded success.
		const calls = await runStream([RESPONSE_CREATED, RESPONSE_FAILED], {
			providerName: "codex",
			nativeMarker: true,
		});
		expect(calls[0].outcome).toBe("error");
		expect(calls[0].reason).toBe("native_responses_stream_failed");
	});

	it("records a NATIVE stream with no terminal at all as an error", async () => {
		const calls = await runStream([RESPONSE_CREATED], {
			providerName: "codex",
			nativeMarker: true,
		});
		expect(calls[0].outcome).toBe("error");
		// Distinct reason from the failed case on purpose: no terminal points at
		// transport or parsing on our side, not at the backend reporting failure.
		expect(calls[0].reason).toBe("native_responses_no_terminal");
	});

	it("still records a healthy NATIVE stream as a success", async () => {
		const calls = await runStream([RESPONSE_CREATED, RESPONSE_COMPLETED], {
			providerName: "codex",
			nativeMarker: true,
		});
		expect(calls[0].outcome).toBe("success");
		expect(calls[0].reason).toBeUndefined();
	});

	it("does not apply the terminal gate to a native-MARKED non-200", async () => {
		// A non-200 already classifies from its status; asserting a Responses
		// completion contract on an error envelope would be wrong.
		const calls = await runStream([RESPONSE_CREATED], {
			providerName: "codex",
			nativeMarker: true,
			status: 502,
		});
		expect(calls[0].outcome).toBe("error");
		expect(calls[0].reason).toBeUndefined();
	});

	it("leaves other SSE paths alone", async () => {
		const calls = await runStream(['data: {"choices":[]}\n\n'], {
			path: "/v1/chat/completions",
		});
		expect(calls[0].outcome).toBe("success");
	});

	it("does NOT close the breaker for a failed NATIVE stream", async () => {
		// The OPPOSITE of the truncation case below, and deliberately so: a
		// `response.failed` can itself carry `server_is_overloaded` or
		// `slow_down`, so treating it as proof the family recovered is exactly
		// backwards. "abandoned" releases the lease WITHOUT closing the breaker,
		// leaving the next request free to probe.
		//
		// This must trip the breaker and hold a real probe lease — asserting on an
		// untouched bucket would pass no matter what the code did.
		clearProviderOverloadCooldown();
		try {
			applyProviderOverloadCooldown("codex", Date.now() + 5, MODEL);
			await new Promise((r) => setTimeout(r, 15));
			expect(inspectProviderOverload("codex", MODEL).state).toBe("half-open");
			const admission = tryAcquireProviderOverloadProbe("codex", MODEL);
			if (!admission.admitted || !admission.token) {
				throw new Error("expected an admitted probe with a token");
			}

			const finishCalls: FinishCall[] = [];
			const response = await forwardToClient(
				{
					requestId: "req-native-failed-probe",
					method: "POST",
					path: "/v1/messages",
					account: makeAccount({ provider: "codex" }),
					requestHeaders: new Headers({ "content-type": "application/json" }),
					requestBody: enc.encode("{}").buffer as ArrayBuffer,
					response: new Response(
						sseStream([RESPONSE_CREATED, RESPONSE_FAILED]),
						{
							status: 200,
							headers: {
								"content-type": "text/event-stream",
								[NATIVE_RESPONSES_RESPONSE_HEADER]: "1",
							},
						},
					),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
					upstreamModel: MODEL,
					overloadProbeToken: admission.token,
				},
				makeCtx(finishCalls, "codex"),
			);
			await response.text();

			expect(finishCalls[0].outcome).toBe("error");
			expect(finishCalls[0].reason).toBe("native_responses_stream_failed");
			// Still half-open — the lease was released, the breaker was NOT closed.
			expect(inspectProviderOverload("codex", MODEL).state).toBe("half-open");
		} finally {
			clearProviderOverloadCooldown();
		}
	});

	it("recognises a terminal named only by its event line", async () => {
		// The backend has been seen sending `event: response.failed` while the
		// payload carries `"type":"error"`. EITHER field is authoritative on its
		// own — a nullish-coalesce over the two would let the non-terminal payload
		// type mask the terminal event name, losing both the usage and the verdict.
		const calls = await runStream(
			[
				RESPONSE_CREATED,
				'event: response.failed\ndata: {"type":"error","error":{"message":"boom"},"response":{"usage":{"input_tokens":2,"output_tokens":1}}}\n\n',
			],
			{ providerName: "codex", nativeMarker: true },
		);
		expect(calls[0].outcome).toBe("error");
		expect(calls[0].reason).toBe("native_responses_stream_failed");
	});

	it("recognises a terminal whose payload carries no usage, model or message", async () => {
		// The usage prefilter skips data lines without `usage` / `message` /
		// `model`, which a terminal can legitimately lack. Skipping one used to
		// cost only a token count; now it would report a finished stream as having
		// no terminal at all.
		const calls = await runStream(
			[
				RESPONSE_CREATED,
				'event: response.failed\ndata: {"type":"response.failed","error":{"code":"server_is_overloaded"}}\n\n',
			],
			{ providerName: "codex", nativeMarker: true },
		);
		expect(calls[0].outcome).toBe("error");
		expect(calls[0].reason).toBe("native_responses_stream_failed");
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
