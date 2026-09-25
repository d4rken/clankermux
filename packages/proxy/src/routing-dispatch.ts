import { supportsChatIngress, unsupportedChatField } from "@clankermux/core";
import {
	localTokenCountUrl,
	supportsLocalTokenCounting,
} from "@clankermux/providers/local-token-count";
import type { Account, RequestMeta, RoutingAttempt } from "@clankermux/types";
import {
	getChatContext,
	readReasoningEffortAdaptation,
	SdkBridgeCapacityError,
	SdkBridgeUnavailableError,
} from "@clankermux/types";
import { AccountIdentityChangedError } from "./account-model-permissions";
import type { ProxyContext } from "./handlers/proxy-types";
import { makeProxyRequest } from "./handlers/request-handler";
import { isModelExcludedForRequest } from "./request-model-exclusions";
import {
	enforceOutgoingModel,
	getAttemptTarget,
	getResolvedRoute,
	RoutingPolicyError,
} from "./resolved-route";
import { observeRoutingResponse } from "./routing-response-audit";
import { getModelPermissionService } from "./routing-service";
import { noteSdkBridgeInnerSend } from "./sdk-bridge-inner-outcome";

/** Owned by one proxyWithAccount/proxyForcedAccount invocation, never shared across accounts. */
export interface RoutingAttemptAudit {
	id: string | null;
}
export async function recordLocalRoutingOutcome(
	audit: RoutingAttemptAudit,
	meta: RequestMeta,
	account: Account,
	ctx: ProxyContext,
	error: string,
	status: number | null = null,
	/**
	 * The model the upstream said it served, when the caller already knows it
	 * and is about to discard the body the observer would have read it from.
	 */
	reportedModel: string | null = null,
): Promise<void> {
	if (audit.id) {
		// Semantic classification wins regardless of whether the body observer finished first.
		await ctx.dbOps.routing.annotateAttempt(
			audit.id,
			error,
			status,
			reportedModel,
		);
		return;
	}
	const route = getResolvedRoute(meta);
	const id = crypto.randomUUID();
	await ctx.dbOps.routing.recordAttempt({
		id,
		request_id: meta.id,
		rule_id: route.ruleId,
		route_snapshot: route.snapshot,
		account_id: account.id,
		provider: account.provider,
		requested_model: route.requestedModel,
		resolved_model: route.target(account)?.upstreamModel ?? null,
		outgoing_model: null,
		reported_model: null,
		kind: "local_reject",
		started_at: Date.now(),
		finished_at: Date.now(),
		status,
		error,
		// A rejection decided before any dispatch: nothing was serialized, so
		// there is no effective effort and no adaptation to claim.
		reasoning_effort_requested: null,
		reasoning_effort_effective: null,
		reasoning_effort_reason: null,
	});
	audit.id = id;
}

