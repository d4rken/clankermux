import crypto from "node:crypto";
import { TIME_CONSTANTS, ValidationError } from "@clankermux/core";
import type { Provider } from "@clankermux/providers";
import type { RequestMeta } from "@clankermux/types";
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
	if (
		!request.url.startsWith(SYNTHETIC_LOCAL_ORIGIN) ||
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
			return await fetch(new Request(target, { signal: effectiveSignal }));
		}

		return await fetch(target, {
			method,
			headers,
			body: createBodyStream ? createBodyStream() : undefined,
			signal: effectiveSignal,
			...(hasBody ? ({ duplex: "half" } as RequestInit) : {}),
		});
	} finally {
		clearTimeout(timeoutId);
	}
}
