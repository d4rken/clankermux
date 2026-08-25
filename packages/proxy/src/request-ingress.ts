import {
	estimateContextWindowTokens,
	estimateRequestTokens,
	NETWORK,
	trackClientVersion,
} from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import {
	defaultProjectRules,
	getNativeResponsesRequestContext,
	type ProjectAttributionSource,
	type RequestMeta,
	setNativeResponsesMetaContext,
} from "@clankermux/types";
import { injectCacheTtl1h } from "./cache-ttl-injector";
import { computeContextAndToolStats } from "./context-composition";
import {
	createRequestMetadata,
	getForcedAccount,
	type ProxyContext,
	prepareRequestBody,
	RequestBodyContext,
	validateProviderPath,
} from "./handlers";
import {
	createIdentityBoundRefusalResponse,
	isIdentityBoundPath,
} from "./identity-bound-paths";
import { isAnchoredSource, resolveProject } from "./project-extraction";
import { parseReasoningEffort } from "./reasoning-effort";
import { extractRequestAffinity } from "./request-affinity";
import { sessionProjectCache } from "./session-project-cache";
import { sessionPromotionTracker } from "./session-promotion";
import { unmatchedPathTracker } from "./unmatched-paths";

// Same channel name as handleProxy's own logger: this module was carved out of
// it, and the log lines below must keep their historical prefix.
const log = new Logger("Proxy");

/**
 * Everything the request-ingest prologue derives for the rest of handleProxy.
 * Values that exist only to produce these (the parsed body, the raw affinity,
 * the promotion-path token estimate, …) stay module-internal.
 */
export interface IngressContext {
	requestBodyContext: RequestBodyContext;
	finalBodyBuffer: ArrayBuffer | null;
	/**
	 * Fresh stream over `finalBodyBuffer` on every call (undefined for a bodyless
	 * request).
	 *
	 * KNOWN DEBT: `proxyWithAccount` binds this as `_createBodyStream` and does
	 * not read it in its mainline — it only forwards it at one internal site.
	 * Tracing and removing that parameter chain is deferred to a later tranche
	 * because it lives in proxy-operations.ts, which is out of scope here.
	 */
	finalCreateBodyStream: () => ReadableStream<Uint8Array> | undefined;
	effectiveRequestModel: string | null;
	gateTokenEstimate: number;
	project: string | null;
	projectAttributionSource: ProjectAttributionSource | null;
	requestMeta: RequestMeta;
	bumpIdleTimeout: () => void;
	/**
	 * Whether {@link bumpIdleTimeout} can actually reach this connection's
	 * socket. False on the translated Codex `/v1/responses` path, where the
	 * `Request` handed to handleProxy is synthetic and `server.timeout` is a
	 * no-op — such connections are hard-capped by Bun's base idleTimeout and
	 * must not be held past it. Derived from the adapter's unspoofable
	 * per-request context, NOT from a client-visible header.
	 */
	canRearmIdleTimeout: boolean;
}

/**
 * Either the prologue already answered the request (the internal-endpoint
 * short-circuit or the `/v1/messages` validation rejection) or it produced the
 * context the routing pipeline runs on.
 */
export type IngressResult =
	| { kind: "response"; response: Response }
	| { kind: "context"; context: IngressContext };

/**
 * Request-ingest prologue: everything handleProxy does between entry and
 * account selection — internal-endpoint short-circuit, client-version
 * tracking, provider-path validation, body buffering/parsing, project
 * attribution, context/tool stats, affinity, token estimates, the predictive
 * 1h-TTL promotion, `/v1/messages` validation, the tier-4 seed commit, and
 * request-metadata construction.
 *
 * @throws {ValidationError} If the provider cannot handle the path
 *         (`validateProviderPath` — deliberately propagated, not caught).
 */
