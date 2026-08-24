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
import { managementAuthRequirement } from "@clankermux/http-api";
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
	/**
	 * The read-only widget surface at `/public/*`. Returns null when no route
	 * matched, so this router owns the namespace's 404 rather than leaking the
	 * path into proxy dispatch.
	 */
	handlePublicRequest(req: Request, url: URL): Promise<Response | null>;
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
	/**
	 * `GET /v1/models`. Takes the URL because the reply's SHAPE depends on it:
	 * a `client_version` parameter marks a Codex models-manager fetch, which
	 * wants the per-account `{"models": […]}` catalog, and its absence marks an
	 * ordinary OpenAI-format client, which wants `{"object":"list","data":[…]}`.
	 *
	 * Takes the API key id because WHICH catalog is not a free choice: model
	 * entitlement is per-subscription, so a pinned key must be shown a catalog
	 * from inside its own pin, exactly as its requests are routed inside it.
	 */
	handleModels(url: URL, apiKeyId?: string | null): Promise<Response>;
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

/**
 * The agent surface the root used to serve, and no longer does.
 *
 * Exactly the set the root proxy flow matched before the mounts became the only
 * entry points: `/v1`, `/v1/*`, `/messages`, `/messages/*`. Segment-bounded, so
 * `/v10` and `/messagesx` are ordinary root paths and still reach the dashboard
 * or the catch-all 404 — this predicate claims only what genuinely used to be
 * proxied.
 */
function isLegacyRootAgentPath(pathname: string): boolean {
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

/** The read-only widget namespace. A sibling of the wire mounts, not of `/api`. */
function isPublicApiPath(pathname: string): boolean {
	return pathname === "/public" || pathname.startsWith("/public/");
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
 * key. At the root the opposite ordering is correct: the refusal set overlaps
 * `/api/*`, whose gate is a DASHBOARD session that agent clients neither hold
 * nor could obtain, so gating first would answer them 401 instead of the
 * deliberate 501.
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
		return terminalForRequestError(
			req,
			authError,
			"auth",
			canonicalUrl.pathname,
			WIRE_MOUNTS[dialect],
		);
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
		return terminalForRequestError(
			req,
			dispatchError,
			"dispatch",
			canonicalUrl.pathname,
			WIRE_MOUNTS[dialect],
		);
	}
}

/**
 * The root of the port: management REST, the dashboard, and 404s.
 *
 * The root dispatches no agent traffic at all. The paths it used to proxy are
 * refused here FIRST, ahead of every other branch, which is what makes "the
 * root never serves agent traffic" unconditional rather than a consequence of
 * which branch happens to match first.
 *
 * The parameter type states the same thing at compile time: this function is
 * handed only the management, session-gate and dashboard dependencies, so
 * reaching proxy dispatch from root code would take a deliberate widening of
 * the type. `authenticate` is in that list for one reason only — the management
 * session gate below — and never for agent traffic.
 */
