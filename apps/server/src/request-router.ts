/**
 * The front door: everything `fetch` does with a request before a handler owns
 * it.
 *
 * Extracted from `startServer`'s `fetch` closure so it can be exercised
 * directly. The decisions here are the ones with no other observation point —
 * which namespace a request belongs to, whether it needs a key, and which of
 * three mutually-invisible branches gets it — and while they lived inside a
 * closure over a live `Bun.serve` config, the only way to test any of them was
 * to stand up a server. Every dependency the closure held is injected instead.
 *
 * Two namespaces on this port used to overlap. Anthropic's own API lives under
 * `/api/*` and so does our management REST surface; ours was checked first, so
 * an Anthropic path we had not enumerated collected our `Unknown API route`
 * 404, and an Anthropic path that ever matched one of our routes would have been
 * answered with our own unauthenticated management JSON. Agent traffic now has
 * its own namespace (`wire-mounts.ts`), and the mount is stripped HERE, above
 * everything else, so that:
 *
 *   - the API router and the dashboard manifest still key off a raw pathname
 *     that is unambiguously theirs, and
 *   - every path predicate downstream — roughly forty exact-match comparisons
 *     across the proxy — keeps seeing the canonical root-relative path it was
 *     written against. Not one of them would report a prefix it did not expect;
 *     they would just quietly stop matching.
 *
 * The mounted branch NEVER re-enters the API router. Doing so would reinstate
 * the collision the strip just removed.
 */

import { CACHE, HTTP_STATUS } from "@clankermux/core";
import type {
	AuthenticationResult,
	AuthRequirement,
} from "@clankermux/http-api";
import {
	createIdentityBoundRefusalResponse,
	isIdentityBoundPath,
} from "@clankermux/proxy";
import { terminalForRequestError } from "./request-error-terminal";
import {
	isDialectAllowed,
	matchWireMount,
	otherMount,
	WIRE_MOUNTS,
	type WireDialect,
} from "./wire-mounts";

/**
 * Everything the `fetch` closure used to reach for. Injected rather than
 * imported so a test can watch which of them was called — "the API router never
 * saw this request" is a property of the routing, and it has to be assertable.
 */
export interface RequestRouterDeps {
	/** The management REST surface. Returns null when no route matched. */
	handleApiRequest(url: URL, req: Request): Promise<Response | null>;
	authenticate(
		req: Request,
		path: string,
		method: string,
		requirement?: AuthRequirement,
	): Promise<AuthenticationResult>;
	dispatchProxy(
		req: Request,
		url: URL,
		apiKeyId?: string | null,
		apiKeyName?: string | null,
	): Promise<Response>;
	/** The OpenAI Responses → Anthropic Messages adapter. */
	handleResponses(
		req: Request,
		url: URL,
		apiKeyId?: string | null,
		apiKeyName?: string | null,
	): Promise<Response>;
	/** The static, advisory OpenAI-format model list. */
	handleModels(): Response;
	withDashboard: boolean;
	dashboardManifest: Record<string, string> | null;
	serveDashboardFile(
		assetPath: string,
		contentType?: string,
		cacheControl?: string,
	): Response;
}

function jsonError(status: number, type: string, message: string): Response {
	return new Response(
		JSON.stringify({ type: "error", error: { type, message } }),
		{ status, headers: { "Content-Type": "application/json" } },
	);
}

/** Anthropic-style agent traffic at the root of the port. */
function isRootProxyPath(pathname: string): boolean {
	return (
		pathname === "/v1" ||
		pathname.startsWith("/v1/") ||
		pathname === "/messages" ||
		pathname.startsWith("/messages/")
	);
}