export async function ingestProxyRequest(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	apiKeyId: string | null | undefined,
	isInternal: boolean,
): Promise<IngressResult> {
	// 0a. Refuse identity-bound endpoints outright. These belong to a single
	// Anthropic OAuth identity, so a pooled account token must never be sent to
	// them — see identity-bound-paths.ts. Refusing HERE, at the ingest
	// short-circuit, is what makes that guarantee structural: this returns
	// before the dashboard ingress announcement, before account selection, and
	// without a Request History row, so there is no path from one of these URLs
	// to an upstream request on someone else's credential.
	if (isIdentityBoundPath(url.pathname)) {
		return {
			kind: "response",
			response: createIdentityBoundRefusalResponse(url.pathname),
		};
	}

	// 0b. Silently ignore Claude Code internal endpoints (non-critical, not supported by all providers)
	if (
		url.pathname === "/api/event_logging/batch" ||
		url.pathname === "/api/system/package-manager"
	) {
		return {
			kind: "response",
			response: new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		};
	}

	// 1. Track client version from user-agent for use in auto-refresh
	trackClientVersion(req.headers.get("user-agent"));

	// Best-effort re-arm of this connection's Bun idle timer. Called on a
	// timer during long holds (CW hold) and long quiet streaming gaps so a
	// connection held without bytes isn't reaped by the 180s base idleTimeout.
	// Best-effort by design: on the Codex /v1/responses translation path the
	// `req` handed to handleProxy is synthetic and does not map to the original
	// socket, so server.timeout is a no-op there and the connection degrades to
	// the flat 180s base. That is NOT universally harmless: the CW / burst holds
	// exclude Codex, but the OVERLOAD hold does not, so a hold budget above 180s
	// would have us close such a connection mid-hold. `canRearmIdleTimeout`
	// below is the capability those holds read to pick a safe budget.
	// ctx.server is unset in unit tests (optional).
	const bumpIdleTimeout = () => {
		try {
			ctx.server?.timeout(req, NETWORK.SERVER_IDLE_TIMEOUT_SECONDS);
		} catch {
			// server.timeout can throw if the req isn't a tracked connection
		}
	};

	// 2. Validate provider can handle path
	validateProviderPath(ctx.provider, url.pathname);

	// 3. Prepare request body
	const { buffer: requestBodyBuffer } = await prepareRequestBody(req);
	const requestBodyContext = new RequestBodyContext(requestBodyBuffer);

	// Extract model from request body for family detection (used by combo routing)
	// and reuse parsed body for /v1/messages validation (consolidate parses)
	const parsedBody = requestBodyContext.getParsedJson();
	const requestModel = requestBodyContext.getModel();
	const resolved = resolveProject(
		req.method,
		url.pathname,
		req.headers,
		parsedBody,
		apiKeyId ?? null,
		sessionProjectCache,
		// Optional call with an honest fallback, the same shape as
		// `ctx.config.getStorePayloads?.() ?? true` in response-handler. A Config
		// that predates this method (or a test stub that does not mock it) gets
		// the built-in defaults, which is exactly what an unconfigured deployment
		// gets — not an empty rule set, which would attribute nothing at all.
		ctx.config.getProjectRules?.() ?? defaultProjectRules(),
	);
	// A working directory that matched no rule is the operator's cue to add a
	// project root; without this the new "return nothing rather than guess"
	// behaviour would be correct but invisible.
	if (resolved.source === "none" && resolved.unmatchedPath) {
		unmatchedPathTracker.record(resolved.unmatchedPath);
	}
	const project = resolved.project;
	// Which tier produced it (null = the request was never eligible). Carried
	// beside `project` so the persisted row records HOW it was attributed.
	const projectAttributionSource = resolved.source;
	// Ingest-time context composition + per-tool call/error stats: walk the
	// already-parsed body once (no second JSON.parse) for proxied /v1/messages
	// requests only. null for other endpoints / unparseable bodies → context_*
	// columns stay NULL and no tool-call rows are written.
	const { composition: contextComposition, toolStats: toolCallStats } =
		req.method === "POST" && url.pathname === "/v1/messages"
			? computeContextAndToolStats(parsedBody)
			: { composition: null, toolStats: null };
	const affinity = extractRequestAffinity(req.headers);

	// Coarse request-size estimate for the cache-warming session-promotion path
	// (below). Kept on the legacy formula so promotion behavior is unchanged.
	const requestTokenEstimate = estimateRequestTokens(
		parsedBody,
		contextComposition,
	);

	// Calibrated token estimate for the context-window gate (B1): gates Codex
	// accounts whose mapped model can't fit the request (B3) and builds the
	// context_window_exceeded error (B4). Distinct from the promotion estimate —
	// see estimateContextWindowTokens for why (accurate divisor + capped output
	// reservation).
	const gateTokenEstimate = estimateContextWindowTokens(
		parsedBody,
		contextComposition,
	);

	// 3b. Predictive 1-hour-TTL promotion (Session Cache Bridge, Phase 2).
	// For a real (session-keyed) request, observe the session in the promotion
	// tracker and, once it's promoted AND large enough, rewrite its ephemeral
	// cache breakpoints to ttl:"1h". This mutates requestBodyContext in place, so
	// the finalBodyBuffer below — and the staged keepalive body downstream — both
	// carry the 1h injection, letting ~50-min keepalives bridge an idle session
	// for HOURS instead of ~15 min. Synthetic keepalive/auto-refresh requests strip
	// the session header so affinity.key is null → naturally excluded. Gated on the
	// cache-warming feature (same switch the keepalive scheduler uses).
	//
	// SKIP entirely when a GLOBAL forced account is active (getForcedAccount() set,
	// non-internal request — the exact condition that routes to proxyForcedAccount
	// at §4b below). That path forwards the injected body upstream — paying the 2x
	// 1h-write premium — but never calls cacheBodyStore.stageRequest(), so no warm
	// slot is created and there is zero keepalive/bridging benefit to offset the
	// premium. We don't even observe the session: the forced path can't bridge it,
	// so promotion bookkeeping for it is pointless. The HEADER force-route
	// (x-clankermux-account-id) is unaffected — it goes through proxyWithAccount,
	// which DOES stage, so injection + staging still happen for it.
	const globalForcedActive = !isInternal && getForcedAccount() !== null;
	if (
		ctx.config.getCacheWarmingEnabled() &&
		affinity.key &&
		!globalForcedActive
	) {
		if (
			sessionPromotionTracker.observeAndShouldInject(
				affinity.key,
				Date.now(),
				requestTokenEstimate,
				ctx.config.getCacheWarmingMinTokens(),
			)
		) {
			injectCacheTtl1h(requestBodyContext);
		}
	}

	// 3a. Validate request body for /v1/messages endpoint
	if (url.pathname === "/v1/messages" && requestBodyBuffer) {
		if (parsedBody) {
			// Reject requests without messages field (e.g., Claude Code internal events)
			if (!parsedBody.messages || !Array.isArray(parsedBody.messages)) {
				log.warn(
					`Rejected invalid request to /v1/messages without messages field`,
					{
						event_type: parsedBody.event_type,
						event_name: (
							parsedBody.event_data as Record<string, unknown> | undefined
						)?.event_name,
					},
				);
				return {
					kind: "response",
					response: new Response(
						JSON.stringify({
							type: "error",
							error: {
								type: "invalid_request_error",
								message:
									"messages: Field required for /v1/messages endpoint. Internal events should not be proxied.",
							},
						}),
						{
							status: 400,
							headers: { "Content-Type": "application/json" },
						},
					),
				};
			}
		} else {
			// If we can't parse the body, let it through and let the provider handle it
			log.debug("Could not parse request body for validation");
		}
	}

	// 3c. Tier-4 seed commit: the request survived validation (can no longer be
	// 400-rejected above), so it's safe to remember session → project for
	// signal-less sibling requests (sidechains, title generation, count_tokens).
	if (isAnchoredSource(resolved.source) && resolved.sessionKey && project) {
		const previousProject = sessionProjectCache.set(
			resolved.sessionKey,
			project,
		);
		if (previousProject !== null && previousProject !== project) {
			log.debug(
				`Session ${resolved.sessionKey} transitioned projects: ${previousProject} -> ${project}`,
			);
		}
	}

	const finalBodyBuffer = requestBodyContext.getBuffer();
	const finalCreateBodyStream = () => {
		if (!finalBodyBuffer) return undefined;
		return new Response(finalBodyBuffer).body ?? undefined;
	};

	const effectiveRequestModel = requestBodyContext.getModel() ?? requestModel;

	// 4. Create request metadata
	const requestMeta = createRequestMetadata(req, url);
	// Native Responses passthrough: re-key the adapter's Request-scoped context
	// onto the RequestMeta so it reaches each per-account attempt downstream.
	const nativeResponsesCtx = getNativeResponsesRequestContext(req);
	if (nativeResponsesCtx) {
		setNativeResponsesMetaContext(requestMeta, nativeResponsesCtx);
	}
	requestMeta.internal = isInternal;
	requestMeta.affinityKey = affinity.key;
	requestMeta.affinityScope = affinity.scope;
	requestMeta.affinityPartition = apiKeyId ? `api_key:${apiKeyId}` : null;
	requestMeta.project = project;
	requestMeta.projectAttributionSource = projectAttributionSource;
	requestMeta.requestedModel = effectiveRequestModel ?? null;
	requestMeta.contextComposition = contextComposition;
	requestMeta.toolCallStats = toolCallStats;
	// Per-request reasoning effort, derived once for all failover attempts. The
	// Codex path's translated Anthropic body loses reasoning.effort, so fall
	// back to the value captured from the ORIGINAL Responses body (Stage A).
	requestMeta.reasoningEffort =
		parseReasoningEffort(parsedBody) ??
		nativeResponsesCtx?.reasoningEffort ??
		null;
	// Unconditional floor for Codex-CLI traffic: the /v1/responses adapter sets
	// this header on every request it forwards. When set, the request may never
	// be routed to (or burst-held on) an official Claude account — independent of
	// any API-key pin or auth config.
	requestMeta.excludeOfficialAnthropic =
		req.headers.get("x-clankermux-deny-official-anthropic") === "1";

	return {
		kind: "context",
		context: {
			requestBodyContext,
			finalBodyBuffer,
			finalCreateBodyStream,
			effectiveRequestModel,
			gateTokenEstimate,
			project,
			projectAttributionSource,
			requestMeta,
			bumpIdleTimeout,
			// The adapter's context is set from an in-process WeakMap keyed on the
			// Request object, so unlike the deny-official-anthropic header it
			// cannot be forged by a client to change its own hold budget.
			canRearmIdleTimeout: nativeResponsesCtx === undefined,
		},
	};
}
