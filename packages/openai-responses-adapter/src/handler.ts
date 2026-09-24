import crypto from "node:crypto";
import { Logger } from "@clankermux/logger";
import {
	NATIVE_RESPONSES_RESPONSE_HEADER,
	parseUpstreamError,
	setNativeResponsesRequestContext,
} from "@clankermux/types";
import {
	extractNativeTerminalResponse,
	type NativeTerminalFailureReason,
} from "./native-nonstream";
import { translateRequestToAnthropic } from "./request-translator";
import { translateAnthropicResponseToResponses } from "./response-translator";
import { translateAnthropicStreamToResponses } from "./stream-translator";
import {
	createToolTranslation,
	type ToolTranslation,
	ToolTranslationError,
} from "./tool-translation";
import type {
	AnthropicRequest,
	HandleProxyFn,
	ResponseItem,
	ResponsesRequest,
} from "./types";

const log = new Logger("openai-responses-adapter");

/**
 * Upper bound on how much of a FAILED upstream body is buffered before it is
 * parsed for a diagnostic. Error envelopes are tiny and the extracted message
 * is capped at a few hundred characters regardless, so an unbounded read would
 * only let a misbehaving upstream — or an intermediary's HTML error page —
 * pull arbitrary bytes into the handler for nothing.
 */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/**
 * Longest the diagnostic read waits on a failed upstream. The status line is
 * already in hand and the body only ever improves the message, so a body that
 * does not settle is worth less than answering the client: without a bound the
 * handler sits on the request until Bun's idle timeout drops the connection,
 * and the client gets nothing instead of the translated error.
 */
const ERROR_BODY_READ_TIMEOUT_MS = 2_000;

/**
 * Headers copied from the proxy's failed response onto the translated error.
 * Rebuilding the response from the status alone throws away everything the
 * proxy attached about WHEN to come back: the synthetic terminals' pacing, a
 * verbatim upstream `retry-after`, and the pool-restated rate-limit figures a
 * client meters itself against.
 */
const RETRY_GUIDANCE_HEADERS = [
	"retry-after",
	"x-clankermux-pool-status",
	"x-clankermux-burst-retry",
];
const RETRY_GUIDANCE_HEADER_PREFIXES = ["anthropic-ratelimit-", "x-codex-"];

function errorResponseHeaders(upstream: Headers): Headers {
	const headers = new Headers({ "Content-Type": "application/json" });
	upstream.forEach((value, name) => {
		const lower = name.toLowerCase();
		if (
			RETRY_GUIDANCE_HEADERS.includes(lower) ||
			RETRY_GUIDANCE_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
		) {
			headers.set(name, value);
		}
	});
	return headers;
}

/**
 * Reads at most `MAX_ERROR_BODY_BYTES` of a response body as UTF-8, returning
 * "" when the body is missing or nothing arrived before the stream failed.
 *
 * A stream that errors after the headers arrived must not reject the whole
 * request: the status code is still meaningful and the caller can fall back to
 * its generic message. The same applies to whatever is in hand when
 * `ERROR_BODY_READ_TIMEOUT_MS` expires or `signal` aborts.
 *
 * Bytes are copied straight into one fixed-size buffer rather than collected as
 * chunks and merged. A stream may hand back a chunk of any size, so holding
 * whole chunks would let a single oversized one defeat the cap twice over —
 * once retained, once copied — for a string that gets truncated to a few
 * hundred characters anyway.
 */
async function readBoundedText(
	resp: Response,
	signal?: AbortSignal,
): Promise<string> {
	if (!resp.body) return "";
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	let buffer: Uint8Array | null = null;
	let filled = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		// Inside the try: getReader() throws on a body another consumer already
		// locked, and that is the same class of problem as a mid-read failure —
		// the caller still has a usable status and its generic message.
		reader = resp.body.getReader();
		// Raced rather than polled: a read that never settles is exactly the case
		// a `while` condition cannot see.
		const stop = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), ERROR_BODY_READ_TIMEOUT_MS);
			if (signal) {
				if (signal.aborted) {
					resolve(null);
					return;
				}
				onAbort = () => resolve(null);
				signal.addEventListener("abort", onAbort, { once: true });
			}
		});
		while (filled < MAX_ERROR_BODY_BYTES) {
			const next = await Promise.race([reader.read(), stop]);
			if (!next) break;
			const { done, value } = next;
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			if (!buffer) buffer = new Uint8Array(MAX_ERROR_BODY_BYTES);
			const room = MAX_ERROR_BODY_BYTES - filled;
			const take = value.byteLength <= room ? value : value.subarray(0, room);
			buffer.set(take, filled);
			filled += take.byteLength;
		}
	} catch (err) {
		// Keep whatever arrived before the failure: a truncated envelope simply
		// fails to parse and the caller falls back to its generic message.
		log.warn(`Failed to read upstream error body: ${String(err)}`);
	} finally {
		clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		// Signal we are done without awaiting: the response is discarded either
		// way, and an awaited cancel can hang on a stalled upstream. cancel()
		// rejects on an already-errored stream, hence the swallowed catch.
		if (reader) void reader.cancel().catch(() => {});
	}

	if (!buffer || filled === 0) return "";
	return new TextDecoder().decode(buffer.subarray(0, filled));
}

