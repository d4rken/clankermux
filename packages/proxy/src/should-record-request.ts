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
	 * True only for an in-process dispatch — `handleProxy`'s own `isInternal`
	 * parameter, which is never sourced from a request header and is therefore
	 * unspoofable. The two probe-marker suppressions below are gated on it: the
	 * `x-clankermux-auto-refresh` / `-keepalive` headers are client-settable, so
	 * without this gate any caller could hide its traffic from Request History
	 * (and from the cost/metrics it feeds) just by setting a header.
	 *
	 * Optional and defaulting to false so an omitted value is the SAFE one
	 * (record the request) rather than the privileged one.
	 */
	internal?: boolean;
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
	const {
		path,
		providerName,
		responseStatus,
		getHeader,
		internal = false,
	} = input;

	// (1) count_tokens probes on the openai-compatible or codex provider are not
	//     billable user traffic.
	if (
		(providerName === "openai-compatible" || providerName === "codex") &&
		path === "/v1/messages/count_tokens"
	) {
		return false;
	}

	if (isInternalProbe(getHeader, internal)) return false;

	// (3) Worker-side ignored paths: `.well-known` 404s.
	if (path.startsWith("/.well-known/") && responseStatus === 404) {
		return false;
	}

	return true;
}

/**
 * Rules (2)/(2b): synthetic internal probes.
 *
 * - auto-refresh probes are internal scheduler activity that must not pollute
 *   user-visible dashboard metrics;
 * - cache-keepalive replays would otherwise inflate request counts, cost, and
 *   the cache-effectiveness "real work" volume (they are tracked separately in
 *   bridgeStats, not the requests table).
 *
 * Both are trust-gated on `internal`: the markers are plain headers, so without
 * the gate any client could suppress its own Request-History rows. The two
 * kinds stay SEPARATE checks (rather than one "any probe" check) so neither
 * marker can borrow the other's suppression.
 */
function isInternalProbe(
	getHeader: ShouldRecordRequestInput["getHeader"],
	internal: boolean,
): boolean {
	if (!internal) return false;
	return (
		getHeader("x-clankermux-auto-refresh") === "true" ||
		getHeader("x-clankermux-keepalive") === "true"
	);
}

/**
 * Input for {@link isIngressRecordable} — {@link ShouldRecordRequestInput}
 * minus the two fields that do not exist yet at ingress time.
 */
export type IsIngressRecordableInput = Omit<
	ShouldRecordRequestInput,
	"providerName" | "responseStatus"
>;

/**
 * Ingress-time recordability: "is this request worth telling the live dashboard
 * about?", asked the moment ingestion finishes.
 *
 * This runs BEFORE account selection, so there is no provider and no response
 * status, which makes it a strict subset of {@link shouldRecordRequest} with
 * one deliberate divergence:
 *
 * - **`.well-known` is skipped by PREFIX here, but only at status 404 there.**
 *   The recording gate knows the status and must keep recording a `.well-known`
 *   200; the ingress gate does not, and emitting a mark for every `.well-known`
 *   probe only to retract nearly all of them is worse than never drawing them.
 *   The rules are therefore duplicated rather than shared — they genuinely
 *   differ, and collapsing them would drop `.well-known` 200s from Request
 *   History.
 * - **The count_tokens rule cannot run at all**, because it keys on the
 *   provider. Such a request is admitted here, never reaches the recorder, and
 *   is retracted by the `ingress-end` terminal.
 */
export function isIngressRecordable(input: IsIngressRecordableInput): boolean {
	const { path, getHeader, internal = false } = input;

	if (isInternalProbe(getHeader, internal)) return false;

	if (path.startsWith("/.well-known/")) return false;

	return true;
}
