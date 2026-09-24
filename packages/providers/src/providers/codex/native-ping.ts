import { Logger } from "@clankermux/logger";
import { codexNativePingHeaders } from "./client-identity";
import {
	CODEX_DEFAULT_ENDPOINT,
	CODEX_PING_MODEL,
	targetsChatGptCodexBackend,
} from "./provider";

const log = new Logger("CodexNativePing");

const REQUEST_TIMEOUT_MS = 10_000;
const ERROR_BODY_LOG_BYTES = 2048;
const ERROR_BODY_READ_TIMEOUT_MS = 1_000;

/**
 * Up to `limit` bytes of `body` as text, giving up after `timeoutMs` (the
 * request's abort timer is already cleared once headers arrive).
 */
async function readBodyPrefix(
	body: ReadableStream<Uint8Array> | null,
	limit: number,
	timeoutMs: number,
): Promise<string> {
	if (!body) return "";
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	// Cancelling the reader settles a pending read as done.
	const timer = setTimeout(() => {
		reader.cancel().catch(() => {});
	}, timeoutMs);
	try {
		while (bytes < limit) {
			const { done, value } = await reader.read();
			if (done) break;
			const slice = value.subarray(0, limit - bytes);
			bytes += slice.byteLength;
			text += decoder.decode(slice, { stream: true });
		}
		return text + decoder.decode();
	} catch (error) {
		return `(error body unreadable: ${String(error)})`;
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
}

/**
 * Cancel the ping's body. We rely on the server honoring stream cancellation
 * to avoid generating further tokens; the abort-after-headers cancel is the cap.
 */
async function cancelBody(
	body: ReadableStream<Uint8Array> | null,
): Promise<void> {
	try {
		await body?.cancel();
	} catch (error) {
		log.debug("Codex native ping response body cancel threw:", error);
	}
}

async function logRejection(
	body: ReadableStream<Uint8Array> | null,
	status: number,
	statusText: string,
): Promise<void> {
	// Runs detached; the body is cancelled whether or not reading or logging fails.
	try {
		const reason = await readBodyPrefix(
			body,
			ERROR_BODY_LOG_BYTES,
			ERROR_BODY_READ_TIMEOUT_MS,
		);
		log.warn(`Codex native ping rejected: ${status} ${statusText} ${reason}`);
	} catch (error) {
		log.warn(
			`Codex native ping rejected: ${status} ${statusText} (error body unreadable: ${String(error)})`,
		);
	} finally {
		await cancelBody(body);
	}
}

/**
 * Pure transport for the minimal Codex `/responses` "ping". Builds the tiny
 * upstream request, issues the fetch under a 10s abort timeout, snapshots the
 * status + headers, cancels the response body (to minimise quota consumption),
 * and returns a header-only, bodyless synthetic {@link Response}.
 *
 * This is intentionally side-effect-free beyond the network call: it performs
 * NO usage parsing, NO cache writes, NO credit handling, NO cooldown, and NO DB
 * work. Header-only consumers (`parseCodexUsageHeaders`, `parseRateLimit`, the
 * {@link import("../../../..").CodexSpendCoordinator}) read the returned
 * response; the applicator/coordinator own all policy.
 *
 * This is a SPEND: it always consumes a small slice of the account's Codex quota
 * (bounded by `reasoning.effort: "none"` plus the abort-after-headers body
 * cancel). Its purpose is window-PRIMING — the native POST is the operation that
 * actually STARTS a new 5h window. For pure telemetry (observing usage/limits
 * WITHOUT spending) there is now a free read, `fetchCodexUsageStatus`
 * (`GET /backend-api/wham/usage`); the manual "Refresh usage" click uses that. A
 * successful free read is NOT a substitute for priming, since it never starts a
 * window.
 *
 * @param accessToken Bearer token for the Codex account. Empty/whitespace
 *   throws BEFORE any fetch is issued.
 * @param endpoint The Codex `/responses` endpoint (defaults to
 *   {@link CODEX_DEFAULT_ENDPOINT}; callers pass `account.custom_endpoint` when set).
 */
export async function sendCodexNativePing(
	accessToken: string,
	endpoint: string = CODEX_DEFAULT_ENDPOINT,
): Promise<Response> {
	if (!accessToken || accessToken.trim() === "") {
		throw new Error("sendCodexNativePing requires a non-empty access token");
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	const body = JSON.stringify({
		model: CODEX_PING_MODEL,
		input: [
			{
				role: "user",
				content: [{ type: "input_text", text: "." }],
			},
		],
		stream: true,
		store: false,
		// The ChatGPT/Codex backend rejects both `max_output_tokens` ("Unsupported
		// parameter") and `reasoning.effort: "minimal"` ("Unsupported value:
		// 'minimal' ... Supported values are: none, low, medium, high, xhigh") as of
		// 2026-07 — a ping carrying either 400s with no usage headers, silently
		// breaking usage sampling + scheduled priming. `effort: "none"` is the
		// cheapest accepted value; the abort-after-headers body cancel below is what
		// actually bounds token generation. Verified live: 200 + x-codex-* headers
		// on gpt-5.6-sol.
		reasoning: { effort: "none" },
		instructions: "ping",
	});

	let upstream: Response;
	try {
		upstream = await fetch(endpoint, {
			method: "POST",
			signal: controller.signal,
			headers: codexNativePingHeaders(
				accessToken,
				targetsChatGptCodexBackend({ custom_endpoint: endpoint }),
			),
			body,
		});
	} finally {
		clearTimeout(timeoutId);
	}

	const headersSnapshot = new Headers(upstream.headers);
	const status = upstream.status;
	const statusText = upstream.statusText;

	if (upstream.ok) {
		await cancelBody(upstream.body);
	} else {
		// A rejected ping carries its reason only in the body, and callers see
		// just the status. Logged in the background: the scheduler primes
		// accounts one after another and must not wait on a slow error body.
		void logRejection(upstream.body, status, statusText).catch(() => {});
	}

	return new Response(null, {
		status,
		statusText,
		headers: headersSnapshot,
	});
}