/**
 * Client-facing text for each way the terminal-envelope extraction can fail.
 * Bounded, reason-specific, and derived from nothing the upstream sent — a
 * failed extraction means the upstream bytes are untrustworthy, so none of them
 * are relayed.
 */
const NATIVE_EXTRACTION_MESSAGES: Record<NativeTerminalFailureReason, string> =
	{
		"no-terminal": "Upstream response ended without a terminal Responses event",
		"malformed-terminal": "Upstream sent a malformed terminal Responses event",
		oversized: "Upstream response exceeded the non-streaming size limit",
		"read-error": "Failed to read the upstream response stream",
	};

/**
 * 502 for a native non-streaming attempt whose terminal envelope never
 * materialized. There is deliberately NO fallback to the Anthropic translation
 * path: the body in hand is Codex SSE, so translating it would produce
 * nonsense, and a client that gets an error can retry.
 *
 * A client that walked away is logged at debug, not warn — aborts are routine
 * on this endpoint (Codex CLI cancels freely) and would otherwise storm the
 * warn log with a condition no operator can act on.
 */
function nativeExtractionError(
	reason: NativeTerminalFailureReason,
	req: Request,
): Response {
	const message = NATIVE_EXTRACTION_MESSAGES[reason];
	const line = `Native Responses non-stream extraction failed (${reason})`;
	if (req.signal.aborted) {
		log.debug(`${line} — client aborted`);
	} else {
		log.warn(line);
	}
	return new Response(
		JSON.stringify({
			error: { message, type: "api_error", code: "api_error" },
		}),
		{ status: 502, headers: { "Content-Type": "application/json" } },
	);
}

/**
 * The handle a client uses to read its own request back from
 * `/client/v1/requests/{id}`. `forwardToClient` sets it on the response this
 * adapter receives from `handleProxy`, and every leg below answers with a
 * FRESH Response — so without a deliberate copy the id reaches the client only
 * on the native streaming leg, which forwards the upstream headers verbatim.
 */
const CLIENT_REQUEST_ID_HEADER = "x-clankermux-request-id";

/**
 * One exit for every response this adapter produces, so the request id is
 * applied in a single place rather than at each construction site: the handler
 * answers from a dozen return points and a copy at each one is a copy a future
 * leg can silently omit.
 *
 * Only the id is carried over. The fresh headers each leg builds are what
 * strips the internal native-Responses marker, the account id and the
 * upstream's now-wrong content-type, and that must survive.
 */
export async function handleResponsesRequest(
	req: Request,
	url: URL,
	handleProxy: HandleProxyFn,
	ctx: unknown,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
): Promise<Response> {
	let captured: string | null = null;
	const response = await respondToResponsesRequest(
		req,
		url,
		handleProxy,
		ctx,
		apiKeyId,
		apiKeyName,
		(proxied) => {
			captured = proxied.headers.get(CLIENT_REQUEST_ID_HEADER);
		},
	);
	const requestId: string | null = captured;
	if (requestId) response.headers.set(CLIENT_REQUEST_ID_HEADER, requestId);
	return response;
}

