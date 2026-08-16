import crypto from "node:crypto";
import { TIME_CONSTANTS, ValidationError } from "@clankermux/core";
import { stripHopByHopHeaders } from "@clankermux/http-common";
import type { Provider } from "@clankermux/providers";
import type { RequestMeta } from "@clankermux/types";
import { chatGptCloudflareCookieJar } from "../chatgpt-cloudflare-cookies";
import { ERROR_MESSAGES } from "./proxy-types";

/** Trusted internal origin for synthetic responses. Never reachable over the network. */
const SYNTHETIC_LOCAL_ORIGIN = "https://clankermux.local";

/**
 * If `request` carries a synthetic-response marker AND targets the trusted
 * internal origin, unwrap it immediately without a network fetch.
 *
 * Security: the proxy strips x-clankermux-synthetic-* from ALL INBOUND client
 * requests before provider transformation, so only the provider itself can
 * set the marker. The trusted-origin gate adds defence-in-depth: even if a
 * client somehow reached the provider path with a forged marker, the URL
 * must be clankermux.local (unreachable externally) for the unwrap to fire.
 */
async function tryUnwrapSyntheticResponse(
	request: Request,
): Promise<Response | null> {
	// Exact-origin match, NOT startsWith: a prefix check would also trust a
	// hostile host like https://clankermux.local.evil/… that merely begins with
	// the trusted string.
	let origin: string;
	try {
		origin = new URL(request.url).origin;
	} catch {
		return null;
	}
	if (
		origin !== SYNTHETIC_LOCAL_ORIGIN ||
		request.headers.get("x-clankermux-synthetic-response") !== "true"
	) {
		return null;
	}
	const rawStatus = request.headers.get("x-clankermux-synthetic-status");
	const status = rawStatus ? parseInt(rawStatus, 10) : 200;
	const safeStatus =
		Number.isFinite(status) && status >= 200 && status <= 599 ? status : 200;
	const body = await request.text();
	const headers = new Headers();
	headers.set("content-type", "application/json");
	return new Response(body, { status: safeStatus, headers });
}

/**
 * Matches every internal control header this proxy uses, current and future,
 * under both the current (`x-clankermux-*`) and legacy (`x-better-ccflare-*`)
 * prefixes.
 */
const INTERNAL_HEADER_PREFIX_PATTERN = /^x-(clankermux|better-ccflare)-/i;

/**
 * Deletes every internal control header from the FINAL outbound headers, as the
 * last mutation before `fetch`.
 *
 * This generalizes the existing per-header policy in `proxy-operations.ts`
 * ("DELETE the internal header so it never reaches the upstream Codex backend"):
 * a hand-maintained delete list silently misses markers like
 * `x-clankermux-request-stream`, `-skip-cache`, and anything added later, so we
 * sweep by prefix instead.
 *
 * The key list is SNAPSHOTTED before deleting: mutating a live `Headers` while
 * iterating it can advance past adjacent entries, which would leave some of the
 * very headers this sweep exists to remove on the wire.
 */
function stripInternalControlHeaders(headers: Headers): void {
	for (const key of [...headers.keys()]) {
		if (INTERNAL_HEADER_PREFIX_PATTERN.test(key)) {
			headers.delete(key);
		}
	}
}

/**
 * Creates request metadata for tracking and analytics
 * @param req - The incoming request
 * @param url - The parsed URL
 * @returns Request metadata object
 */
export function createRequestMetadata(req: Request, url: URL): RequestMeta {
	return {
		id: crypto.randomUUID(),
		method: req.method,
		path: url.pathname,
		timestamp: Date.now(),
		headers: req.headers,
	};
}

/**
 * Validates that the provider can handle the requested path
 * @param provider - The provider instance
 * @param pathname - The request path
 * @throws {ValidationError} If provider cannot handle the path
 */
export function validateProviderPath(
	provider: Provider,
	pathname: string,
): void {
	if (!provider.canHandle(pathname)) {
		throw new ValidationError(
			`${ERROR_MESSAGES.PROVIDER_CANNOT_HANDLE}: ${pathname}`,
			"path",
			pathname,
		);
	}
}

