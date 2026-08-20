/**
 * SSE rate-limit sniffer — observes mid-stream `event: error` frames that
 * carry a `"type": "rate_limit_error"` or `"type": "overloaded_error"` payload
 * and fires a one-shot signal so the main thread can mark the account rate-limited.
 *
 * Why this exists: the top-level `!isStream` guard in `response-processor.ts`
 * was removed so streaming 429 responses with `text/event-stream` bodies do
 * trigger failover (see issue #114, fix in `edd26da`). But Anthropic (and
 * every other SSE-shaped Claude provider) also emits rate-limit errors
 * partway through an otherwise-healthy stream when a user bursts over the
 * window mid-response. Those never hit the processProxyResponse path
 * because the upstream response status is 200; the rate-limit signal is
 * smuggled as an `event: error` SSE frame in the body.
 *
 * Design choices:
 *
 * 1. **Line-anchored regex requiring `event: error`.** The pattern requires
 *    the SSE frame to start with `event: error` (at the start of the buffer
 *    or after a line boundary) before matching the JSON type field. This
 *    prevents false positives from content that contains the quoted key-value
 *    pair literally inside a normal message body.
 *
 * 2. **`rate_limit_error` and `overloaded_error` (Anthropic-shape providers
 *    only).** Both trigger a short probe cooldown so the account is bypassed
 *    while the overload persists. `overloaded_error` is only enabled for
 *    official Anthropic providers (`isOfficialAnthropicProvider`: "anthropic",
 *    "claude-oauth", "claude-console-api") — other OpenAI-compatible providers
 *    do not emit this error type in the same SSE envelope and we should not
 *    misfire on their content. `api_error` is always excluded — it is
 *    request-scoped (server bug, not a quota/capacity issue) and marking an
 *    account for an api_error would cause spurious failovers on transient
 *    server faults.
 *
 * 3. **Bounded rolling buffer (16KB).** Most SSE frames are <1KB, and the
 *    error envelope is <500 bytes. A 16KB window is generous enough to
 *    handle frame boundaries split across many small TCP chunks while
 *    keeping memory flat for multi-megabyte streams.
 *
 * 4. **One-shot.** After firing, `feed()` short-circuits to `false` so the
 *    main thread never double-marks an account within a single request.
 */

import { isOfficialAnthropicProvider } from "../provider-overload-cooldown";

const MAX_BUFFER_BYTES = 16 * 1024;

export interface SseRateLimitSniffer {
	/**
	 * Feed an outgoing stream chunk. Returns `true` exactly once — on the
	 * first chunk where the rolling buffer contains a rate-limit or overload
	 * error marker — and `false` on every subsequent call.
	 */
	feed(chunk: Uint8Array): boolean;

	/**
	 * The error type that caused the sniffer to fire. Set to the matched
	 * error type string on the first `feed()` call that returns `true`.
	 * Remains `null` if the sniffer has not fired yet.
	 */
	firedReason: "rate_limit_error" | "overloaded_error" | null;
}

export interface SseRateLimitSnifferOptions {
	/** Provider name (e.g. "anthropic", "claude-oauth", "openai-compatible"). */
	provider: string;
}

/**
 * Create a stateful sniffer. One instance per streaming request.
 *
 * Pass `{ provider }` to enable provider-specific error detection.
 * `overloaded_error` is only matched for official Anthropic providers
 * ("anthropic", "claude-oauth", "claude-console-api" — the shared
 * `isOfficialAnthropicProvider` allow-list); all other providers only
 * match `rate_limit_error`.
 */
export function createSseRateLimitSniffer(
	opts: SseRateLimitSnifferOptions,
): SseRateLimitSniffer {
	const isAnthropicShape = isOfficialAnthropicProvider(opts.provider);
	const typePattern = isAnthropicShape
		? "rate_limit_error|overloaded_error"
		: "rate_limit_error";

	// Line-anchored: require `event: error` at start of buffer or after a line
	// boundary before matching the JSON type field in the subsequent ≤500 bytes.
	// match[1] = line-anchor group, match[2] = captured error type.
	const RATE_LIMIT_MARKER = new RegExp(
		`(^|\\r?\\n)event:\\s*error[\\s\\S]{0,500}?"type"\\s*:\\s*"(${typePattern})"`,
	);

	const decoder = new TextDecoder("utf-8", { fatal: false });
	let buffer = "";
	let fired = false;

	const sniffer: SseRateLimitSniffer = {
		firedReason: null,

		feed(chunk: Uint8Array): boolean {
			if (fired) return false;

			buffer += decoder.decode(chunk, { stream: true });

			// Keep the buffer bounded. We trim from the front to preserve
			// the most recent bytes, which is where an in-progress error
			// frame would be accumulating. Prepend a synthetic newline so
			// the line-anchor `(^|\r?\n)` still matches `event: error` at
			// the trimmed boundary.
			if (buffer.length > MAX_BUFFER_BYTES) {
				buffer = `\n${buffer.slice(buffer.length - MAX_BUFFER_BYTES)}`;
			}

			// Necessary-condition gate before the expensive scan. The pattern
			// cannot match without the literal "error" appearing (it requires
			// `event:\s*error`), so skipping the regex when that substring is
			// absent cannot change the outcome — it is strictly weaker than the
			// pattern, never a filter on top of it.
			//
			// Worth doing because the regex runs on EVERY chunk over the whole
			// rolling buffer, and on a normal stream it is looking for something
			// that is not there: measured at 5000 chunks, decode+trim is ~10 ms
			// while adding the per-chunk regex takes the total to ~97 ms. This
			// gate cuts that to ~33 ms. A stream whose content legitimately
			// contains the word "error" pays slightly MORE than before (this scan
			// plus the regex) until that substring rolls out of the window — the
			// bet is that most streamed content never contains it.
			//
			// Gate on `buffer`, never on the incoming chunk: an error frame can be
			// completed by a chunk that holds no "error" substring itself, and the
			// sniffer is one-shot, so a chunk-level gate would miss it forever.
			const match = buffer.includes("error")
				? RATE_LIMIT_MARKER.exec(buffer)
				: null;
			if (match) {
				fired = true;
				// match[2] is the first capture group inside the typePattern alternation
				// (match[1] is the line-anchor group).
				sniffer.firedReason = match[2] as
					| "rate_limit_error"
					| "overloaded_error";
				// Release the buffer; we won't need it again.
				buffer = "";
				return true;
			}

			return false;
		},
	};

	return sniffer;
}
