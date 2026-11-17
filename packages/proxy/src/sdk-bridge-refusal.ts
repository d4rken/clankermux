import {
	type RequestMeta,
	SdkBridgeCapacityError,
	SdkBridgeExtraUsageError,
	type SdkBridgeRefusalError,
	SdkBridgeSafetyRefusalError,
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
 * version refusal for the same model, nor a safety refusal of the same
 * content. A later bridged attempt would also
 * write a second turn under the same leg id.
 */
export function priorSdkBridgeRefusal(
	meta: RequestMeta,
): SdkBridgeRefusalError | null {
	return states.get(meta)?.rejection ?? null;
}

/**
 * The answer a give-up terminal returns instead of its own generic 503: the
 * bridge's refusal when it was the request's last failed attempt, and a
 * safety refusal whatever failed after it. A later destination that served
 * nothing says nothing about the content the model refused, and a retry
 * would meet the same refusal. A terminal that answers otherwise (a client
 * abort, an overload or burst-retry give-up, a forwarded upstream response)
 * never gets here.
 */
export function sdkBridgeRefusalTerminal(
	meta: RequestMeta,
): SdkBridgeRefusalError | null {
	const state = states.get(meta);
	if (!state) return null;
	return state.last || state.rejection instanceof SdkBridgeSafetyRefusalError
		? state.rejection
		: null;
}

/**
 * Record a refusal that is the request's answer, unless the request already
 * has a row. A safety refusal publishes its failed-over leg, which the client
 * API then reads with Claude Code's calls summed under it; every other
 * refusal gets a request row of its own through `recordRow`.
 */
export async function recordSdkBridgeRefusalAnswer(
	refusal: SdkBridgeRefusalError,
	hasRecord: boolean,
	recordRow: (label: string) => Promise<void>,
): Promise<void> {
	if (hasRecord) return;
	if (refusal instanceof SdkBridgeSafetyRefusalError)
		await refusal.publishAsAnswer();
	else await recordRow(sdkBridgeRefusalLabel(refusal));
}

/** The label a refusal's attempt and terminal are recorded under. */
export function sdkBridgeRefusalLabel(refusal: SdkBridgeRefusalError): string {
	if (refusal instanceof SdkBridgeCapacityError) return "sdk_bridge_capacity";
	if (refusal instanceof SdkBridgeExtraUsageError)
		return "sdk_bridge_extra_usage";
	if (refusal instanceof SdkBridgeVersionTooOldError)
		return "sdk_bridge_version_too_old";
	if (refusal instanceof SdkBridgeSafetyRefusalError)
		return "sdk_bridge_safety_refusal";
	return "sdk_bridge_refused";
}
