import {
	peekServedModel,
	SERVED_MODEL_PEEK_MAX_BYTES,
	SERVED_MODEL_PEEK_TIMEOUT_MS,
} from "./served-model-peek";

/**
 * Codex signals some backend failures as HTTP 200 followed by an in-band SSE
 * `error` event (or a `response.failed` terminal). When that happens before any
 * content has been generated, the response is worthless to the client, so the
 * attempt can still be handed to a sibling account — but only if the failure is
 * seen BEFORE the response is committed to the client.
 *
 * The reading is done by {@link peekServedModel}, which answers this question
 * and the served-model question from ONE pass over the stream's prefix. Two
 * readers over one body would tee a branch of a branch and would each charge a
 * separate timeout against the same request clock, so the second could start
 * already expired. This module keeps the Codex-specific entry point and its
 * bounds; the frame loop and the prelude classifier live next door.
 */

export {
	CODEX_PEEK_MAX_EVENTS,
	classifyFrame,
	type FrameVerdict,
} from "./served-model-peek";

export const CODEX_PEEK_MAX_BYTES = SERVED_MODEL_PEEK_MAX_BYTES;
/** Maximum content-free wait; callers also cap it by the request's elapsed time. */
export const CODEX_PEEK_TIMEOUT_MS = SERVED_MODEL_PEEK_TIMEOUT_MS;

export interface CodexStreamPeekOptions {
	maxEvents?: number;
	maxBytes?: number;
	timeoutMs?: number;
}

/**
 * @returns the transient failure code found in the stream's prefix, or null when
 *   the response should be forwarded unchanged.
 *
 * Null is the "forward unchanged" answer for every other case: content already
 * streamed, a non-transient code, an unparseable frame, or any bound expiring.
 *
 * Content safety is the stop rule: only the prelude events are walked, and they
 * carry no generated text. A response that has produced even one delta is never
 * discarded here.
 */
export async function peekCodexStreamPrefix(
	response: Response,
	signal?: AbortSignal,
	opts: CodexStreamPeekOptions = {},
): Promise<string | null> {
	const { codexFailureCode } = await peekServedModel(response, {
		codexFailure: true,
		// This entry point answers the failure question alone, so the reader is
		// not asked to keep a model budget it would never report.
		skipModel: true,
		maxCodexEvents: opts.maxEvents,
		maxBytes: opts.maxBytes,
		timeoutMs: opts.timeoutMs,
		signal,
	});
	return codexFailureCode;
}
