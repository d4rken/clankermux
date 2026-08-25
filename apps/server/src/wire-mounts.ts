/**
 * The agent-traffic mounts: `/wire/anthropic/**` and `/wire/openai/**`.
 *
 * ClankerMux serves three namespaces on one port, and two of them genuinely
 * collide at the root. Anthropic's own API lives under `/api/*` — `/api/oauth/*`,
 * `/api/event_logging/*`, `/api/system/package-manager` — and so does our
 * management REST surface, sixty-eight routes deep. The router checks ours
 * first, so the collision resolves in a way that is wrong in both directions:
 * an Anthropic path we have not enumerated collects our `Unknown API route`
 * 404 (Claude Code 2.1.241 moved its telemetry to `/api/event_logging/v2/batch`,
 * and that is exactly what happens to it today), and an Anthropic path that ever
 * matched one of our management routes would be answered with our own
 * unauthenticated management JSON.
 *
 * Mounting agent traffic under an explicit prefix dissolves the ambiguity:
 * `/api/*` becomes unambiguously ours, and the mount can forward what it does
 * not recognize instead of guessing.
 *
 * The mount names the WIRE DIALECT the client speaks — the request/response
 * shape, nothing else. It is NOT an account pool, NOT a provider, and NOT a
 * routing hint: `/wire/openai` means "this client speaks the OpenAI Responses
 * API", not "serve this from an OpenAI account". Account selection stays exactly
 * where it was, downstream, deciding on the same inputs it always has.
 *
 * A leaf module with no imports beyond the path canonicalizer, so the router
 * and its tests can both use it without dragging in server.ts. Mirrors
 * `request-error-terminal.ts`.
 */

import { canonicalize } from "@clankermux/proxy";

/** The wire dialects a client can speak to us. */
export type WireDialect = "anthropic" | "openai";

/** Where each dialect is mounted. The namespace root itself is reserved. */
export const WIRE_MOUNTS: Readonly<Record<WireDialect, string>> = {
	anthropic: "/wire/anthropic",
	openai: "/wire/openai",
};

/** The namespace this module owns in its entirety. */
export const WIRE_NAMESPACE_ROOT = "/wire";

export type WireMatch =
	/** A mounted dialect. `logicalPath` is the request with the mount removed. */
	| { kind: "mounted"; dialect: WireDialect; logicalPath: string }
	/** Inside `/wire` but not a dialect we serve. Answered with a visible 404. */
	| { kind: "reserved" }
	/**
	 * Outside the namespace entirely. The root handles it, and the root serves
	 * management REST, the dashboard and 404s only — never agent traffic.
	 */
	| { kind: "unmounted" };

/**
 * Classify a raw pathname against the mounts.
 *
 * Matching is LITERAL and SEGMENT-BOUNDED, and both properties are
 * load-bearing.
 *
 * Segment-bounded, because the mount is stripped at the very top of the router
 * and everything downstream — some forty exact-match path predicates in the
 * proxy, from `cache-body-store`'s cacheable-path test to each provider's
 * `canHandle` — assumes it is looking at a canonical root-relative path. A
 * mount that swept in `/wire/anthropicevil` would push an unclassified path
 * into that pipeline, and not one of those predicates would say so: they would
 * simply stop matching, silently.
 *
 * Literal, because a decoded match would create a second spelling of the mount
 * that only this function understands. `/%77ire/anthropic/...` does not match
 * and falls through to the root flow, which has its own answer for it (the
 * dashboard, or a JSON 404). Nothing is admitted to the mounted branch that did
 * not spell the mount exactly.
 *
 * Everything else under `/wire` is `reserved` rather than `unmounted`: the
 * namespace is ours, so a misconfigured base URL has to fail visibly instead of
 * being handed the dashboard's index.html.
 */
export function matchWireMount(pathname: string): WireMatch {
	for (const [dialect, mount] of Object.entries(WIRE_MOUNTS) as [
		WireDialect,
		string,
	][]) {
		// A bare mount carries no logical path of its own; it stands for the root
		// of the dialect, which is what `/wire/anthropic/` already slices to.
		if (pathname === mount) {
			return { kind: "mounted", dialect, logicalPath: "/" };
		}
		if (pathname.startsWith(`${mount}/`)) {
			return {
				kind: "mounted",
				dialect,
				logicalPath: pathname.slice(mount.length),
			};
		}
	}

	if (
		pathname === WIRE_NAMESPACE_ROOT ||
		pathname.startsWith(`${WIRE_NAMESPACE_ROOT}/`)
	) {
		return { kind: "reserved" };
	}

	return { kind: "unmounted" };
}

