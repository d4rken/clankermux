import {
	type RequestMeta,
	SdkBridgeCapacityError,
	SdkBridgeExtraUsageError,
	type SdkBridgeRefusalError,
	SdkBridgeVersionTooOldError,
} from "@clankermux/types";

interface RefusalState {
	rejection: SdkBridgeRefusalError;
	/** Whether the request's most recent attempt was that rejection. */
	last: boolean;
}

const states = new WeakMap<RequestMeta, RefusalState>();

/** An attempt of this request begins; it is now the one a terminal reports on. */
export function noteAttemptStarted(meta: RequestMeta): void {
	const state = states.get(meta);
	if (state) state.last = false;
}

/** The bridge refused this attempt with an answer of its own. */
export function noteSdkBridgeRefusal(
	meta: RequestMeta,
	rejection: SdkBridgeRefusalError,
): void {
	states.set(meta, { rejection, last: true });
}

/**
 * A refusal this request already had; every later official candidate skips
 * the bridge. Capacity belongs to the one bridge, and an extra-usage refusal
 * is taken as the request's, not one account's. Every bridged account uses
 * the same Claude Code version, so switching accounts cannot resolve a
 * version refusal for the same model. A later bridged attempt would also
 * write a second turn under the same leg id.
 */
export function priorSdkBridgeRefusal(
	meta: RequestMeta,
): SdkBridgeRefusalError | null {
	return states.get(meta)?.rejection ?? null;
}

/**
 * The bridge's refusal when it was the request's last failed attempt: the
 * answer a give-up terminal returns instead of its own generic one.
 */
export function sdkBridgeRefusalTerminal(
	meta: RequestMeta,
): SdkBridgeRefusalError | null {
	const state = states.get(meta);
	return state?.last ? state.rejection : null;
}

/** The label a refusal's attempt and terminal are recorded under. */
export function sdkBridgeRefusalLabel(refusal: SdkBridgeRefusalError): string {
	if (refusal instanceof SdkBridgeCapacityError) return "sdk_bridge_capacity";
	if (refusal instanceof SdkBridgeExtraUsageError)
		return "sdk_bridge_extra_usage";
	if (refusal instanceof SdkBridgeVersionTooOldError)
		return "sdk_bridge_version_too_old";
	return "sdk_bridge_refused";
}
