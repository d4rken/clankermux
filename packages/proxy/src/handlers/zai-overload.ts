import { setTimeout as delay } from "node:timers/promises";
import { discardUpstreamBody } from "@clankermux/core/response-body-disposal";

const MAX_PEEK_BYTES = 4096;
const PEEK_TIMEOUT_MS = 500;
// Only locally classified 1305 responses participate in model fallback. A
// random upstream 529 must keep the existing provider-specific behavior.
const overloadResponses = new WeakSet<Response>();
export const isZaiOverloadResponse = (response: Response): boolean =>
	overloadResponses.has(response);

/**
 * Inspect only leading SSE events, stopping at the first non-heartbeat payload.
 * Never retry after message_start/content: that could discard a partial answer.
 * A clone is cancelled, never drained, so it cannot eagerly buffer the full
 * answer for the client. Both the inspection bytes and wait are bounded.
 */
export async function peekZaiOverload(
	response: Response,
	signal?: AbortSignal,
	timeoutMs = PEEK_TIMEOUT_MS,
): Promise<boolean> {
	if (
		response.status !== 200 ||
		!response.body ||
		!response.headers
			.get("content-type")
			?.toLowerCase()
			.includes("text/event-stream")
	)
		return false;
	signal?.throwIfAborted();
	const reader = response.clone().body?.getReader();
	if (!reader) return false;
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const stop = new Promise<null>((resolve, reject) => {
		timer = setTimeout(() => resolve(null), timeoutMs);
		if (signal) {
			onAbort = () =>
				reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
	try {
		while (bytes < MAX_PEEK_BYTES) {
			const next = await Promise.race([reader.read(), stop]);
			if (!next || next.done) return false;
			const prefix = next.value.subarray(0, MAX_PEEK_BYTES - bytes);
			bytes += prefix.byteLength;
			text += decoder.decode(prefix, { stream: true });
			while (true) {
				const boundary = /\r?\n\r?\n/.exec(text);
				if (!boundary) break;
				const frame = text.slice(0, boundary.index);
				text = text.slice(boundary.index + boundary[0].length);
				const payload = frame
					.split(/\r?\n/)
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).replace(/^ /, ""))
					.join("\n");
				if (!payload) continue; // comment/keepalive
				let parsed: { type?: unknown; error?: { code?: unknown } } | null;
				try {
					parsed = JSON.parse(payload);
				} catch {
					return false;
				}
				if (parsed?.type === "ping") continue;
				return parsed?.error?.code === 1305 || parsed?.error?.code === "1305";
			}
		}
		return false;
	} catch (_error) {
		signal?.throwIfAborted();
		// The original branch still owns any transport error for normal handling.
		return false;
	} finally {
		clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		// A tee cancel may wait for its twin. Never await it or a stalled stream
		// would undo the deadline. Promise.race observes the pending read too.
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/** One short retry per model, then let the existing model/account loop recover. */
export async function recoverZaiOverload(
	response: Response,
	retry: () => Promise<Response>,
	signal?: AbortSignal,
): Promise<Response> {
	if (!(await peekZaiOverload(response, signal))) return response;
	discardUpstreamBody(response);
	await delay(100 + Math.random() * 100, undefined, { signal });
	const retried = await retry();
	if (!(await peekZaiOverload(retried, signal))) return retried;
	discardUpstreamBody(retried);
	const headers = new Headers({
		"content-type": "application/json",
		"retry-after": "1",
	});
	for (const name of [
		"request-id",
		"x-request-id",
		"x-clankermux-request-id",
		"x-better-ccflare-request-id",
	]) {
		const value = retried.headers.get(name);
		if (value) headers.set(name, value);
	}
	const overloaded = new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "overloaded_error",
				code: 1305,
				message: "Z.ai service overloaded. Please retry shortly.",
			},
		}),
		{ status: 529, headers },
	);
	overloadResponses.add(overloaded);
	return overloaded;
}
