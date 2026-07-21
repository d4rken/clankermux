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
