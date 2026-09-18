import { isAccountAvailable } from "@clankermux/core";
import type { Account, RequestMeta } from "@clankermux/types";
import { createAdmissionGates } from "./admission-gates";
import { cacheBodyStore } from "./cache-body-store";
import { selectAccountsForRequest } from "./handlers/account-selector";
import { isAnthropicBurstThrottleActive } from "./handlers/burst-cooldown";
import { createClientAbortResponse } from "./handlers/client-abort-response";
import {
	type ProxyAttemptOutcome,
	proxyWithAccount,
} from "./handlers/proxy-operations";
import type { ProxyContext } from "./handlers/proxy-types";
import { isOAuthAnthropicAccount } from "./handlers/transparent-retry";
import { setPoolHeadroomCandidates } from "./pool-headroom";
import type { IngressContext } from "./request-ingress";
import {
	getAliasRoutes,
	getAttemptTarget,
	RoutingPolicyError,
	selectAliasRoute,
} from "./resolved-route";
import { createSyntheticTerminalRecorder } from "./synthetic-terminal-recorder";

const AFFINITY_TTL_MS = 60 * 60 * 1000;
const MAX_AFFINITIES = 5000;
const affinity = new Map<string, { targetIndex: number; expires: number }>();
export function clearAliasAffinity(): void {
	affinity.clear();
}
function affinityKey(
	meta: RequestMeta,
	alias: { id: string; revision: number },
): string | null {
	if (
		!meta.affinityKey ||
		!meta.affinityScope ||
		meta.affinityScope === "project"
	)
		return null;
	return JSON.stringify([
		meta.affinityPartition,
		meta.affinityScope,
		meta.affinityKey,
		alias.id,
		alias.revision,
	]);
}
function remember(key: string | null, targetIndex: number): void {
	if (!key) return;
	const now = Date.now();
	for (const [id, value] of affinity)
		if (value.expires <= now) affinity.delete(id);
	affinity.delete(key);
	if (affinity.size >= MAX_AFFINITIES) {
		const oldest = affinity.keys().next().value;
		if (oldest !== undefined) affinity.delete(oldest);
	}
	affinity.set(key, { targetIndex, expires: now + AFFINITY_TTL_MS });
}
export function aliasFallbackReason(
	outcome: ProxyAttemptOutcome,
): string | null {
	switch (outcome.kind) {
		case "hard_429":
		case "model_quota_exhausted":
			return "quota_exhausted";
		case "retryable_429":
			return "rate_limited";
		case "overload_529":
		case "overload_suppressed":
			return "provider_overloaded";
		case "server_error":
			return "temporarily_unavailable";
		case "network_error":
			return outcome.beforeDispatch ? null : "temporarily_unavailable";
		default:
			return null;
	}
}