/**
 * Prepares request body for analytics and creates body stream factory
 * @param req - The incoming request
 * @returns Object containing the buffered body and stream factory
 */
export async function prepareRequestBody(req: Request): Promise<{
	buffer: ArrayBuffer | null;
	createStream: () => ReadableStream<Uint8Array> | undefined;
}> {
	let buffer: ArrayBuffer | null = null;

	if (req.body) {
		buffer = await req.arrayBuffer();
	}

	return {
		buffer,
		createStream: () => {
			if (!buffer) return undefined;
			return new Response(buffer).body ?? undefined;
		},
	};
}

/**
 * Makes the actual HTTP request to the provider
 * @param targetUrl - The target URL to fetch
 * @param method - HTTP method
 * @param headers - Request headers
 * @param createBodyStream - Function to create request body stream
 * @param hasBody - Whether the request has a body
 * @returns Promise resolving to the response
 */
export async function makeProxyRequest(
	target: string | Request,
	method?: string,
	headers?: Headers,
	createBodyStream?: () => ReadableStream<Uint8Array> | undefined,
	hasBody?: boolean,
	signal?: AbortSignal,
): Promise<Response> {
	// Synthetic local response: unwrap without fetch, no timeout needed
	if (target instanceof Request) {
		const synthetic = await tryUnwrapSyntheticResponse(target);
		if (synthetic) return synthetic;
	}

	// The internal request timeout must ALWAYS apply, even when the caller passes
	// its own signal (e.g. the transparent burst-retry paths thread `req.signal`
	// through to release the hold slot on a client disconnect). Previously the
	// caller signal *replaced* the timeout, so a hung upstream with a still-
	// connected client could hold the concurrency semaphore indefinitely and blow
	// past BURST_RETRY_MAX_HOLD_MS. Compose both so EITHER a client disconnect OR
	// the internal timeout aborts the fetch.
	const internalController = new AbortController();
	const timeoutId = setTimeout(
		() => internalController.abort(),
		TIME_CONSTANTS.PROXY_REQUEST_TIMEOUT_MS,
	);

	const effectiveSignal = signal
		? AbortSignal.any([signal, internalController.signal])
		: internalController.signal;

	try {
		if (target instanceof Request) {
			const targetUrl = target.url;
			const mutableHeaders = new Headers(target.headers);
			// Hop-by-hop headers (RFC 9110 §7.6.1) govern the client→proxy link and
			// must not reach the upstream. Concretely: the Codex CLI sends
			// `connection: close` on every request, and forwarding it invites the
			// ChatGPT backend to close the connection abruptly after the response.
			// Runs BEFORE the cookie jar so a Connection header naming `cookie`
			// cannot delete the jar's proxy-side cookies.
			stripHopByHopHeaders(mutableHeaders);
			chatGptCloudflareCookieJar.applyCookieHeader(targetUrl, mutableHeaders);
			stripInternalControlHeaders(mutableHeaders);

			const response = await fetch(
				new Request(target, {
					headers: mutableHeaders,
					signal: effectiveSignal,
				}),
			);
			chatGptCloudflareCookieJar.captureFromResponse(targetUrl, response);
			return response;
		}

		const mutableHeaders = new Headers(headers);
		// Same rationale and ordering as the Request-target branch above.
		stripHopByHopHeaders(mutableHeaders);
		chatGptCloudflareCookieJar.applyCookieHeader(target, mutableHeaders);
		stripInternalControlHeaders(mutableHeaders);

		const response = await fetch(target, {
			method,
			headers: mutableHeaders,
			body: createBodyStream ? createBodyStream() : undefined,
			signal: effectiveSignal,
			...(hasBody ? ({ duplex: "half" } as RequestInit) : {}),
		});
		chatGptCloudflareCookieJar.captureFromResponse(target, response);
		return response;
	} finally {
		clearTimeout(timeoutId);
	}
}
