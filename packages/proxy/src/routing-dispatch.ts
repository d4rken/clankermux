import {
	localTokenCountUrl,
	supportsLocalTokenCounting,
} from "@clankermux/providers/local-token-count";
import type { Account, RequestMeta, RoutingAttempt } from "@clankermux/types";
import type { ProxyContext } from "./handlers/proxy-types";
import { makeProxyRequest } from "./handlers/request-handler";
import {
	enforceOutgoingModel,
	getAttemptTarget,
	getResolvedRoute,
	RoutingPolicyError,
} from "./resolved-route";
import { observeRoutingResponse } from "./routing-response-audit";
import { getModelPermissionService } from "./routing-service";

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
): Promise<void> {
	if (audit.id) {
		// Semantic classification wins regardless of whether the body observer finished first.
		await ctx.dbOps.routing.annotateAttempt(audit.id, error, status);
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
): Promise<Response> {
	const target = getAttemptTarget(meta, account);
	const route = getResolvedRoute(meta);
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
	};
	let response: Response;
	let recorded = false;
	try {
		const current = await ctx.dbOps.getAccount(account.id);
		if (!current || !route.target(current))
			throw new RoutingPolicyError(
				"Destination identity changed before dispatch",
			);
		if (!route.maintenance) {
			const permissions =
				await getModelPermissionService(ctx).permissions(current);
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
		response = await makeProxyRequest(
			request,
			undefined,
			undefined,
			undefined,
			undefined,
			signal,
		);
		if (prepareResponse) response = await prepareResponse(response);
	} catch (error) {
		attempt.finished_at = Date.now();
		attempt.status = error instanceof RoutingPolicyError ? 403 : 502;
		attempt.error =
			error instanceof RoutingPolicyError
				? error.message
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

	return observeRoutingResponse(
		response,
		async ({ reportedModel, error, modelRejected }) => {
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
} from "@clankermux/providers";
