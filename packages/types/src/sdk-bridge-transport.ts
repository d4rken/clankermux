import type { RequestMeta } from "./api";
import type { ProjectAttributionSource } from "./request";

// The seam between the proxy and the Claude Agent SDK bridge. The proxy owns
// routing and hands the bridge a frozen plan; the bridge runs Claude Code, whose
// own model calls come back through the proxy as ordinary requests carrying an
// SdkBridgeInnerContext.

export type SdkBridgeAvailability =
	| { state: "available" }
	| { state: "unavailable"; reason: string }
	| { state: "shutting_down" };

export interface SdkBridgeRouteCandidate {
	readonly accountId: string;
	readonly provider: string;
	readonly upstreamModel: string;
}

/**
 * Where a bridged turn's inner calls may go, frozen once the outer attempt has
 * picked its alias stage and final candidate order. Inner calls never re-resolve
 * pin, rules, force or alias; they only re-check availability and permissions.
 */
export interface SdkBridgeRoutePlan {
	readonly turnId: string;
	/** Snapshot of the outer route (the alias stage, when there is one). */
	readonly routeSnapshot: string | null;
	/** Official Anthropic candidates only, in the outer attempt's order. */
	readonly candidates: readonly SdkBridgeRouteCandidate[];
	/** The account the outer attempt landed on. */
	readonly preferredAccountId: string;
	readonly apiKeyId: string | null;
	readonly apiKeyName: string | null;
}

/** Facts about the outer request that the bridge records and forwards. */
export interface SdkBridgeTurnMeta {
	/** The outer request id, which the client sees as `x-clankermux-request-id`. */
	readonly legId: string;
	readonly apiKeyId: string | null;
	readonly apiKeyName: string | null;
	readonly clientHarness: string | null;
	readonly clientUserAgent: string | null;
	readonly project: string | null;
	readonly projectAttributionSource: ProjectAttributionSource | null;
	readonly affinityScope: string | null;
	readonly affinityKey: string | null;
	readonly model: string;
	readonly reasoningEffort: string | null;
}

export interface SdkBridgeTransport {
	availability(): SdkBridgeAvailability;
	/**
	 * Start a new user turn. Resolves with an Anthropic Messages response (SSE
	 * or JSON). Inference failures are error Responses; it throws
	 * {@link SdkBridgeUnavailableError} only when the bridge itself cannot run.
	 */
	startTurn(input: {
		request: Request;
		plan: SdkBridgeRoutePlan;
		meta: SdkBridgeTurnMeta;
		signal: AbortSignal;
		bumpIdleTimeout?: () => void;
	}): Promise<Response>;
	/** The live parked turn these tool_result ids answer, if any. */
	findContinuation(
		toolUseIds: readonly string[],
	): { turnId: string; ownerApiKeyId: string | null } | null;
	continueTurn(input: {
		turnId: string;
		request: Request;
		meta: SdkBridgeTurnMeta;
		signal: AbortSignal;
		bumpIdleTimeout?: () => void;
	}): Promise<Response>;
}

/** The bridge cannot run this turn at all; the outer attempt may fail over. */
export class SdkBridgeUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SdkBridgeUnavailableError";
	}
}

export interface SdkBridgeInnerOutcome {
	requestId: string;
	status: number;
	errorType: string | null;
	message: string | null;
	retryAfter: string | null;
	accountId: string | null;
}

/**
 * Trusted context for a bridge inner call (Claude Code to the proxy). Carried
 * by WeakMap on the Request object and never by header, so a client cannot
 * create or widen it.
 */
export interface SdkBridgeInnerContext {
	readonly turnId: string;
	readonly plan: SdkBridgeRoutePlan;
	readonly apiKeyId: string | null;
	readonly apiKeyName: string | null;
	readonly clientHarness: string | null;
	readonly project: string | null;
	readonly projectAttributionSource?: ProjectAttributionSource | null;
	/** Epoch ms after which an inner call is refused. */
	readonly deadlineAt: number;
	readonly onInnerOutcome?: (outcome: SdkBridgeInnerOutcome) => void;
}

const innerRequestContexts = new WeakMap<Request, SdkBridgeInnerContext>();
const innerMetaContexts = new WeakMap<RequestMeta, SdkBridgeInnerContext>();

export function setSdkBridgeInnerRequestContext(
	req: Request,
	ctx: SdkBridgeInnerContext,
): void {
	innerRequestContexts.set(req, ctx);
}

export function getSdkBridgeInnerRequestContext(
	req: Request,
): SdkBridgeInnerContext | undefined {
	return innerRequestContexts.get(req);
}

export function setSdkBridgeInnerMetaContext(
	meta: RequestMeta,
	ctx: SdkBridgeInnerContext,
): void {
	innerMetaContexts.set(meta, ctx);
}

export function getSdkBridgeInnerMetaContext(
	meta: RequestMeta,
): SdkBridgeInnerContext | undefined {
	return innerMetaContexts.get(meta);
}