function isApiPath(pathname: string): boolean {
	return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Claude Code's own telemetry endpoints, which reach us at the root when a
 * client is configured the old way (no mount). They must fall through to the
 * proxy's ingest prologue, which answers them with the 200 the client expects;
 * dropping them into the `/api/*` 404 leaves the CLI talking to something that
 * visibly is not Anthropic.
 *
 * This exact-match list is the thing the mounts make unnecessary: under
 * `/wire/anthropic` an unrecognized Anthropic path is simply forwarded, which
 * is why `/api/event_logging/v2/batch` works there and 404s here.
 */
function isClaudeCodeInternalPath(pathname: string): boolean {
	return (
		pathname === "/api/event_logging/batch" ||
		pathname === "/api/system/package-manager"
	);
}

const RESPONSES_PATHS = new Set(["/v1/responses", "/v1/responses/compact"]);

/**
 * Route one request. `fetch` is a thin wrapper around this.
 */
export async function routeRequest(
	req: Request,
	deps: RequestRouterDeps,
): Promise<Response> {
	const url = new URL(req.url);
	const match = matchWireMount(url.pathname);

	if (match.kind === "reserved") {
		return jsonError(
			HTTP_STATUS.NOT_FOUND,
			"not_found",
			`${url.pathname} is not a wire mount. Point the client at ` +
				`${WIRE_MOUNTS.anthropic} (Anthropic Messages) or ${WIRE_MOUNTS.openai} ` +
				"(OpenAI Responses).",
		);
	}

	if (match.kind === "mounted") {
		// Query strings are part of the request, not of the mount: the pathname is
		// rewritten and everything else about the URL is carried through.
		const canonicalUrl = new URL(url);
		canonicalUrl.pathname = match.logicalPath;
		return routeMountedRequest(
			req,
			canonicalUrl,
			match.dialect,
			match.logicalPath,
			deps,
		);
	}

	return routeRootRequest(req, url, deps);
}

/**
 * Agent traffic that named its dialect.
 *
 * AUTHENTICATION COMES FIRST here, unlike at the root, and the difference is
 * deliberate. Every request on this mount is API-key gated, so refusing an
 * identity-bound path before authenticating would let an unauthenticated caller
 * enumerate the refusal set and would leave those requests unattributed to any
 * key. At the root the opposite ordering is correct, because root `/api/*` is
 * genuinely public and the refusal must not be reachable only by key-holders.
 *
 * The API router, the dashboard branches and the `/api/*` 404 are all
 * unreachable from here. That is the entire point of the mount.
 */
async function routeMountedRequest(
	req: Request,
	canonicalUrl: URL,
	dialect: WireDialect,
	logicalPath: string,
	deps: RequestRouterDeps,
): Promise<Response> {
	let authResult: AuthenticationResult;
	try {
		// The requirement is passed EXPLICITLY. The path is canonical by now, and
		// a canonical `/api/…` reads as public management surface to the auth
		// service's path policy — the classification belongs to the router, which
		// still knows this arrived on a mount.
		authResult = await deps.authenticate(
			req,
			logicalPath,
			req.method,
			"api_key",
		);
	} catch (authError) {
		return terminalForRequestError(req, authError, "auth");
	}
	if (!authResult.isAuthenticated) {
		return jsonError(
			401,
			"authentication_error",
			authResult.error || "Authentication failed",
		);
	}

	// Endpoints bound to a single Anthropic identity. Refused on the mount for
	// the same reason as at the root: a pooled credential cannot answer them.
	// The proxy's own ingest prologue calls the same predicate, so the two
	// entry points cannot drift.
	if (isIdentityBoundPath(logicalPath)) {
		return createIdentityBoundRefusalResponse(logicalPath);
	}

	if (!isDialectAllowed(dialect, req.method, logicalPath)) {
		return jsonError(
			HTTP_STATUS.NOT_FOUND,
			"not_found",
			`${req.method} ${logicalPath} is not served under ${WIRE_MOUNTS[dialect]}. ` +
				`Try ${otherMount(dialect)}.`,
		);
	}

	try {
		return await serveAgentRequest(req, canonicalUrl, authResult, deps);
	} catch (dispatchError) {
		return terminalForRequestError(req, dispatchError, "dispatch");
	}
}

/**
 * The legacy root flow: unchanged apart from where the proxy boundary is
 * enforced (see the comment on the 404 below).
 */
async function routeRootRequest(
	req: Request,
	url: URL,
	deps: RequestRouterDeps,
): Promise<Response> {
	// Try API routes first
	const apiResponse = await deps.handleApiRequest(url, req);
	if (apiResponse) {
		return apiResponse;
	}

	// Identity-bound endpoints are refused before ANY other routing.
	// Ahead of the dashboard branch specifically: that branch decides by
	// raw pathname, so an encoded spelling like `/%76%31/code/sessions`
	// does not look like a `/v1/` proxy path to it and would be answered
	// with the dashboard's index.html — no credential leaked, but not the
	// deliberate, visible refusal this is supposed to give. Ahead of the
	// auth gate too, which is fine: `policyFor` already treats `/api/*` as
	// public, and declining to serve an endpoint needs no credential.
	//
	// The `/v1/code/…` half of the set is ALSO refused by the proxy's
	// ingest prologue. Both call the same predicate, so the two entry
	// points cannot drift, and the prologue is what guarantees no request
	// reaching the proxy by another route can be served with a pooled
	// token.
	if (isIdentityBoundPath(url.pathname)) {
		return createIdentityBoundRefusalResponse(url.pathname);
	}

	const p = url.pathname;
	// Anthropic-style clients POSTing to /messages or /messages/* (and /v1,
	// /v1/*) must reach proxy dispatch. Mirrors the boundary `policyFor` uses.
	const isProxyPath = isRootProxyPath(p);

	// Dashboard routes (only if enabled and assets are available)
	if (deps.withDashboard && deps.dashboardManifest) {
		// Serve dashboard static assets
		if (deps.dashboardManifest[p]) {
			return deps.serveDashboardFile(p, undefined, CACHE.CACHE_CONTROL_STATIC);
		}

		// For all non-API, non-proxy routes, serve the dashboard index.html
		// (client-side routing). This allows React Router to handle all
		// dashboard routes without maintaining a list.
		if (!p.startsWith("/api/") && !isProxyPath) {
			return deps.serveDashboardFile("/index.html", "text/html");
		}
	}

	// Reject unmatched /api/* paths with 404 before falling through to the
	// proxy. Without this, an unknown management URL like /api/not-a-route
	// would be treated as a proxy path (it'd 404 deeper in the pipeline,
	// but with confusing semantics and an account-selection round-trip).
	if (!isClaudeCodeInternalPath(p) && isApiPath(p)) {
		return jsonError(
			HTTP_STATUS.NOT_FOUND,
			"not_found",
			`Unknown API route: ${p}`,
		);
	}

	// Only agent traffic reaches the proxy from the root, in EVERY mode.
	//
	// This test used to live inside the dashboard branch above, so with the
	// dashboard disabled it did not run at all and any unrecognized path fell
	// through to authentication (public by default, at the root) and then
	// upstream on a pooled account. Headless and dashboard deployments now route
	// identically; with the dashboard on, this is unreachable, because the
	// index.html branch already answered everything it covers.
	if (!isProxyPath && !isClaudeCodeInternalPath(p)) {
		return jsonError(
			HTTP_STATUS.NOT_FOUND,
			"not_found",
			`Unknown route: ${p}. Agent traffic belongs under ${WIRE_MOUNTS.anthropic} ` +
				`or ${WIRE_MOUNTS.openai}.`,
		);
	}

	// All other paths go to proxy.
	//
	// Authenticate inside its OWN error boundary. A throw from THIS call is
	// an auth-service failure, and answering 401 preserves the contract this
	// endpoint has always had for that case. What changed is the SCOPE: the
	// boundary now covers this call alone. Everything downstream of a
	// successful authentication gets the separate boundary further down,
	// because a failure there says nothing about the caller's credentials.
	let authResult: AuthenticationResult;
	try {
		authResult = await deps.authenticate(req, p, req.method);
	} catch (authError) {
		return terminalForRequestError(req, authError, "auth");
	}

	if (!authResult.isAuthenticated) {
		return jsonError(
			401,
			"authentication_error",
			authResult.error || "Authentication failed",
		);
	}

	// Everything past this point runs on an AUTHENTICATED request, so a
	// failure here is a departed client or our own fault — never the
	// caller's credentials. Its own boundary keeps it from being reported
	// as an auth error, which is what this whole block used to do.
	try {
		return await serveAgentRequest(req, url, authResult, deps);
	} catch (dispatchError) {
		return terminalForRequestError(req, dispatchError, "dispatch");
	}
}

/**
 * The post-authentication chain, shared by both entry points so the mounted
 * and root paths cannot drift apart in what they dispatch.
 *
 * `url` is canonical here: root-relative, mount already stripped.
 */
async function serveAgentRequest(
	req: Request,
	url: URL,
	authResult: AuthenticationResult,
	deps: RequestRouterDeps,
): Promise<Response> {
	// Codex CLI first tries WebSocket transport for /v1/responses.
	// We only support HTTP — reject the upgrade cleanly so Codex
	// falls back to HTTPS without hitting the proxy with an empty body.
	if (
		req.headers.get("upgrade")?.toLowerCase() === "websocket" &&
		RESPONSES_PATHS.has(url.pathname)
	) {
		return jsonError(
			503,
			"not_supported_error",
			"WebSocket transport is not supported. Codex will retry over HTTPS automatically.",
		);
	}

	// Codex CLI speaks the OpenAI Responses API; translate
	// /v1/responses(/compact) to Anthropic /v1/messages and run it
	// through the normal proxy pipeline via handleProxy.
	if (req.method === "POST" && RESPONSES_PATHS.has(url.pathname)) {
		return await deps.handleResponses(
			req,
			url,
			authResult.apiKeyId,
			authResult.apiKeyName,
		);
	}

	// Codex CLI probes GET /v1/models to list/validate models. ClankerMux
	// has no models route, so without this it falls through to the proxy
	// and 400s ("Provider cannot handle path: /v1/models") on every Codex
	// startup. Serve a static OpenAI-format model list (advisory — model
	// names are forwarded verbatim by the responses adapter).
	if (req.method === "GET" && url.pathname === "/v1/models") {
		return deps.handleModels();
	}

	return await deps.dispatchProxy(
		req,
		url,
		authResult.apiKeyId,
		authResult.apiKeyName,
	);
}
