import type { RequestMeta } from "./api";

/**
 * Original (decompressed, normalized) OpenAI-Responses request carried
 * alongside the translated Anthropic request. Stage A of the native Responses
 * passthrough: when the selected account is a codex account and the client
 * asked for streaming, the proxy forwards this body verbatim (lightly patched)
 * instead of the double-translated Anthropic body.
 */
export interface NativeResponsesContext {
	/** JSON.stringify of the normalized ResponsesRequest the client sent. */
	nativeBody: string;
	/** Whether the CLIENT asked for a streamed response (body.stream === true). */
	clientStream: boolean;
	/**
	 * Raw `reasoning.effort` string from the ORIGINAL OpenAI Responses body
	 * (captured before translation, since the translated Anthropic body loses
	 * it), null when absent/non-string.
	 */
	reasoningEffort?: string | null;
}

/**
 * Internal request-side flag set by the proxy on the provider request when the
 * native body is being forwarded; CodexProvider.transformRequestBody reads it
 * to skip the Anthropic→Codex translation.
 */
export const NATIVE_RESPONSES_REQUEST_HEADER = "x-clankermux-native-responses";

/**
 * Response-side marker appended by CodexProvider.processResponse when the raw
 * (untranslated) Codex-Responses stream is returned. The /v1/responses adapter
 * consumes it (Stage B) to skip the Anthropic→Responses back-translation.
 */
export const NATIVE_RESPONSES_RESPONSE_HEADER = "x-clankermux-responses-native";

// Side-channel from the adapter's synthetic Request to handleProxy (one hop).
const nativeResponsesRequestContextMap = new WeakMap<
	Request,
	NativeResponsesContext
>();

// Side-channel keyed on RequestMeta so the context flows through the routing
// pipeline to each per-account attempt (mirrors comboSlotInfoMap in
// packages/proxy/src/handlers/account-selector.ts).
const nativeResponsesMetaContextMap = new WeakMap<
	RequestMeta,
	NativeResponsesContext
>();

/** Attach the native Responses context to the adapter's synthetic Request. */
export function setNativeResponsesRequestContext(
	req: Request,
	ctx: NativeResponsesContext,
): void {
	nativeResponsesRequestContextMap.set(req, ctx);
}

/** Retrieve the native Responses context from a Request (undefined if absent). */
export function getNativeResponsesRequestContext(
	req: Request,
): NativeResponsesContext | undefined {
	return nativeResponsesRequestContextMap.get(req);
}

/** Attach the native Responses context to a RequestMeta for the proxy pipeline. */
export function setNativeResponsesMetaContext(
	meta: RequestMeta,
	ctx: NativeResponsesContext,
): void {
	nativeResponsesMetaContextMap.set(meta, ctx);
}

/** Retrieve the native Responses context from a RequestMeta (undefined if absent). */
export function getNativeResponsesMetaContext(
	meta: RequestMeta,
): NativeResponsesContext | undefined {
	return nativeResponsesMetaContextMap.get(meta);
}
