/**
 * Canonical "should we record this request?" predicate.
 *
 * This is the UNION of two filter sets that historically lived in two
 * different places:
 *
 *   1. response-handler.ts — `forwardToClient` computed `shouldProcessRequest`,
 *      which excluded:
 *        - count_tokens requests on the openai-compatible provider
 *          (not billable user traffic), and
 *        - synthetic auto-refresh probes (header `x-clankermux-auto-refresh`),
 *          which would otherwise pollute the user-visible 503/200 dashboard
 *          metrics with internal scheduler activity.
 *
 *   2. post-processor.worker.ts — `shouldLogRequest(path, status)` (whose
 *      result drives the worker's `shouldSkip`/`shouldSkipLogging`), which
 *      suppressed ignored paths such as `.well-known` 404s.
 *
 * The two filters ran at different stages (the response-handler filter decided
 * whether to even tell the worker about a request; the worker filter decided
 * whether to persist it). Folding them into one pure predicate lets a single
 * call site own the decision. This module ONLY defines the predicate — callers
 * are rewired in a later task.
 *
 * Returns `false` when the request should NOT be recorded, `true` otherwise.
 */

/**
 * Minimal input shape covering both historical filter sets.
 *
 * - `path` / `providerName` / `responseStatus` are plain values available at
 *   both call sites (the response-handler has `path`, `ctx.provider.name`, and
 *   `response.status`; the worker has `msg.path`, `msg.providerName`, and
 *   `msg.responseStatus`).
 * - `getHeader` abstracts header access so the response-handler can pass a
 *   `Headers`-backed lookup (`(name) => requestHeaders.get(name)`) and the
 *   worker can pass a plain-object lookup over `msg.requestHeaders`. Header
 *   names are matched case-insensitively by the caller-supplied accessor; the
 *   predicate only requests the canonical lower-case name it needs.
 *
 * `method` is included for completeness / future filters; the current union
 * does not branch on it, but both call sites have it (`method` / `msg.method`)
 * and it keeps the shape stable for the cutover.
 */
export interface ShouldRecordRequestInput {
	method: string;
	path: string;
	providerName: string;
	responseStatus: number;
	/**
	 * Case-insensitive request-header accessor. Returns the header value or
	 * `null`/`undefined` when absent.
	 */
	getHeader: (name: string) => string | null | undefined;
}

/**
 * Pure predicate: should this request be recorded (logged / persisted)?
 *
 * Encodes the union of:
 *
 *   - count_tokens-on-openai-compatible
 *     (response-handler.ts: `ctx.provider.name === "openai-compatible" &&
 *      path === "/v1/messages/count_tokens"`)
 *   - auto-refresh probe
 *     (response-handler.ts: `requestHeaders.get("x-clankermux-auto-refresh")
 *      === "true"`)
 *   - worker ignored paths
 *     (post-processor.worker.ts `shouldLogRequest`:
 *      `path.startsWith("/.well-known/") && status === 404`)
 *
 * Any request matching one of those is NOT recorded (returns `false`).
 */
export function shouldRecordRequest(input: ShouldRecordRequestInput): boolean {
	const { path, providerName, responseStatus, getHeader } = input;

	// (1) count_tokens probes on the openai-compatible provider are not
	//     billable user traffic.
	if (
		providerName === "openai-compatible" &&
		path === "/v1/messages/count_tokens"
	) {
		return false;
	}

	// (2) Synthetic auto-refresh probes — internal scheduler activity that must
	//     not pollute user-visible dashboard metrics.
	if (getHeader("x-clankermux-auto-refresh") === "true") {
		return false;
	}

	// (3) Worker-side ignored paths: `.well-known` 404s.
	if (path.startsWith("/.well-known/") && responseStatus === 404) {
		return false;
	}

	return true;
}
