import type { RequestResponse } from "@clankermux/types";

export interface RequestModelPresentation {
	value: string;
	/** True when no provider-reported model exists and this is the ingress model. */
	requestedOnly: boolean;
}

/** Prefer the model confirmed by the provider, falling back to request ingress. */
export function getRequestModelPresentation(
	request: Pick<RequestResponse, "model" | "requestedModel"> | undefined,
): RequestModelPresentation | null {
	if (request?.model) {
		return { value: request.model, requestedOnly: false };
	}
	if (request?.requestedModel) {
		return { value: request.requestedModel, requestedOnly: true };
	}
	return null;
}

/** Copy for the badge a refusal or a fallback-credit retry carries. */
export interface RefusalFallbackBadge {
	label: string;
	title: string;
}

/**
 * The one badge a request earns for its part in a refusal/fallback exchange.
 *
 * A single badge, not two, because the two facts are mutually exclusive in
 * practice and stacking them would push the model badge off the row on a narrow
 * screen. The refusal wins when both are set: a retry that was ITSELF refused
 * is first and foremost a refusal, and the retry's origin is still recoverable
 * from the request details.
 */
export function getRefusalFallbackBadge(
	summary:
		| Pick<
				RequestResponse,
				"refusalCategory" | "fallbackCreditClaimed" | "fallbackFromModel"
		  >
		| undefined,
): RefusalFallbackBadge | null {
	if (summary?.refusalCategory) {
		return {
			label: `refused · ${summary.refusalCategory}`,
			title:
				"The provider's safety filter declined this request (stop_reason: refusal)",
		};
	}
	if (summary?.fallbackCreditClaimed) {
		return {
			label: `fallback retry${
				summary.fallbackFromModel ? ` · for ${summary.fallbackFromModel}` : ""
			}`,
			title:
				"Re-sent by Claude Code to a fallback model with a fallback credit after a refusal",
		};
	}
	return null;
}
