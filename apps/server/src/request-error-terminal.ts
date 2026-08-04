/**
 * Terminal-response classifier for a throw out of the request pipeline.
 *
 * `fetch` must answer with SOMETHING, and what it answers is a diagnosis: the
 * status tells the client whose fault this was, and the log level tells the
 * operator whether to care. Getting either wrong is expensive in a way that is
 * easy to miss, because nothing breaks — the wrong answer just quietly
 * misdirects whoever reads it next.
 *
 * server.ts previously wrapped the WHOLE request path — authenticate, the
 * WebSocket rejection, /v1/responses, /v1/models and the proxy dispatch — in one
 * try whose catch logged "Authentication service error" at ERROR and answered
 * 401 `authentication_error`. So:
 *
 *   - An ordinary client disconnect (which surfaces as a throw) was recorded as
 *     an ERROR-level authentication event. Every one of the 25 occurrences
 *     observed in production across three days was this, byte-identical. ERROR
 *     is the level people scan during an incident; filling it with disconnects
 *     trains them to skim it.
 *   - A failure anywhere in the PROXY dispatch was answered 401 as well. For a
 *     client still on the socket that says "your API key is bad" when the key
 *     was fine — and a well-behaved consumer may respond by discarding or
 *     re-fetching credentials over a fault that had nothing to do with auth.
 *
 * Stage is passed in rather than inferred: only the caller knows which await
 * threw, and guessing from the error is exactly the mistake below.
 */
import { HTTP_STATUS } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import { createClientAbortResponse } from "@clankermux/proxy";

const log = new Logger("RequestTerminal");

/**
 * Which phase of the pipeline threw. `auth` is the authentication service call
 * ONLY; everything downstream of a successful authentication is `dispatch`.
 */
export type RequestStage = "auth" | "dispatch";

function jsonResponse(status: number, type: string, message: string): Response {
	return new Response(
		JSON.stringify({ type: "error", error: { type, message } }),
		{ status, headers: { "Content-Type": "application/json" } },
	);
}

/**
 * Classify `error` and produce the Response `fetch` should return.
 *
 * The client-departed check comes FIRST and keys on `req.signal.aborted`, never
 * on the shape of the error. That ordering and that predicate are both settled
 * repo convention (see handlers/client-abort-response.ts and the proxy paths
 * that use it): the throw that surfaces once a client goes away is not reliably
 * an AbortError — it can be any failure of whatever work was in flight when the
 * socket died — so sniffing the error misses real disconnects and, worse, can
 * mistake an unrelated AbortError for one.
 */
export function terminalForRequestError(
	req: Request,
	error: unknown,
	stage: RequestStage,
): Response {
	if (req.signal.aborted) {
		// Nobody is reading this body. It exists only because fetch must return a
		// Response; 499 keeps the logs and request history honest about WHY the
		// request ended, instead of attributing it to the server or to bad
		// credentials. Debug, not error — the client hanging up is not a fault.
		log.debug(
			`Client disconnected during ${stage} of ${req.method} ${new URL(req.url).pathname}; returning 499`,
		);
		return createClientAbortResponse();
	}

	if (stage === "auth") {
		// A genuine failure of the auth service itself — the original intent of
		// this branch, and now the only thing that reaches it.
		log.error("Authentication service error:", error);
		return jsonResponse(
			401,
			"authentication_error",
			"Authentication service error",
		);
	}

	// Past authentication, so this is ours, not the caller's. The message stays
	// generic on purpose: the detail is in the log, and the response goes to an
	// untrusted client that must not learn about internal hosts or stack shapes.
	log.error(
		`Unhandled error serving ${req.method} ${new URL(req.url).pathname}:`,
		error,
	);
	return jsonResponse(
		HTTP_STATUS.INTERNAL_SERVER_ERROR,
		"internal_error",
		"Internal server error",
	);
}
