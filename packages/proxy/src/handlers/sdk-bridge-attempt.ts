import { Logger } from "@clankermux/logger";
import {
	type Account,
	getNativeResponsesMetaContext,
	type RequestMeta,
	type SdkBridgeRoutePlan,
	type SdkBridgeTransport,
	type SdkBridgeTurnMeta,
	SdkBridgeUnavailableError,
} from "@clankermux/types";
import { getPoolHeadroomCandidates } from "../pool-headroom";
import { isOfficialAnthropicProvider } from "../provider-overload-cooldown";
import { getResolvedRoute, RoutingPolicyError } from "../resolved-route";
import {
	type RoutingAttemptAudit,
	sendAuthorizedRequest,
} from "../routing-dispatch";
import { createClientAbortResponse } from "./client-abort-response";
import type { ProxyContext } from "./proxy-types";

const log = new Logger("SdkBridgeAttempt");

/**
 * Whether this attempt is served by the SDK bridge rather than a direct fetch:
 * a request under the floor for non-Claude-Code clients, landing on an official
 * Anthropic account. Route construction only lets such an account through when
 * the bridge was available.
 */
export function isSdkBridgeAttempt(
	meta: RequestMeta,
	account: Account,
): boolean {
	return (
		meta.officialAnthropicVia === "sdk-bridge" &&
		isOfficialAnthropicProvider(account.provider)
	);
}

/** Client credentials and proxy-internal markers never reach the bridge. */
const STRIPPED_HEADERS = [
	"authorization",
	"x-api-key",
	"proxy-authorization",
	"cookie",
	"content-length",
	"x-clankermux-synthetic-response",
	"x-clankermux-synthetic-status",
	"x-clankermux-retry-after",
	"x-clankermux-upstream-model",
];

/**
 * The official Anthropic subset of this attempt's candidate order, each with
 * the model the route sends it. The order is the one the attempt loop is
 * walking: every gate and reorder has run, and for an alias it is the current
 * stage's. A forced attempt has no candidate list, only its own account.
 */
export function buildSdkBridgeRoutePlan(
	meta: RequestMeta,
	account: Account,
	apiKeyId: string | null,
	apiKeyName: string | null,
): SdkBridgeRoutePlan {
	const route = getResolvedRoute(meta);
	const ordered = getPoolHeadroomCandidates(meta) ?? [];
	const pool = ordered.some((a) => a.id === account.id)
		? ordered
		: [account, ...ordered];
	const candidates = pool.flatMap((a) => {
		const target = isOfficialAnthropicProvider(a.provider)
			? route.target(a)
			: null;
		return target
			? [
					Object.freeze({
						accountId: a.id,
						provider: a.provider,
						upstreamModel: target.upstreamModel,
					}),
				]
			: [];
	});
	return Object.freeze({
		turnId: crypto.randomUUID(),
		routeSnapshot: route.snapshot,
		candidates: Object.freeze(candidates),
		preferredAccountId: account.id,
		apiKeyId,
		apiKeyName,
	});
}

export function sdkBridgeTurnMeta(
	meta: RequestMeta,
	apiKeyId: string | null,
	apiKeyName: string | null,
): SdkBridgeTurnMeta {
	return {
		legId: meta.id,
		apiKeyId,
		apiKeyName,
		clientHarness: meta.clientHarness ?? null,
		clientUserAgent: meta.clientUserAgent ?? null,
		project: meta.project ?? null,
		projectAttributionSource: meta.projectAttributionSource ?? null,
		affinityScope: meta.affinityScope ?? null,
		affinityKey: meta.affinityKey ?? null,
		model: meta.requestedModel ?? "",
		reasoningEffort: meta.reasoningEffort ?? null,
		translationGaps:
			getNativeResponsesMetaContext(meta)?.translationGaps ?? null,
	};
}

/** A fresh Request for the bridge, carrying `body` and the client's headers. */
export function sdkBridgeRequest(
	req: Request,
	url: URL,
	body: ArrayBuffer | null,
): Request {
	const headers = new Headers(req.headers);
	for (const name of STRIPPED_HEADERS) headers.delete(name);
	headers.set("content-type", "application/json");
	return new Request(url, { method: req.method, headers, body });
}

export type SdkBridgeAttemptResult =
	| { kind: "response"; response: Response }
	/** Nothing ran; the caller may move on to its next candidate. */
	| { kind: "unavailable"; reason: string };

/**
 * One attempt served by the SDK bridge. It runs none of the direct path's
 * account handling: no cache staging, no token resolution, no cooldown or
 * overload classification, no holds and no request row. Claude Code's own
 * model calls come back as ordinary requests and own all of that, so whatever
 * the bridge answers is this request's final response.
 *
 * Authorization still goes through {@link sendAuthorizedRequest}, which
 * re-checks the destination, verifies the outgoing model and records the
 * attempt as an `upstream_send`.
 */
