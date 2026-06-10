import crypto from "node:crypto";
import { Logger } from "@clankermux/logger";
import {
	NATIVE_RESPONSES_RESPONSE_HEADER,
	setNativeResponsesRequestContext,
} from "@clankermux/types";
import { translateRequestToAnthropic } from "./request-translator";
import { translateAnthropicResponseToResponses } from "./response-translator";
import { translateAnthropicStreamToResponses } from "./stream-translator";
import type { HandleProxyFn, ResponseItem, ResponsesRequest } from "./types";

const log = new Logger("openai-responses-adapter");

export async function handleResponsesRequest(
	req: Request,
	url: URL,
	handleProxy: HandleProxyFn,
	ctx: unknown,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
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
	const anthropicBody = translateRequestToAnthropic(
		body as typeof body & { input: ResponseItem[] },
	);

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
	// Codex CLI traffic must NEVER land on an official Claude account — Anthropic
	// bans OAuth tokens used outside Claude CLI, and a Claude model answering is
	// not a cross-model review. This floor is UNCONDITIONAL (independent of any
	// API-key pin or auth config): the proxy drops official-Anthropic accounts
	// from selection for this request and disables the Anthropic-only burst-hold.
	// A key pinned to the Codex account/class further constrains routing on top.
	syntheticHeaders.set("x-clankermux-deny-official-anthropic", "1");
	const syntheticReq = new Request(messagesUrl.toString(), {
		method: "POST",
		headers: syntheticHeaders,
		body: JSON.stringify(anthropicBody),
	});
	// Native Responses passthrough (Stage A): carry the original (normalized)
	// Responses body alongside the translated request. When the proxy selects a
	// codex account for a streaming client, it forwards this body verbatim
	// instead of double-translating — handleProxy re-keys it onto RequestMeta.
	setNativeResponsesRequestContext(syntheticReq, {
		nativeBody: JSON.stringify(body),
		clientStream: body.stream === true,
		// Captured from the ORIGINAL body before translation; the real effort
		// vocabulary is wider than the narrow type in types.ts, so treat it as an
		// arbitrary string.
		reasoningEffort:
			typeof body.reasoning?.effort === "string" ? body.reasoning.effort : null,
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
	} catch (err) {
		const statusCode =
			typeof err === "object" &&
			err !== null &&
			"statusCode" in err &&
			typeof (err as { statusCode: unknown }).statusCode === "number"
				? (err as { statusCode: number }).statusCode
				: 503;
		const isUnavailable = statusCode === 503;
		return new Response(
			JSON.stringify({
				error: {
					message: isUnavailable
						? "Service temporarily unavailable. Please try again later."
						: "Proxy request failed",
					type: isUnavailable ? "server_error" : "api_error",
					code: isUnavailable ? "server_error" : "api_error",
				},
			}),
			{ status: statusCode, headers: { "Content-Type": "application/json" } },
		);
	}

	// 7. Translate non-200 Anthropic errors to OpenAI error shape
	if (anthropicResp.status !== 200) {
		let errorBody: { error: { message: string; type: string; code: string } };
		const contentType = anthropicResp.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			try {
				const anthropicError = (await anthropicResp.json()) as {
					type?: string;
					error?: { type?: string; message?: string };
				};
				const errType = anthropicError?.error?.type ?? "api_error";
				errorBody = {
					error: {
						message: anthropicError?.error?.message ?? "Unknown error",
						type: errType,
						code: errType,
					},
				};
			} catch {
				errorBody = {
					error: {
						message: "Unknown error",
						type: "api_error",
						code: "api_error",
					},
				};
			}
		} else {
			errorBody = {
				error: {
					message: "Unknown error",
					type: "api_error",
					code: "api_error",
				},
			};
		}
		return new Response(JSON.stringify(errorBody), {
			status: anthropicResp.status,
			headers: { "Content-Type": "application/json" },
		});
	}

	// 8. Native Responses passthrough (Stage B, response leg): on a codex-native
	// attempt the proxy returns the backend's RAW Codex-Responses SSE marked
	// with the internal marker header (only ever set on status 200 — non-200s
	// were error-translated above). The body is already genuine Responses SSE
	// (response.created / response.output_text.delta / response.completed, with
	// the backend's own response id), so it goes to the client AS-IS — no
	// translation, no responseId substitution — minus the internal marker. The
	// marker implies the client requested streaming (Stage A only goes native
	// when clientStream === true), so this branch sits naturally before the
	// `body.stream` check below.
	if (anthropicResp.headers.get(NATIVE_RESPONSES_RESPONSE_HEADER) === "1") {
		if (body.stream) {
			const passthroughHeaders = new Headers(anthropicResp.headers);
			passthroughHeaders.delete(NATIVE_RESPONSES_RESPONSE_HEADER);
			return new Response(anthropicResp.body, {
				status: anthropicResp.status,
				statusText: anthropicResp.statusText,
				headers: passthroughHeaders,
			});
		}
		// Should be impossible — Stage A guards on clientStream === true. Warn
		// for observability and fall through to the normal translation path.
		log.warn(
			"Native Responses marker present but the client did not request streaming — falling back to translation",
		);
	}

	// 9. Stream path
	if (body.stream) {
		return translateAnthropicStreamToResponses(
			anthropicResp,
			responseId,
			body.model,
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
	const translated = translateAnthropicResponseToResponses(
		respBody as Parameters<typeof translateAnthropicResponseToResponses>[0],
		responseId,
		body.model,
	);
	return new Response(JSON.stringify(translated), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}