/** Alias stages share the ordinary account dispatcher; a returned response is final. */
export async function handleAliasProxy(
	ingress: IngressContext,
	req: Request,
	url: URL,
	ctx: ProxyContext,
	apiKeyId: string | null | undefined,
	apiKeyName: string | null | undefined,
	attemptThroughProbeGate: (
		account: Account,
		attempt: () => Promise<Response | null>,
	) => Promise<{ response: Response | null; suppressed: boolean }>,
): Promise<Response> {
	const {
		requestMeta: meta,
		finalBodyBuffer,
		finalCreateBodyStream,
		requestBodyContext,
		gateTokenEstimate,
	} = ingress;
	const stages = getAliasRoutes(meta);
	const alias = stages?.[0]?.alias;
	if (!stages || !alias)
		throw new RoutingPolicyError("Request has no alias routing plan");
	const key = affinityKey(meta, alias);
	const held = key ? affinity.get(key) : undefined;
	const preferred =
		held && held.expires > Date.now()
			? stages.find((s) => s.alias?.targetIndex === held.targetIndex)
			: undefined;
	const ordered = preferred
		? [preferred, ...stages.filter((s) => s !== preferred)]
		: [...stages];
	let reason: string | null = preferred ? "conversation_affinity" : null;
	let attempts = 0;
	// The marker suppresses sibling diversion, not the first recovery attempt.
	const oauthAccountIds = new Set(
		(await ctx.dbOps.getAllAccounts())
			.filter(isOAuthAnthropicAccount)
			.map((a) => a.id),
	);
	let oauthAttempted = false;
	const burstSuppressed = (accountId: string): boolean =>
		oauthAttempted &&
		oauthAccountIds.has(accountId) &&
		isAnthropicBurstThrottleActive();
	let terminalStatus = 503;
	let terminalMessage = "All alias targets are temporarily unavailable";
	const record = createSyntheticTerminalRecorder(
		req,
		url,
		ctx,
		meta,
		finalBodyBuffer,
		apiKeyId,
		apiKeyName,
	);
	for (const [stageIndex, stage] of ordered.entries()) {
		if (req.signal.aborted) {
			cacheBodyStore.discardStaged(meta.id);
			return createClientAbortResponse();
		}
		selectAliasRoute(meta, stage, reason);
		const selected = await selectAccountsForRequest(meta, ctx);
		const gates = createAdmissionGates({
			requestMeta: meta,
			gateTokenEstimate,
			isSyntheticProbeRequest: false,
			config: ctx.config,
			strategy: ctx.strategy,
		});
		const provider = gates.applyProviderOverloadGate(selected);
		const throttle = gates.applyUsageThrottling(provider.available);
		const family = gates.applyFamilyWeeklyGate(throttle.available);
		const accounts = gates.applyFailureMemoDemotion(
			gates.applySoftDemotionReorder(gates.applyContextWindowGate(family)),
		);
		gates.reconcileAffinity(accounts);
		setPoolHeadroomCandidates(meta, accounts);
		if (meta.routing) {
			meta.routing.selectedAccountId = accounts[0]?.id ?? null;
			meta.routing.primaryAttemptAccountId = accounts[0]?.id ?? null;
			meta.routing.candidatesCount = accounts.length;
		}
		// A request too large for this stage is a compatibility error, not quota exhaustion.
		if (!accounts.length && gates.contextExcludedAccounts.length) {
			terminalStatus = 400;
			terminalMessage =
				"Request exceeds the context capacity of the alias target";
			break;
		}
		let mayAdvance = true;
		let stageReason = provider.overloaded.length
			? "provider_overloaded"
			: "pool_unavailable";
		if (gates.familyWeeklyExcludedAccounts.length || throttle.throttled.length)
			stageReason = "quota_exhausted";
		for (const [accountIndex, account] of accounts.entries()) {
			if (req.signal.aborted) {
				cacheBodyStore.discardStaged(meta.id);
				return createClientAbortResponse();
			}
			// Selection can race a sibling request applying an account cooldown.
			if (!isAccountAvailable(account)) continue;
			if (burstSuppressed(account.id)) {
				stageReason = "rate_limited";
				continue;
			}
			const isLastAccountAttempt = () =>
				gates.everyRemainingCandidateUnattemptable(
					accounts
						.slice(accountIndex + 1)
						.filter((a) => !burstSuppressed(a.id)),
					-1,
				);
			const isLastAliasAttempt = () =>
				isLastAccountAttempt() &&
				ordered
					.slice(stageIndex + 1)
					.every(
						(next) =>
							!next.admissionError && next.accountIds().every(burstSuppressed),
					);
			let outcome: ProxyAttemptOutcome | undefined;
			const result = await attemptThroughProbeGate(account, async () => {
				attempts++;
				if (isOAuthAnthropicAccount(account)) oauthAttempted = true;
				return proxyWithAccount(
					req,
					url,
					account,
					meta,
					finalBodyBuffer,
					finalCreateBodyStream,
					attempts - 1,
					ctx,
					getAttemptTarget(meta, account).upstreamModel,
					apiKeyId,
					apiKeyName,
					requestBodyContext,
					isLastAliasAttempt,
					{
						signal: req.signal,
						isLastAccountAttempt,
						forwardTransientServerError: isLastAliasAttempt,
						onOutcome: (o) => {
							outcome = o;
						},
					},
				);
			});
			if (result.response) {
				if (result.response.ok && stage.alias)
					remember(key, stage.alias.targetIndex);
				return result.response;
			}
			if (result.suppressed) {
				stageReason = "temporarily_unavailable";
				continue;
			}
			const failure = outcome ? aliasFallbackReason(outcome) : null;
			if (!failure) mayAdvance = false;
			else stageReason = failure;
		}
		if (!mayAdvance) {
			terminalMessage =
				"Alias target failed for a non-retryable reason; model fallback was not used";
			break;
		}
		reason = stageReason;
	}
	cacheBodyStore.discardStaged(meta.id);
	if (req.signal.aborted) return createClientAbortResponse();
	const response = Response.json(
		{
			type: "error",
			error: {
				type:
					terminalStatus === 400
						? "invalid_request_error"
						: "alias_targets_unavailable",
				message: terminalMessage,
			},
		},
		{
			status: terminalStatus,
			headers: terminalStatus === 503 ? { "Retry-After": "30" } : {},
		},
	);
	if (!ctx.requestRecorder.hasRecord(meta.id))
		await record(
			response,
			terminalStatus === 400
				? "alias_incompatible_request"
				: "alias_targets_unavailable",
			{ failoverAttempts: attempts },
		);
	return response;
}
