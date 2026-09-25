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

export interface SdkBridgeCounters {
	turnsStarted: number;
	turnsCompleted: number;
	turnsFailed: number;
	continuations: number;
	/** Turns refused before any Claude Code process, by reason. */
	rejected: Record<string, number>;
	resumes: number;
	rebuilds: number;
	/** Side requests started; each also counts in `turnsStarted`. */
	sideRequests: number;
}

/** The bridge's live state, as `/api/system/status` reports it. */
export interface SdkBridgeStatus {
	availability: SdkBridgeAvailability;
	/** Claude Code queries alive, parked ones included. */
	live: number;
	/** Queries waiting on the client's tool results. */
	parked: number;
	cap: number;
	counters: SdkBridgeCounters;
	/** Highest per-process peak RSS observed (VmHWM); null where unmeasurable. */
	peakRssBytes: number | null;
}

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

/**
 * The model id Claude Code puts on the wire for a planned upstream model.
 * Claude Code resolves a `[1m]` suffix itself (it turns on the 1M-context beta
 * header) and sends the bare id:
 *
 *   "claude-fable-5-1[1m]" → "claude-fable-5-1"
 *   "claude-sonnet-5"      → "claude-sonnet-5"
 */
export function sdkBridgeWireModel(upstreamModel: string): string {
	return upstreamModel.replace(/\[1m\]$/i, "");
}

/**
 * The plan candidates an inner call for `model` may use: those whose upstream
 * model is `model`, either as planned or in the form Claude Code sends.
 */
export function sdkBridgeCandidatesForModel(
	plan: SdkBridgeRoutePlan,
	model: string,
): SdkBridgeRouteCandidate[] {
	return plan.candidates.filter(
		(c) =>
			c.upstreamModel === model ||
			sdkBridgeWireModel(c.upstreamModel) === model,
	);
}

/**
 * What the client asked for that the translated Messages body cannot show.
 * The Responses adapter writes its own `max_tokens` when the client set no
 * `max_output_tokens`, and drops `temperature` and `top_p`.
 */
export interface SdkBridgeTranslationGaps {
	/** The body's `max_tokens` is the adapter's default, not the client's limit. */
	readonly maxTokensDefaulted: boolean;
	/** Fields the client set that the translation dropped, by their Messages name. */
	readonly droppedFields: readonly string[];
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
	/** Null when the body is the client's own request, or an exact translation. */
	readonly translationGaps: SdkBridgeTranslationGaps | null;
	/** The client's {@link SDK_BRIDGE_PI_PROMPT_HEADER}, sanitized; null when absent. */
	readonly piPromptVersion: string | null;
	/** The client's {@link SDK_BRIDGE_SIDE_REQUEST_HEADER}, sanitized; null when absent. */
	readonly sideRequest: string | null;
}

/** The pi prompt-layout version a pi client declares, e.g. `0.87`. */
export const SDK_BRIDGE_PI_PROMPT_HEADER = "x-clankermux-pi-prompt";

/**
 * The pi prompt layouts the SDK bridge serves, each with fixtures. Discovery
 * publishes them so pi can warn before a Claude turn is refused.
 */
export const SUPPORTED_PI_PROMPT_VERSIONS: readonly string[] = ["0.87"];

/**
 * Marks a client's auxiliary request (pi's recap and session title) that
 * must not become the conversation's next turn.
 */
export const SDK_BRIDGE_SIDE_REQUEST_HEADER = "x-clankermux-side-request";

/**
 * The side-request mode the bridge serves: the request runs on a copy of the
 * conversation's stored Claude Code session, whose own session stays as it was.
 */
export const SDK_BRIDGE_SIDE_REQUEST_FORK = "session-fork-v1";

/**
 * A declaration header as the bridge may echo it in a refusal and record it:
 * printable ASCII, trimmed, at most 32 characters; null when absent or blank.
 *
 *   " 0.87 "          → "0.87"
 *   "0.9\t" + 40 × 9 → "0.9" + 29 × 9
 */
export function sdkBridgeHeaderToken(
	headers: Headers,
	name: string,
): string | null {
	const value = headers
		.get(name)
		?.replace(/[^\x20-\x7e]/g, "")
		.trim()
		.slice(0, 32);
	return value || null;
}

/** Whether the request declares the side-request mode the bridge serves. */
export function isSdkBridgeSideRequestFork(headers: Headers): boolean {
	return (
		sdkBridgeHeaderToken(headers, SDK_BRIDGE_SIDE_REQUEST_HEADER) ===
		SDK_BRIDGE_SIDE_REQUEST_FORK
	);
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
	/**
	 * The live parked turn waiting on these tool_result ids now, if any. Ids a
	 * turn handed out in an earlier round do not select it. When the caller's
	 * own turn waits on them but the caller names another model, that turn is
	 * torn down and this answers null, so the request starts a fresh turn.
	 */
	findContinuation(
		toolUseIds: readonly string[],
		caller: { apiKeyId: string | null; model: string },
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

/**
 * Every Claude Code slot (or rebuild slot) is taken. The outer attempt fails
 * over like any unavailability, but when no other candidate serves, this is
 * the answer the client gets: the bridge's 529 and its Retry-After, not a
 * generic pool-exhausted 503.
 */
export class SdkBridgeCapacityError extends SdkBridgeUnavailableError {
	readonly status: number;
	readonly errorType: string;
	readonly retryAfter: string | null;
	/** `process_cap` or `rebuild_cap`. */
	readonly reason: string;

	constructor(input: {
		reason: string;
		status: number;
		type: string;
		message: string;
		retryAfter: string | null;
	}) {
		super(input.message);
		this.name = "SdkBridgeCapacityError";
		this.reason = input.reason;
		this.status = input.status;
		this.errorType = input.type;
		this.retryAfter = input.retryAfter;
	}

	/** The terminal answer, built fresh on every call (a body reads once). */
	terminalResponse(headers: Record<string, string> = {}): Response {
		const out = new Headers({
			"content-type": "application/json",
			...headers,
		});
		if (this.retryAfter) out.set("retry-after", this.retryAfter);
		return new Response(
			JSON.stringify({
				type: "error",
				error: { type: this.errorType, message: this.message },
			}),
			{ status: this.status, headers: out },
		);
	}
}

export interface SdkBridgeInnerOutcome {
	requestId: string;
	status: number;
	errorType: string | null;
	/** The error's `code`, when it had one: a nonblank string, capped. */
	errorCode?: string | null;
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
	/** An inner call's `requests` row has begun; once per request id. */
	readonly onInnerRequestStarted?: (requestId: string) => void;
	/**
	 * How an inner call ended, once per call. A streamed reply reports when its
	 * stream ends, so an error event inside a 200 counts as the error it is.
	 * A refusal before dispatch reports with an empty `requestId`.
	 */
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
