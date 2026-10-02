import { hashRoutingAffinityKey, hasRequestStarted } from "@clankermux/core";
import { sanitizeRequestHeaders } from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import {
	CLIENT_CLOSED_REQUEST,
	type RequestMeta,
	type RequestRoutingMeta,
} from "@clankermux/types";
import type { ProxyContext } from "./handlers/proxy-types";
import { preHeadAbortDispatch } from "./pre-head-client-abort";
import type { RecordMeta, RecordRouting } from "./request-recorder";
import { noteSdkBridgeInnerRequestStarted } from "./sdk-bridge-inner-outcome";
import { shouldRecordRequest } from "./should-record-request";

const log = new Logger("Proxy");

function toRecordRouting(
	routing: Readonly<RequestRoutingMeta> | null | undefined,
	selectedAccountId?: string,
): RecordRouting | null {
	return routing
		? {
				strategy: routing.strategy,
				decision: routing.decision,
				affinityScope: routing.affinityScope ?? null,
				affinityKeyHash: hashRoutingAffinityKey(routing.affinityKey),
				selectedAccountId:
					selectedAccountId ?? routing.selectedAccountId ?? null,
				previousAccountId: routing.previousAccountId ?? null,
				candidatesCount: routing.candidatesCount ?? null,
				failoverReason: routing.failoverReason ?? null,
			}
		: null;
}

/** The small local response body, when payload storage wants it. */
async function capturedBody(
	ctx: ProxyContext,
	response: Response,
): Promise<ArrayBuffer | null> {
	if (!(ctx.config.getStorePayloads?.() ?? true)) return null;
	try {
		return await response.clone().arrayBuffer();
	} catch {
		// Metadata/model attribution is still valuable if cloning ever fails.
		return null;
	}
}

/**
 * Record a request whose client left after an upstream send went out but
 * before any response started, against the last send it made. Returns
 * whether it wrote a row.
 *
 * Nothing is written when no upstream send went out (the proxy never reached
 * an account), when any attempt went through the SDK bridge (its turn keeps
 * its own log), when the request already has a row or a started response,
 * or when Request History filters the request out anyway.
 */
export async function recordPreHeadClientAbort(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	requestMeta: RequestMeta,
	response: Response,
	finalBodyBuffer: ArrayBuffer | null,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
): Promise<boolean> {
	if (!req.signal.aborted) return false;
	const tracked = preHeadAbortDispatch(requestMeta);
	if (!tracked) return false;
	if (ctx.requestRecorder.hasRecord(requestMeta.id)) return false;
	if (hasRequestStarted(requestMeta.id)) return false;
	const { dispatch } = tracked;
	if (
		!shouldRecordRequest({
			method: req.method,
			path: url.pathname,
			providerName: dispatch.providerName,
			customEndpoint: dispatch.account.custom_endpoint,
			responseStatus: response.status,
			internal: requestMeta.internal === true,
			getHeader: (name) => req.headers.get(name),
		})
	)
		return false;

	const storePayloads = ctx.config.getStorePayloads?.() ?? true;
	const meta: RecordMeta = {
		requestId: requestMeta.id,
		method: req.method,
		path: url.pathname,
		accountId: dispatch.account.id,
		accountName: dispatch.account.name,
		responseStatus: response.status,
		responseHeaders: Object.fromEntries(response.headers.entries()),
		requestHeaders: Object.fromEntries(
			sanitizeRequestHeaders(req.headers).entries(),
		),
		isStream: false,
		providerName: dispatch.providerName,
		requestedModel: requestMeta.requestedModel ?? null,
		fallbackCreditClaimed: requestMeta.fallbackCreditClaimed ?? null,
		fallbackFromModel: requestMeta.fallbackFromModel ?? null,
		synthetic: false,
		failureSource: CLIENT_CLOSED_REQUEST,
		accountBillingType: dispatch.account.billing_type ?? null,
		accountAutoPauseOnOverageEnabled: dispatch.account
			.auto_pause_on_overage_enabled
			? 1
			: 0,
		authed: true,
		apiKeyId: apiKeyId || null,
		apiKeyName: apiKeyName || null,
		comboName: requestMeta.comboName ?? null,
		project: requestMeta.project ?? null,
		projectAttributionSource: requestMeta.projectAttributionSource ?? null,
		reasoningEffort: requestMeta.reasoningEffort ?? null,
		sessionKey: requestMeta.sessionKey ?? null,
		cachePrefixHashes: requestMeta.cachePrefixHashes ?? null,
		clientUserAgent: requestMeta.clientUserAgent ?? null,
		clientHarness: requestMeta.clientHarness ?? null,
		sdkBridgeTurnId: requestMeta.sdkBridgeTurnId ?? null,
		servedServiceTier: dispatch.servedServiceTier,
		routing: toRecordRouting(dispatch.routing, dispatch.account.id),
		// Arrival, so the row's response time is how long the client waited.
		timestamp: requestMeta.timestamp,
		requestBody: storePayloads ? finalBodyBuffer : null,
		retryAttempt: 0,
		failoverAttempts: dispatch.failoverAttempts,
	};
	ctx.requestRecorder.recordClientClosedBeforeHead(meta, {
		responseBody: await capturedBody(ctx, response),
	});
	noteSdkBridgeInnerRequestStarted(requestMeta);
	log.info(
		`Client closed request ${requestMeta.id} before the response started; last upstream attempt: ${dispatch.account.name}${tracked.inFlightAtAbort ? " (in flight)" : ""}, ${tracked.sends} upstream send${tracked.sends === 1 ? "" : "s"}`,
	);
	return true;
}
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
		const responseBody = await capturedBody(ctx, response);
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
			clientUserAgent: requestMeta.clientUserAgent ?? null,
			clientHarness: requestMeta.clientHarness ?? null,
			sdkBridgeTurnId: requestMeta.sdkBridgeTurnId ?? null,
			servedServiceTier: requestMeta.servedServiceTier ?? null,
			routing: toRecordRouting(requestMeta.routing),
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
		noteSdkBridgeInnerRequestStarted(requestMeta);
	};
}