async function respondToResponsesRequest(
	req: Request,
	url: URL,
	handleProxy: HandleProxyFn,
	ctx: unknown,
	apiKeyId: string | null | undefined,
	apiKeyName: string | null | undefined,
	captureProxyResponse: (proxied: Response) => void,
): Promise<Response> {
	// 1. Parse body — Codex CLI compresses request bodies (zstd, gzip, deflate).
	// Bun decompresses response bodies automatically but not request bodies,
	// so we decompress manually when content-encoding is present.
	let rawBody = await req.arrayBuffer();
	const contentEncoding = req.headers.get("content-encoding")?.toLowerCase();
	if (contentEncoding) {
		try {
			const bytes = new Uint8Array(rawBody);
			let decompressed: Uint8Array;
			if (contentEncoding === "zstd") {
				decompressed = Bun.zstdDecompressSync(bytes);
			} else if (contentEncoding === "gzip") {
				decompressed = Bun.gunzipSync(bytes);
			} else if (contentEncoding === "deflate") {
				decompressed = Bun.inflateSync(bytes);
			} else {
				log.warn(`Unsupported content-encoding: ${contentEncoding}`);
				decompressed = bytes;
			}
			rawBody = decompressed.buffer as ArrayBuffer;
		} catch (e) {
			log.warn(`Failed to decompress ${contentEncoding} request body: ${e}`);
		}
	}

	let body: ResponsesRequest;
	try {
		body = JSON.parse(new TextDecoder().decode(rawBody)) as ResponsesRequest;
	} catch {
		return new Response(
			JSON.stringify({
				type: "error",
				error: { type: "invalid_request_error", message: "Invalid JSON body" },
			}),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}

	// 2. Validate & normalise `input` — OpenAI Responses API allows a plain string
	if (!body || (typeof body.input !== "string" && !Array.isArray(body.input))) {
		return new Response(
			JSON.stringify({
				type: "error",
				error: {
					type: "invalid_request_error",
					message: "input: Field required",
				},
			}),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}
	// `stream` selects between two entirely different response legs (raw SSE
	// passthrough vs. terminal-envelope extraction), so a non-boolean must be
	// rejected rather than coerced: `"stream": "false"` is a truthy string and
	// would have silently streamed at a client that asked for one JSON document.
	if ("stream" in body && typeof body.stream !== "boolean") {
		return new Response(
			JSON.stringify({
				type: "error",
				error: {
					type: "invalid_request_error",
					message: "stream: Input should be a valid boolean",
				},
			}),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}
	if (typeof body.input === "string") {
		body = {
			...body,
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: body.input }],
				},
			],
		};
	}

	// `previous_response_id` is intentionally ignored. Codex only sends this
	// field over its WebSocket path (see codex-rs/core/src/client.rs:get_incremental_items).
	// For regular HTTP /v1/responses requests Codex always includes the full
	// conversation history in `input`, so there is nothing to resolve here.

	// 3. Generate response ID
	const responseId = `resp_${crypto.randomBytes(12).toString("hex")}`;

	// 4. Translate to Anthropic format
	let tools: ToolTranslation;
	let anthropicBody: AnthropicRequest;
	try {
		tools = createToolTranslation(body);
		anthropicBody = translateRequestToAnthropic(
			body as typeof body & { input: ResponseItem[] },
			tools,
		);
	} catch (err) {
		return Response.json(
			{
				error: {
					type: "invalid_request_error",
					code: "invalid_request_error",
					message:
						err instanceof ToolTranslationError
							? err.message
							: "Invalid Responses tools or conversation input",
				},
			},
			{ status: 400 },
		);
	}

	// 5. Build synthetic request targeting /v1/messages
	const messagesUrl = new URL(url.toString());
	messagesUrl.pathname = "/v1/messages";
	const syntheticHeaders = new Headers(req.headers);
	syntheticHeaders.set("content-type", "application/json");
	syntheticHeaders.delete("content-length");
	// Body is now decompressed plain JSON — remove the original encoding hint.
	syntheticHeaders.delete("content-encoding");
	// Required by Anthropic API — Codex CLI doesn't send this header.
	if (!syntheticHeaders.has("anthropic-version")) {
		syntheticHeaders.set("anthropic-version", "2023-06-01");
	}
	const syntheticReq = new Request(messagesUrl.toString(), {
		method: "POST",
		headers: syntheticHeaders,
		body: JSON.stringify(anthropicBody),
		// Carry the CLIENT's abort signal. Without it every downstream
		// `req.signal.aborted` check sees a fresh, never-aborted signal, so
		// /v1/responses (Codex CLI traffic) is invisible to all of the proxy's
		// client-abort guards: an abandoned request runs to completion upstream and
		// its terminal is reported as a server-side failure rather than a
		// disconnect. This is a real change in cancellation semantics for this
		// endpoint — it stops burning Codex quota on requests nobody is waiting on.
		signal: req.signal,
	});
	// Native Responses passthrough (Stage A): carry the original (normalized)
	// Responses body alongside the translated request. When the proxy selects a
	// codex account it forwards this body verbatim instead of double-translating
	// — handleProxy re-keys it onto RequestMeta. The client's own stream intent
	// is not part of that decision (see step 8): the upstream leg is SSE either
	// way, so it stays a property of `body` here in the adapter.
	setNativeResponsesRequestContext(syntheticReq, {
		nativeBody: JSON.stringify(body),
		// Captured from the ORIGINAL body before translation; the real effort
		// vocabulary is wider than the narrow type in types.ts, so treat it as an
		// arbitrary string.
		reasoningEffort:
			typeof body.reasoning?.effort === "string" ? body.reasoning.effort : null,
		promptCacheKey:
			typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : null,
		// A Responses client is not Claude Code, and an official Claude account
		// used outside Claude Code risks a ban. Such an account may answer this
		// request only by running real Claude Code through the SDK bridge; with
		// no bridge the proxy excludes it. Unconditional: independent of any
		// API-key pin, which can narrow routing further on top.
		denyDirectOfficialAnthropic: true,
		translationGaps: {
			maxTokensDefaulted: body.max_output_tokens === undefined,
			droppedFields: (["temperature", "top_p"] as const).filter(
				(field) => (body as unknown as Record<string, unknown>)[field] != null,
			),
		},
	});

	// 6. Forward to proxy
	log.info(`Forwarding responses request to ${messagesUrl.pathname}`);
	let anthropicResp: Response;
	try {
		anthropicResp = await handleProxy(
			syntheticReq,
			messagesUrl,
			ctx,
			apiKeyId,
			apiKeyName,
		);
		captureProxyResponse(anthropicResp);
	} catch (err) {
		const statusCode =
			typeof err === "object" &&
			err !== null &&
			"statusCode" in err &&
			typeof (err as { statusCode: unknown }).statusCode === "number"
				? (err as { statusCode: number }).statusCode
				: 503;
		const isUnavailable = statusCode === 503;
		// The give-up terminals attach their re-check interval to the error, and
		// this leg has to pace its 503 exactly as the /v1/messages leg does or a
		// Codex retry loop is the only client left with no guidance.
		//
		// Unlike `statusCode` above, this value is computed rather than a literal,
		// and `Retry-After` takes whole seconds: anything that is not a positive
		// integer would reach the client as `NaN`, `Infinity` or `-1` and make the
		// header worse than absent. Only a 503 carries it, matching the dispatcher.
		const rawRetryAfter =
			typeof err === "object" && err !== null && "retryAfterSeconds" in err
				? (err as { retryAfterSeconds: unknown }).retryAfterSeconds
				: undefined;
		const retryAfterSeconds =
			isUnavailable &&
			typeof rawRetryAfter === "number" &&
			Number.isInteger(rawRetryAfter) &&
			rawRetryAfter > 0
				? rawRetryAfter
				: undefined;
		return new Response(
			JSON.stringify({
				error: {
					message: isUnavailable
						? "Service temporarily unavailable. Please try again later."
						: "Proxy request failed",
					type: isUnavailable ? "server_error" : "api_error",
					code: isUnavailable ? "server_error" : "api_error",
					...(retryAfterSeconds === undefined
						? {}
						: { availability_guaranteed: false }),
				},
			}),
			{
				status: statusCode,
				headers:
					retryAfterSeconds === undefined
						? { "Content-Type": "application/json" }
						: {
								"Content-Type": "application/json",
								"Retry-After": String(retryAfterSeconds),
							},
			},
		);
	}

	// 7. Translate non-200 Anthropic errors to OpenAI error shape
	if (anthropicResp.status !== 200) {
		// The proxy forwards a failed upstream response VERBATIM, so this body is
		// not necessarily an Anthropic envelope: on a codex account it is whatever
		// the ChatGPT backend raised, typically FastAPI's
		// `{"detail":"Unsupported parameter: max_output_tokens"}`. Reading only
		// `error.message` reduced every one of those to the constant
		// "Unknown error" and destroyed the sole copy of the diagnostic the
		// client ever sees (issue #5).
		//
		// Read the body once and parse it twice: once for the typed `error.type`,
		// and once through the shared envelope parser for the message.
		// `error.message` still wins when present so an Anthropic error reaches
		// the client exactly as before, unprefixed by its type.
		// parseUpstreamError is used rather than a raw-body excerpt deliberately:
		// it emits only what upstream put in a recognized error field, never
		// arbitrary bytes, so tokens or echoed prompt text in an unrecognized
		// body cannot be relayed to the caller.
		//
		// Neither parse is gated on the content-type header. Upstreams mislabel
		// error responses (a 401 `{"detail":"Not authenticated"}` sent as
		// text/plain is real), and JSON.parse is the authoritative test of
		// whether a body is JSON anyway.
		const rawErrorBody = await readBoundedText(anthropicResp, req.signal);
		let errType = "api_error";
		let errCode: string | null = null;
		let message: string | null = null;

		try {
			const anthropicError = JSON.parse(rawErrorBody) as {
				type?: string;
				error?: { type?: string; message?: string; code?: unknown };
			};
			// Blank values count as absent: an empty `error.message` used to
			// win over the fallback and emit an error with no text at all.
			if (anthropicError?.error?.type?.trim()) {
				errType = anthropicError.error.type.trim();
			}
			if (anthropicError?.error?.message?.trim()) {
				message = anthropicError.error.message;
			}
			const code = anthropicError?.error?.code;
			if (typeof code === "string" && code.trim())
				errCode = code.trim().slice(0, 128);
		} catch {
			// Not JSON (or malformed) — fall through to the shared parser, which
			// tolerates anything and returns null when it recognizes nothing.
		}

		const errorBody = {
			error: {
				message: message ?? parseUpstreamError(rawErrorBody) ?? "Unknown error",
				type: errType,
				code: errCode ?? errType,
			},
		};
		return new Response(JSON.stringify(errorBody), {
			status: anthropicResp.status,
			headers: errorResponseHeaders(anthropicResp.headers),
		});
	}

	// 8. Native Responses passthrough (Stage B, response leg): on a codex-native
	// attempt the proxy returns the backend's RAW Codex-Responses SSE marked
	// with the internal marker header (only ever set on status 200 — non-200s
	// were error-translated above). The body is already genuine Responses SSE
	// (response.created / response.output_text.delta / response.completed, with
	// the backend's own response id).
	//
	// The marker says nothing about what the CLIENT asked for: the upstream
	// transport is SSE either way (the provider forces `stream: true`), so this
	// branch owns both legs. A streaming client gets the bytes AS-IS — no
	// translation, no responseId substitution — minus the internal marker. A
	// non-streaming client gets the terminal event's `response` envelope
	// extracted from that same SSE, which is the same document the backend would
	// have returned had it been asked for JSON.
	if (anthropicResp.headers.get(NATIVE_RESPONSES_RESPONSE_HEADER) === "1") {
		if (anthropicResp.body === null) {
			// A marked 200 with no body at all: there is no terminal event to find
			// and nothing to pass through. Fail loudly rather than hand the client
			// an empty success.
			return nativeExtractionError("no-terminal", req);
		}
		if (body.stream === true) {
			const passthroughHeaders = new Headers(anthropicResp.headers);
			passthroughHeaders.delete(NATIVE_RESPONSES_RESPONSE_HEADER);
			return new Response(anthropicResp.body, {
				status: anthropicResp.status,
				statusText: anthropicResp.statusText,
				headers: passthroughHeaders,
			});
		}

		const extracted = await extractNativeTerminalResponse(anthropicResp.body, {
			signal: req.signal,
		});
		if (!extracted.ok) {
			return nativeExtractionError(extracted.reason, req);
		}
		// Fresh headers, exactly like the JSON translation path below: that is what
		// strips the internal marker, every other x-clankermux-* header, and the
		// upstream's now-wrong SSE content-type / content-length.
		return new Response(extracted.responseJson, {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	// 9. Stream path
	if (body.stream) {
		return translateAnthropicStreamToResponses(
			anthropicResp,
			responseId,
			body.model,
			tools,
		);
	}

	// 10. Non-stream path
	let respBody: unknown;
	try {
		respBody = await anthropicResp.json();
	} catch {
		return new Response(
			JSON.stringify({
				error: {
					message: "Failed to parse upstream response",
					type: "api_error",
					code: "api_error",
				},
			}),
			{ status: 502, headers: { "Content-Type": "application/json" } },
		);
	}
	try {
		const translated = translateAnthropicResponseToResponses(
			respBody as Parameters<typeof translateAnthropicResponseToResponses>[0],
			responseId,
			body.model,
			tools,
		);
		return Response.json(translated);
	} catch {
		return Response.json(
			{
				error: {
					message:
						"Upstream returned invalid tool arguments or response content",
					type: "api_error",
					code: "invalid_upstream_response",
				},
			},
			{ status: 502 },
		);
	}
}
