import { sanitizeRequestHeaders } from "@clankermux/http-common";
import type { RequestMeta } from "@clankermux/types";
import type { ProxyContext } from "./handlers/proxy-types";
import type { RecordMeta } from "./request-recorder";
import { hashRoutingAffinityKey } from "./routing-telemetry";
import { shouldRecordRequest } from "./should-record-request";
export function createSyntheticTerminalRecorder(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	requestMeta: RequestMeta,
	finalBodyBuffer: ArrayBuffer | null,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
) {
	const effectiveRequestModel = requestMeta.requestedModel;
	const project = requestMeta.project;
	const projectAttributionSource = requestMeta.projectAttributionSource ?? null;
	return async (
		response: Response,
		error: string,
		opts?: { failoverAttempts?: number },
	): Promise<void> => {
		// Same recordable-request predicate as forwardToClient (S1) — keeps
		// synthetic pool/provider-exhaustion rows out of history for the same
		// filtered set (auto-refresh probes, etc.).
		if (
			!shouldRecordRequest({
				method: req.method,
				path: url.pathname,
				providerName: ctx.provider.name,
				responseStatus: response.status,
				internal: requestMeta.internal === true,
				getHeader: (name) => req.headers.get(name),
			})
		) {
			return;
		}

		// Synthetic terminal responses (pool/provider-exhaustion) write a request
		// row directly via the recorder. Preserve the already-buffered incoming body
		// and the small local response when payload storage is enabled so the details
		// modal can explain the rejection. There is still no provider usage/account.
		const storePayloads = ctx.config.getStorePayloads?.() ?? true;
		let responseBody: ArrayBuffer | null = null;
		if (storePayloads) {
			try {
				responseBody = await response.clone().arrayBuffer();
			} catch {
				// Metadata/model attribution is still valuable if cloning ever fails.
			}
		}
		const meta: RecordMeta = {
			requestId: requestMeta.id,
			method: req.method,
			path: url.pathname,
			accountId: null,
			accountName: null,
			responseStatus: response.status,
			responseHeaders: Object.fromEntries(response.headers.entries()),
			requestHeaders: Object.fromEntries(
				sanitizeRequestHeaders(req.headers).entries(),
			),
			isStream: false,
			providerName: ctx.provider.name,
			requestedModel: effectiveRequestModel ?? null,
			// A locally-rejected retry is still the redemption of a refusal.
			fallbackCreditClaimed: requestMeta.fallbackCreditClaimed ?? null,
			fallbackFromModel: requestMeta.fallbackFromModel ?? null,
			synthetic: true,
			failureSource:
				error === "provider_overloaded"
					? "local_provider_cooldown"
					: "local_proxy_rejection",
			accountBillingType: null,
			accountAutoPauseOnOverageEnabled: 0,
			authed: false,
			apiKeyId: apiKeyId || null,
			apiKeyName: apiKeyName || null,
			comboName: null,
			project: project ?? null,
			projectAttributionSource,
			reasoningEffort: requestMeta.reasoningEffort ?? null,
			sessionKey: requestMeta.sessionKey ?? null,
			cachePrefixHashes: requestMeta.cachePrefixHashes ?? null,
			routing: requestMeta.routing
				? {
						strategy: requestMeta.routing.strategy,
						decision: requestMeta.routing.decision,
						affinityScope: requestMeta.routing.affinityScope ?? null,
						affinityKeyHash: hashRoutingAffinityKey(
							requestMeta.routing.affinityKey,
						),
						selectedAccountId: requestMeta.routing.selectedAccountId ?? null,
						previousAccountId: requestMeta.routing.previousAccountId ?? null,
						candidatesCount: requestMeta.routing.candidatesCount ?? null,
						failoverReason: requestMeta.routing.failoverReason ?? null,
					}
				: null,
			timestamp: requestMeta.timestamp,
			requestBody: storePayloads ? finalBodyBuffer : null,
			retryAttempt: 0,
			// Most synthetic terminals fire before anything was attempted; the
			// give-up terminal passes the attempts it really made.
			failoverAttempts: opts?.failoverAttempts ?? 0,
		};
		ctx.requestRecorder.recordSynthetic(meta, "error", error, {
			responseBody,
		});
	};
}
