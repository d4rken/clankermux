import {
	getSdkBridgeInnerMetaContext,
	type RequestMeta,
} from "@clankermux/types";
import type { ResponseHandlerOptions } from "../response-handler";
import { noteSdkBridgeInnerRequestStarted } from "../sdk-bridge-inner-outcome";

/** The `forwardToClient` options that come straight from `requestMeta`. */
export type RecordFieldsFromMeta = Pick<
	ResponseHandlerOptions,
	| "requestId"
	| "timestamp"
	| "internal"
	| "requestedModel"
	| "fallbackCreditClaimed"
	| "fallbackFromModel"
	| "project"
	| "projectAttributionSource"
	| "contextComposition"
	| "toolCallStats"
	| "reasoningEffort"
	| "sessionKey"
	| "cachePrefixHashes"
	| "clientUserAgent"
	| "clientHarness"
	| "comboName"
	| "routing"
	| "sdkBridgeTurnId"
	| "onRecordBegun"
>;

/**
 * Every `forwardToClient` call site spreads this, so a field added to
 * `requestMeta` for the recorder reaches it from all of them. Absent values
 * stay undefined rather than becoming null.
 */
export function recordFieldsFromMeta(
	requestMeta: RequestMeta,
): RecordFieldsFromMeta {
	return {
		requestId: requestMeta.id,
		timestamp: requestMeta.timestamp,
		internal: requestMeta.internal === true,
		requestedModel: requestMeta.requestedModel,
		fallbackCreditClaimed: requestMeta.fallbackCreditClaimed,
		fallbackFromModel: requestMeta.fallbackFromModel,
		project: requestMeta.project,
		projectAttributionSource: requestMeta.projectAttributionSource,
		contextComposition: requestMeta.contextComposition,
		toolCallStats: requestMeta.toolCallStats,
		reasoningEffort: requestMeta.reasoningEffort,
		sessionKey: requestMeta.sessionKey,
		cachePrefixHashes: requestMeta.cachePrefixHashes,
		clientUserAgent: requestMeta.clientUserAgent,
		clientHarness: requestMeta.clientHarness,
		comboName: requestMeta.comboName,
		routing: requestMeta.routing ?? null,
		sdkBridgeTurnId: requestMeta.sdkBridgeTurnId,
		onRecordBegun: getSdkBridgeInnerMetaContext(requestMeta)
			? () => noteSdkBridgeInnerRequestStarted(requestMeta)
			: undefined,
	};
}