/** Every client inference send (including retries and force) must pass here. */
export async function sendAuthorizedRequest(
	request: Request,
	account: Account,
	meta: RequestMeta,
	ctx: ProxyContext,
	signal?: AbortSignal,
	audit?: RoutingAttemptAudit,
	devinProvenance: DevinRequestProvenance | null = getDevinRequestProvenance(
		request,
	),
	prepareResponse?: (response: Response) => Promise<Response>,
	/**
	 * An in-process transport that replaces the network send, for an attempt
	 * the SDK bridge serves. Authorization, the outgoing-model check and the
	 * attempt row are exactly those of a network send. Its response is the
	 * turn's final answer: this function never classifies it (no model
	 * suppression), and the attempt row finishes when its body ends.
	 */
	transport?: (request: Request) => Promise<Response>,
): Promise<Response> {
	const target = getAttemptTarget(meta, account);
	const route = getResolvedRoute(meta);
	// Read off THIS request, never off shared per-request state: one request can
	// dispatch several attempts against backends with different effort
	// vocabularies, and a carried-over value would file one attempt's adaptation
	// under another.
	const reasoning = readReasoningEffortAdaptation(request.headers);
	const attempt: RoutingAttempt & { route_snapshot: string } = {
		id: crypto.randomUUID(),
		request_id: meta.id,
		rule_id: route.ruleId,
		route_snapshot: route.snapshot,
		account_id: account.id,
		provider: account.provider,
		requested_model: route.requestedModel,
		resolved_model: target.upstreamModel,
		outgoing_model: null,
		reported_model: null,
		kind: "local_reject",
		started_at: Date.now(),
		finished_at: null,
		status: null,
		error: null,
		reasoning_effort_requested: reasoning?.requested ?? null,
		reasoning_effort_effective: reasoning?.effective ?? null,
		reasoning_effort_reason: reasoning?.reason ?? null,
	};
	let response: Response;
	let recorded = false;
	// Held from the send until the body is over, so the usage cache never takes
	// a poll that landed mid-request as proof the account has been idle.
	let endQuotaUse: (() => void) | null = null;
	try {
		// A mismatch here is an internal authorization invariant failure (403);
		// client field incompatibilities were already rejected during route building.
		// Only the bridge's own transport may carry Chat to an official
		// Anthropic account.
		const chat = getChatContext(meta);
		const bridged = transport !== undefined;
		if (
			chat &&
			(!supportsChatIngress(account.provider, bridged) ||
				unsupportedChatField(account.provider, chat.requirements))
		)
			throw new RoutingPolicyError(
				"Chat capability boundary changed before dispatch",
			);
		const current = await ctx.dbOps.getAccount(account.id);
		if (current?.disabled)
			throw new RoutingPolicyError("Account was disabled before dispatch");
		if (!current || !route.target(current))
			throw new RoutingPolicyError(
				"Destination identity changed before dispatch",
			);
		if (!route.maintenance) {
			// The last gate before the wire, and the only one that is authoritative
			// the instant a rejection is classified. The suppression row below is
			// written from the response observer and may still be in flight, so a
			// transport, body or token-refresh retry can reach here first.
			if (isModelExcludedForRequest(meta, account.id, target.upstreamModel))
				throw new RoutingPolicyError(
					"Destination already rejected the resolved model for this request",
				);
			const permissions = await getModelPermissionService(ctx)
				.permissions(current)
				.catch((err: unknown) => {
					if (err instanceof AccountIdentityChangedError)
						throw new RoutingPolicyError(
							"Destination identity changed before dispatch",
						);
					throw err;
				});
			if (
				!route.permits(current, permissions) ||
				(await ctx.dbOps.routing.isModelSuppressed(
					account.id,
					target.scope,
					target.upstreamModel,
					Date.now(),
				))
			)
				throw new RoutingPolicyError(
					"Destination no longer permits the resolved model",
				);
		}
		const synthetic =
			new URL(request.url).origin === "https://clankermux.local" &&
			request.headers.get("x-clankermux-synthetic-response") === "true";
		if (account.provider === "devin") {
			const credentialSha256 = createHash("sha256")
				.update(
					JSON.stringify([
						account.api_key ?? null,
						account.custom_endpoint ?? null,
					]),
				)
				.digest("hex");
			if (
				!devinProvenance ||
				devinProvenance.accountId !== account.id ||
				devinProvenance.credentialSha256 !== credentialSha256 ||
				devinProvenance.url !== request.url ||
				devinProvenance.method !== request.method ||
				devinProvenance.bodySha256 !==
					createHash("sha256")
						.update(new Uint8Array(await request.clone().arrayBuffer()))
						.digest("hex")
			)
				throw new RoutingPolicyError("Cannot verify Devin request provenance");
			if (devinProvenance.kind === "inference") {
				if (
					synthetic ||
					request.headers.get("content-type") !== "application/connect+proto" ||
					devinProvenance.model !== target.upstreamModel
				)
					throw new RoutingPolicyError(
						"Devin transformation changed the authorized model or transport",
					);
			} else if (
				!synthetic ||
				String(devinProvenance.status) !==
					request.headers.get("x-clankermux-synthetic-status") ||
				(devinProvenance.status < 400 &&
					!(
						meta.path === "/v1/messages/count_tokens" &&
						request.url === localTokenCountUrl("devin")
					))
			) {
				throw new RoutingPolicyError("Unexpected Devin local response");
			}
		}
		if (synthetic && transport)
			throw new RoutingPolicyError("Unexpected local inference response");
		if (synthetic) {
			if (
				!(
					account.provider === "devin" &&
					devinProvenance?.kind === "synthetic" &&
					devinProvenance.status >= 400
				) &&
				(meta.path !== "/v1/messages/count_tokens" ||
					!supportsLocalTokenCounting(
						account.provider,
						account.custom_endpoint,
					) ||
					request.url !== localTokenCountUrl(account.provider))
			)
				throw new RoutingPolicyError("Unexpected local inference response");
			attempt.kind =
				request.headers.get("x-clankermux-synthetic-status") === "200"
					? "local_success"
					: "local_reject";
		} else {
			attempt.outgoing_model =
				account.provider === "devin" && devinProvenance?.kind === "inference"
					? devinProvenance.model
					: await enforceOutgoingModel(request, target.upstreamModel);
			attempt.kind = "upstream_send";
		}
		await ctx.dbOps.routing.recordAttempt(attempt);
		recorded = true;
		if (audit) audit.id = attempt.id;
		noteSdkBridgeInnerSend(meta, account.id);
		if (
			attempt.kind === "upstream_send" &&
			account.provider === "anthropic" &&
			!account.custom_endpoint
		)
			endQuotaUse = usageCache.beginQuotaUse(account.id);
		response = transport
			? await transport(request)
			: await makeProxyRequest(
					request,
					undefined,
					undefined,
					undefined,
					undefined,
					signal,
				);
		if (prepareResponse) response = await prepareResponse(response);
	} catch (error) {
		endQuotaUse?.();
		attempt.finished_at = Date.now();
		attempt.status =
			error instanceof RoutingPolicyError
				? 403
				: error instanceof SdkBridgeCapacityError
					? error.status
					: error instanceof SdkBridgeUnavailableError
						? 503
						: 502;
		attempt.error =
			error instanceof RoutingPolicyError
				? error.message
				: error instanceof SdkBridgeCapacityError
					? `SDK bridge at capacity: ${error.message}`
					: error instanceof SdkBridgeUnavailableError
						? `SDK bridge unavailable: ${error.message}`
						: "Upstream transport failed";
		try {
			if (!recorded) await ctx.dbOps.routing.recordAttempt(attempt);
			else
				await ctx.dbOps.routing.finishAttempt(
					attempt.id,
					attempt.finished_at,
					attempt.status,
					attempt.error,
					null,
				);
			if (audit) audit.id = attempt.id;
		} catch {
			/* Preserve the original dispatch failure if audit storage also failed. */
		}
		if (error instanceof RoutingPolicyError && audit?.id)
			error.attemptRecorded = true;
		throw error;
	}

	if (attempt.kind !== "upstream_send") {
		await ctx.dbOps.routing.finishAttempt(
			attempt.id,
			Date.now(),
			response.status,
			response.ok
				? null
				: meta.path === "/v1/messages/count_tokens"
					? `Local token count rejected (HTTP ${response.status})`
					: `Local provider response rejected (HTTP ${response.status})`,
			null,
		);
		return response;
	}

	if (transport)
		return observeRoutingResponse(
			response,
			async ({ reportedModel, error }) => {
				endQuotaUse?.();
				await ctx.dbOps.routing.finishAttempt(
					attempt.id,
					Date.now(),
					response.status,
					error ?? (response.ok ? null : `SDK bridge HTTP ${response.status}`),
					reportedModel,
				);
			},
		);

	return observeRoutingResponse(
		response,
		async ({ reportedModel, error, modelRejected }) => {
			endQuotaUse?.();
			if (modelRejected && attempt.kind === "upstream_send") {
				await ctx.dbOps.routing.suppressModel(
					account.id,
					target.scope,
					target.upstreamModel,
					Date.now() + 300000,
					"upstream_model_rejected",
				);
				void getModelPermissionService(ctx)
					.refresh(account)
					.catch(() => {});
			}
			await ctx.dbOps.routing.finishAttempt(
				attempt.id,
				Date.now(),
				response.status,
				error ??
					(modelRejected
						? "upstream_model_rejected"
						: response.ok
							? null
							: `Upstream HTTP ${response.status}`),
				attempt.kind === "upstream_send"
					? account.provider === "devin"
						? getDevinReportedModel(response)
						: reportedModel
					: null,
			);
		},
	);
}

import { createHash } from "node:crypto";
import {
	type DevinRequestProvenance,
	getDevinReportedModel,
	getDevinRequestProvenance,
	usageCache,
} from "@clankermux/providers";
