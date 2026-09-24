import type { RequestMeta, SdkBridgeCapacityError } from "@clankermux/types";

interface CapacityState {
	rejection: SdkBridgeCapacityError;
	/** Whether the request's most recent attempt was that rejection. */
	last: boolean;
}

const states = new WeakMap<RequestMeta, CapacityState>();

/** An attempt of this request begins; it is now the one a terminal reports on. */
export function noteAttemptStarted(meta: RequestMeta): void {
	const state = states.get(meta);
	if (state) state.last = false;
}

/** The bridge refused this attempt for capacity. */
export function noteSdkBridgeCapacity(
	meta: RequestMeta,
	rejection: SdkBridgeCapacityError,
): void {
	states.set(meta, { rejection, last: true });
}

/**
 * A capacity refusal this request already had. Capacity belongs to the one
 * bridge, so a later official candidate would be refused the same way, and
 * a second refusal would write a second rejected turn under the same leg id.
 */
export function priorSdkBridgeCapacity(
	meta: RequestMeta,
): SdkBridgeCapacityError | null {
	return states.get(meta)?.rejection ?? null;
}

/**
 * The bridge's refusal when it was the request's last failed attempt: the
 * answer a give-up terminal returns instead of its own generic one.
 */
export function sdkBridgeCapacityTerminal(
	meta: RequestMeta,
): SdkBridgeCapacityError | null {
	const state = states.get(meta);
	return state?.last ? state.rejection : null;
}