async function routeRootRequest(
	req: Request,
	url: URL,
	deps: Pick<
		RequestRouterDeps,
		| "handleApiRequest"
		| "handlePublicRequest"
		| "authenticate"
		| "withDashboard"
		| "dashboardManifest"
		| "serveDashboardFile"
	>,
): Promise<Response> {
	const p = url.pathname;

	// The removed agent surface, refused BEFORE anything else runs.
	//
	// First position is the guarantee. Answered any later, the refusal would be
	// conditional on the branches ahead of it — `/v1/code/…` would still
	// collect the identity-bound 501 rather than this 404 — and a client left
	// pointed at the old base URL would get an answer that varies by path
	// instead of one that always says where to point it.
	if (isLegacyRootAgentPath(p)) {
		return jsonError(
			HTTP_STATUS.NOT_FOUND,
			"not_found",
			`${p} is no longer served at the root. Point the client at ` +
				`${WIRE_MOUNTS.anthropic} (Anthropic Messages) or ${WIRE_MOUNTS.openai} ` +
				"(OpenAI Responses).",
		);
	}

	// Identity-bound endpoints are refused before ANY remaining routing. At the
	// root this arm covers `/api/oauth/*`, the part of the set the management
	// router does not own; the `/v1/code/…` half is answered by the legacy 404
	// above, because the root has no dispatch left for this refusal to stop.
	//
	// Ahead of the dashboard branch specifically: that branch decides by raw
	// pathname, so an encoded spelling like `/%61pi/oauth/profile` does not look
	// like an `/api/` path to it and would be answered with the dashboard's
	// index.html — no credential leaked, but not the deliberate, visible
	// refusal this is supposed to give.
	//
	// Ahead of the MANAGEMENT GATE below too, and that ordering is
	// load-bearing rather than incidental. Three of these paths sit under
	// `/api/` (`/api/oauth/files…`, `/api/oauth/file_upload`,
	// `/api/oauth/profile`) but they are AGENT traffic, not our management
	// surface — they arrive from a Claude Code client that has no dashboard
	// cookie and never will. Gated first, they would collect a 401 instead of
	// the deliberate 501, and an agent client reads an auth failure as a dead
	// session rather than as "this endpoint is not served". Declining to serve
	// a fixed, source-visible path list discloses nothing and needs no
	// credential.
	//
	// The proxy's ingest prologue calls the same predicate, and that is what
	// guarantees no request reaching the proxy by any route can be served with
	// a pooled token.
	if (isIdentityBoundPath(p)) {
		return createIdentityBoundRefusalResponse(p);
	}

	// The read-only widget surface. Its own namespace, checked BEFORE the
	// management gate and before the dashboard branch.
	//
	// Outside `/api/*` on purpose: the session gate is a path-prefix decision,
	// so putting a credential-free surface underneath it would mean the
	// exemption list is the only thing keeping a desk panel working. As a
	// sibling of the wire mounts it is unreachable from the gate by
	// construction. The 404 for an unknown `/public/*` path is answered here so
	// the namespace never falls through to the dashboard shell or to proxy
	// dispatch.
	if (isPublicApiPath(p)) {
		const publicResponse = await deps.handlePublicRequest(req, url);
		if (publicResponse) return publicResponse;
		return jsonError(
			HTTP_STATUS.NOT_FOUND,
			"not_found",
			`Unknown public API route: ${p}`,
		);
	}

	// The management gate, and it has to be HERE — above `handleApiRequest`,
	// not inside it.
	//
	// `handleApiRequest` returns its response to this function, which returns it
	// to the client; a check placed inside the API router would run after the
	// handler had already done its work, and `handleRequest` is reachable from
	// anywhere else that holds the router. So the boundary is the router's, and
	// it is expressed the same way the `/wire/*` mount expresses its own: an
	// EXPLICIT requirement passed to the auth service, rather than a
	// classification inferred a second time from the path.
	//
	// `managementAuthRequirement` is the single shared classification (the auth
	// service's `policyFor` reads the same function), so the exemptions cannot
	// drift between the two enforcement points: the three auth endpoints, and
	// the two Claude Code telemetry paths that a client configured the old way
	// still sends to the root. The telemetry pair is answered under
	// `/wire/anthropic` now, so at the root the exemption buys them the
	// management 404 below instead of a 401 a CLI would read as a dead
	// session.
	if (managementAuthRequirement(p) === "session") {
		let sessionResult: AuthenticationResult;
		try {
			sessionResult = await deps.authenticate(req, p, req.method, "session");
		} catch (authError) {
			return terminalForRequestError(req, authError, "auth", p);
		}
		if (!sessionResult.isAuthenticated) {
			return jsonError(
				401,
				"authentication_error",
				sessionResult.error || "Authentication failed",
			);
		}
	}

	// Try API routes first
	const apiResponse = await deps.handleApiRequest(url, req);
	if (apiResponse) {
		return apiResponse;
	}

	// Dashboard routes (only if enabled and assets are available)
	if (deps.withDashboard && deps.dashboardManifest) {
		// Serve dashboard static assets
		if (deps.dashboardManifest[p]) {
			return deps.serveDashboardFile(p, undefined, CACHE.CACHE_CONTROL_STATIC);
		}

		// For all non-API routes, serve the dashboard index.html (client-side
		// routing). This allows React Router to handle all dashboard routes
		// without maintaining a list.
		if (!p.startsWith("/api/")) {
			return deps.serveDashboardFile("/index.html", "text/html");
		}
	}

	// Unmatched /api/* paths get the management 404 rather than the generic
	// one, so an unknown management URL says which namespace it failed in.
	// Claude Code's own root telemetry paths land here too: they are answered
	// under `/wire/anthropic`, which is where a client configured for this
	// proxy sends them.
	if (isApiPath(p)) {
		return jsonError(
			HTTP_STATUS.NOT_FOUND,
			"not_found",
			`Unknown API route: ${p}`,
		);
	}

	// Everything else, in EVERY mode. With the dashboard on this is
	// unreachable, because the index.html branch already answered everything it
	// covers; headless and dashboard deployments otherwise answer identically.
	return jsonError(
		HTTP_STATUS.NOT_FOUND,
		"not_found",
		`Unknown route: ${p}. Agent traffic belongs under ${WIRE_MOUNTS.anthropic} ` +
			`or ${WIRE_MOUNTS.openai}.`,
	);
}

/**
 * The post-authentication chain for mounted agent traffic. The root reaches
 * nothing here: the mounts are the only entry point that dispatches.
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

	// Codex CLI probes GET /v1/models on startup to populate its model picker
	// and validate the configured model. ClankerMux has no models route, so
	// without this it falls through to the proxy and 400s ("Provider cannot
	// handle path: /v1/models") on every Codex startup. The reply shape depends
	// on the query string; see RequestRouterDeps.handleModels.
	if (req.method === "GET" && url.pathname === "/v1/models") {
		return await deps.handleModels(url, authResult.apiKeyId);
	}

	return await deps.dispatchProxy(
		req,
		url,
		authResult.apiKeyId,
		authResult.apiKeyName,
	);
}