/** The model-listing route, served locally under BOTH dialects. */
export const MODELS_PATH = "/v1/models";

/** The three routes the OpenAI mount can actually serve, and with what verb. */
const OPENAI_ROUTES: ReadonlyMap<string, string> = new Map([
	["/v1/responses", "POST"],
	["/v1/responses/compact", "POST"],
	[MODELS_PATH, "GET"],
]);

/** Routes that belong to the OpenAI mount and must not be forwarded upstream
 *  as if they were Anthropic's. */
const OPENAI_ONLY_PATHS: readonly string[] = [
	"/v1/responses",
	"/v1/responses/compact",
];

/**
 * May `method logicalPath` be served under `dialect`?
 *
 * The two dialects are gated in opposite directions, and the asymmetry is the
 * point.
 *
 * `anthropic` FORWARDS BLINDLY. That is the prize: a path Anthropic ships
 * tomorrow reaches Anthropic instead of collecting a 404 from us, and the
 * request only has to be a path we do not claim for something else. Two things
 * are claimed: `/v1/responses(/compact)`, which is OpenAI's Responses API and
 * has no Anthropic meaning, and `GET /v1/models`, which we answer locally with
 * the operator-curated Anthropic catalogue. Other verbs on `/v1/models` are
 * forwarded like anything else.
 *
 * `GET /v1/models` is admitted under `anthropic` only in its EXACT canonical
 * spelling, and that asymmetry with the rest of the branch is deliberate. The
 * router dispatches this path locally on an `===` match, so an alias spelling
 * (`/v1/models/`, `//v1/%6dodels`, anything else canonicalizing to it) would
 * not reach the local handler — it would be blind-forwarded to Anthropic on a
 * pooled OAuth bearer, which is the one thing this mount must never do with a
 * path we claim. Refusing the alias is visible and costs a caller nothing but a
 * corrected URL.
 *
 * `openai` is a STRICT ALLOWLIST, because blind forwarding is not safe here.
 * Only those three paths get OpenAI handling; anything else would enter a
 * pipeline whose Anthropic provider accepts EVERY path and where an
 * OpenAI-compatible account applies an Anthropic→OpenAI body conversion. A
 * blind-forwarded `/v1/chat/completions` could therefore reach a Claude account,
 * or have an already-OpenAI body mistransformed.
 *
 * Both sides reject unnormalized spellings — `/v1/responses/`, `/v1/%72esponses`,
 * `//v1/responses`, `/v1/foo/../responses`. On the denylist side that is
 * anti-evasion: an `===` against a raw pathname is defeated by a trailing slash,
 * and what slips past is not a 404 but an OpenAI-shaped body on a pooled Claude
 * account. On the allowlist side it is the same guarantee from the other end:
 * what this function admits is dispatched VERBATIM, and every handler past it
 * matches with `===`, so admitting a spelling those handlers would decline
 * would drop the request into the ordinary proxy — the very outcome the
 * allowlist exists to prevent. Refusing visibly is the right answer for a
 * caller that spelled a supported route in an unsupported way.
 */
export function isDialectAllowed(
	dialect: WireDialect,
	method: string,
	logicalPath: string,
): boolean {
	const verb = method.toUpperCase();
	const canonical = canonicalize(logicalPath);

	if (dialect === "openai") {
		// Reject before the lookup rather than after: the allowlist's entries are
		// already canonical, so a path that is not its own canonical form can only
		// be an alternate spelling of one of them (or of something we do not
		// serve), and neither is admissible.
		if (canonical !== logicalPath) return false;
		return OPENAI_ROUTES.get(logicalPath) === verb;
	}

	for (const claimed of OPENAI_ONLY_PATHS) {
		if (logicalPath === claimed || canonical === claimed) return false;
	}
	if (verb === "GET" && canonical === MODELS_PATH) {
		// Admitted only when the caller spelled it exactly. Anything else that
		// merely canonicalizes to it is refused rather than forwarded: see the
		// note above on why an alias must not reach the proxy.
		return logicalPath === MODELS_PATH;
	}
	return true;
}

/**
 * The mount a path rejected by `isDialectAllowed` most likely belongs to.
 *
 * With two dialects this is simply the other one, and it is worth saying in the
 * 404: the failure this catches is a client pointed at the wrong mount, and the
 * useful part of the answer is where to point it instead.
 */
export function otherMount(dialect: WireDialect): string {
	return dialect === "openai" ? WIRE_MOUNTS.anthropic : WIRE_MOUNTS.openai;
}
