import { Logger } from "@clankermux/logger";
import type {
	Account,
	RequestMeta,
	RequestRoutingMeta,
} from "@clankermux/types";
import type { ProxyContext } from "./handlers/proxy-types";

const log = new Logger("PreHeadClientAbort");

/**
 * One upstream send of a request, as it stood when its fetch went out. Frozen:
 * a later alias stage or failover rewrites `RequestMeta.routing` in place, and
 * the record of this send must keep what applied to it.
 */
export interface UpstreamDispatch {
	readonly attemptId: string;
	readonly account: Readonly<
		Pick<
			Account,
			| "id"
			| "name"
			| "provider"
			| "custom_endpoint"
			| "billing_type"
			| "auto_pause_on_overage_enabled"
		>
	>;
	/** Name of the provider handler that served the account. */
	readonly providerName: string;
	readonly routing: Readonly<RequestRoutingMeta> | null;
	/** The attempt's failover count, as `forwardToClient` would have recorded it. */
	readonly failoverAttempts: number;
	readonly startedAt: number;
}

interface Tracking {
	readonly clientSignal: AbortSignal;
	/** Failover count of the attempt now running. */
	failoverAttempts: number;
	last: UpstreamDispatch | null;
	/** Whether {@link Tracking.last} has neither completed nor been judged. */
	lastInFlight: boolean;
	/** Every send, same-account retries included. Never a failover count. */
	sends: number;
	bridged: boolean;
	/** {@link Tracking.last} and its in-flight state when the client left. */
	atAbort: { dispatch: UpstreamDispatch; inFlight: boolean } | null;
}

const tracked = new WeakMap<RequestMeta, Tracking>();

/**
 * Follow a request's upstream sends so that, if its client leaves before any
 * response starts, the request can be recorded against the send it abandoned.
 * The abort listener freezes the in-flight state at the moment the client
 * left, before anything reacting to the abort can settle the send.
 *
 * Returns the release for the listener.
 */
export function trackPreHeadClientAbort(
	meta: RequestMeta,
	clientSignal: AbortSignal,
): () => void {
	const state: Tracking = {
		clientSignal,
		failoverAttempts: 0,
		last: null,
		lastInFlight: false,
		sends: 0,
		bridged: false,
		atAbort: null,
	};
	tracked.set(meta, state);
	const onAbort = () => {
		if (state.last)
			state.atAbort = { dispatch: state.last, inFlight: state.lastInFlight };
	};
	clientSignal.addEventListener("abort", onAbort, { once: true });
	return () => clientSignal.removeEventListener("abort", onAbort);
}

/** An account attempt begins, carrying this failover count. */
export function notePreHeadAttempt(
	meta: RequestMeta,
	failoverAttempts: number,
): void {
	const state = tracked.get(meta);
	if (state) state.failoverAttempts = failoverAttempts;
}

/**
 * The network fetch for an attempt is being initiated. A send that starts
 * after the client already left is not the send it abandoned, so it is not
 * counted.
 */
export function noteUpstreamDispatch(
	meta: RequestMeta,
	send: Pick<UpstreamDispatch, "attemptId" | "account" | "providerName">,
): void {
	const state = tracked.get(meta);
	if (!state || state.clientSignal.aborted) return;
	const { account } = send;
	state.last = Object.freeze({
		attemptId: send.attemptId,
		account: Object.freeze({
			id: account.id,
			name: account.name,
			provider: account.provider,
			custom_endpoint: account.custom_endpoint,
			billing_type: account.billing_type,
			auto_pause_on_overage_enabled: account.auto_pause_on_overage_enabled,
		}),
		providerName: send.providerName,
		routing: meta.routing ? Object.freeze({ ...meta.routing }) : null,
		failoverAttempts: state.failoverAttempts,
		startedAt: Date.now(),
	});
	state.lastInFlight = true;
	state.sends++;
}

/** The SDK bridge served an attempt; its turn keeps its own log. */
export function noteBridgedDispatch(meta: RequestMeta): void {
	const state = tracked.get(meta);
	if (state) state.bridged = true;
}

/**
 * The send completed, failed, or the proxy judged its response. After this a
 * client leaving no longer abandons it.
 */
export function noteUpstreamSettled(
	meta: RequestMeta,
	attemptId: string,
): void {
	const state = tracked.get(meta);
	if (state?.last?.attemptId === attemptId) state.lastInFlight = false;
}

/** Whether this attempt's send was the one in flight when the client left. */
export function wasInFlightAtAbort(
	meta: RequestMeta,
	attemptId: string,
): boolean {
	const atAbort = tracked.get(meta)?.atAbort;
	return atAbort?.inFlight === true && atAbort.dispatch.attemptId === attemptId;
}

/**
 * The request's last upstream send, when the request is one a pre-head abort
 * row describes: something was sent, and none of it went through the bridge.
 */
export function preHeadAbortDispatch(meta: RequestMeta): {
	dispatch: UpstreamDispatch;
	inFlightAtAbort: boolean;
	sends: number;
} | null {
	const state = tracked.get(meta);
	if (!state?.last || state.bridged) return null;
	return {
		dispatch: state.last,
		inFlightAtAbort:
			state.atAbort?.dispatch === state.last && state.atAbort.inFlight,
		sends: state.sends,
	};
}

/**
 * Stamp the abandoned attempt 499. The repository decides atomically whether
 * nothing settled it first. A failed write is logged and leaves the row to
 * its normal writers.
 */
export async function stampClientClosedAttempt(
	ctx: ProxyContext,
	attemptId: string,
): Promise<void> {
	try {
		await ctx.dbOps.routing.finishAttemptClientClosed(attemptId, Date.now());
	} catch (error) {
		log.warn("Could not stamp the abandoned routing attempt", error);
	}
}