export async function proxyViaSdkBridge(input: {
	req: Request;
	url: URL;
	account: Account;
	requestMeta: RequestMeta;
	ctx: ProxyContext;
	/** The request body with the route's model already applied. */
	body: ArrayBuffer | null;
	apiKeyId: string | null;
	apiKeyName: string | null;
	audit: RoutingAttemptAudit;
	bumpIdleTimeout?: () => void;
}): Promise<SdkBridgeAttemptResult> {
	const { req, account, requestMeta, ctx } = input;
	const bridge: SdkBridgeTransport | undefined = ctx.sdkBridge;
	const availability = bridge?.availability() ?? {
		state: "unavailable" as const,
		reason: "not configured",
	};
	if (!bridge || availability.state !== "available")
		return {
			kind: "unavailable",
			reason:
				availability.state === "unavailable"
					? availability.reason
					: "shutting down",
		};
	const plan = buildSdkBridgeRoutePlan(
		requestMeta,
		account,
		input.apiKeyId,
		input.apiKeyName,
	);
	const meta = sdkBridgeTurnMeta(requestMeta, input.apiKeyId, input.apiKeyName);
	try {
		const response = await sendAuthorizedRequest(
			sdkBridgeRequest(req, input.url, input.body),
			account,
			requestMeta,
			ctx,
			req.signal,
			input.audit,
			null,
			undefined,
			(request) =>
				bridge.startTurn({
					request,
					plan,
					meta,
					signal: req.signal,
					bumpIdleTimeout: input.bumpIdleTimeout,
				}),
		);
		return { kind: "response", response };
	} catch (error) {
		if (error instanceof RoutingPolicyError) throw error;
		if (error instanceof SdkBridgeUnavailableError)
			return { kind: "unavailable", reason: error.message };
		// The transport promises to answer inference failures as Responses, so
		// this is a bridge defect. It is still final: failing over would start a
		// second Claude Code query for the same turn.
		if (req.signal.aborted)
			return { kind: "response", response: createClientAbortResponse() };
		log.error(`SDK bridge turn on ${account.name} failed`, error);
		return {
			kind: "response",
			response: errorResponse(502, "api_error", "SDK bridge turn failed"),
		};
	}
}

/**
 * The tool_use ids answered by the request's last user message: the ids a
 * parked bridge turn is waiting on when this request continues it.
 */
export function lastUserToolResultIds(body: unknown): string[] {
	const messages = (body as { messages?: unknown } | null)?.messages;
	if (!Array.isArray(messages)) return [];
	const last = [...messages]
		.reverse()
		.find(
			(m): m is { content: unknown } =>
				!!m &&
				typeof m === "object" &&
				(m as { role?: unknown }).role === "user",
		);
	if (!last || !Array.isArray(last.content)) return [];
	return last.content.flatMap((block: unknown) => {
		const b = block as { type?: unknown; tool_use_id?: unknown } | null;
		return b?.type === "tool_result" && typeof b.tool_use_id === "string"
			? [b.tool_use_id]
			: [];
	});
}

function errorResponse(status: number, type: string, message: string) {
	return Response.json({ type: "error", error: { type, message } }, { status });
}

/**
 * Hand a request that answers a parked bridge turn's tool calls straight to
 * that turn, before any routing: the turn keeps its frozen plan, its Claude
 * Code query and its project, and no second query starts. Null when the
 * request is not such a continuation; ids the bridge does not know take the
 * ordinary route, where the bridge answers a turn that is gone.
 */
export async function continueParkedSdkBridgeTurn(input: {
	req: Request;
	url: URL;
	ctx: ProxyContext;
	requestMeta: RequestMeta;
	parsedBody: unknown;
	body: ArrayBuffer | null;
	apiKeyId: string | null;
	apiKeyName: string | null;
	bumpIdleTimeout?: () => void;
}): Promise<Response | null> {
	const { req, ctx, requestMeta } = input;
	const bridge = ctx.sdkBridge;
	if (requestMeta.officialAnthropicVia !== "sdk-bridge" || !bridge) return null;
	const ids = lastUserToolResultIds(input.parsedBody);
	if (!ids.length) return null;
	const parked = bridge.findContinuation(ids);
	if (!parked) return null;
	if (parked.ownerApiKeyId !== input.apiKeyId)
		return errorResponse(
			409,
			"sdk_bridge_turn_conflict",
			"These tool results answer a turn that belongs to another API key",
		);
	try {
		return await bridge.continueTurn({
			turnId: parked.turnId,
			request: sdkBridgeRequest(req, input.url, input.body),
			meta: sdkBridgeTurnMeta(requestMeta, input.apiKeyId, input.apiKeyName),
			signal: req.signal,
			bumpIdleTimeout: input.bumpIdleTimeout,
		});
	} catch (error) {
		if (req.signal.aborted) return createClientAbortResponse();
		if (error instanceof SdkBridgeUnavailableError)
			return errorResponse(
				503,
				"sdk_bridge_unavailable",
				`The SDK bridge cannot continue this turn: ${error.message}`,
			);
		log.error(`SDK bridge continuation of turn ${parked.turnId} failed`, error);
		return errorResponse(502, "api_error", "SDK bridge turn failed");
	}
}
