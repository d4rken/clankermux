import { Logger } from "@clankermux/logger";
import {
	CODEX_DEFAULT_ENDPOINT,
	CODEX_PING_MODEL,
	CODEX_USER_AGENT,
	CODEX_VERSION,
} from "./provider";

const log = new Logger("CodexNativePing");

const REQUEST_TIMEOUT_MS = 10_000;

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
 * Like Anthropic's `/api/oauth/usage`, OpenAI does NOT expose a free
 * usage-introspection endpoint, so this call always consumes a small slice of
 * the account's Codex quota (bounded by `reasoning.effort: "none"` plus the
 * abort-after-headers body cancel).
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
		// on gpt-5.4-mini and gpt-5.6-sol.
		reasoning: { effort: "none" },
		instructions: "ping",
	});

	let upstream: Response;
	try {
		upstream = await fetch(endpoint, {
			method: "POST",
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				Version: CODEX_VERSION,
				"Openai-Beta": "responses=experimental",
				"User-Agent": CODEX_USER_AGENT,
				originator: "codex_cli_rs",
				Accept: "text/event-stream",
			},
			body,
		});
	} finally {
		clearTimeout(timeoutId);
	}

	const headersSnapshot = new Headers(upstream.headers);
	const status = upstream.status;
	const statusText = upstream.statusText;

	// Drain/cancel the body. We rely on the server honoring stream cancellation
	// to avoid generating further tokens; the abort-after-headers cancel is the cap.
	try {
		await upstream.body?.cancel();
	} catch (error) {
		log.debug("Codex native ping response body cancel threw:", error);
	}

	return new Response(null, {
		status,
		statusText,
		headers: headersSnapshot,
	});
}
