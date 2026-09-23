import {
	isModelAliasId,
	isModelPermitted,
	MODEL_SUBSTITUTION_SUPPRESSION_REASON,
	matchRoutingRule,
	resolveRoutingTarget,
	selectEffortVariant,
} from "@clankermux/core";
import type {
	Account,
	AccountModelPermissions,
	RequestMeta,
	RoutingRule,
	SdkBridgeInnerContext,
} from "@clankermux/types";
import {
	getChatContext,
	getSdkBridgeInnerMetaContext,
} from "@clankermux/types";
import {
	AccountIdentityChangedError,
	AccountModelPermissionService,
} from "./account-model-permissions";
import type { ProxyContext } from "./handlers/proxy-types";

/**
 * A live suppression's reason, or null when the pair is not suppressed.
 *
 * The reason-bearing read is an enrichment over the boolean one. Where a caller
 * only implements the boolean, the pair is still suppressed correctly and only
 * the substitution ATTRIBUTION is lost — the right degradation for something
 * that knows nothing about substitutions.
 *
 * Shared by the alias and non-alias branches so the two cannot drift: when only
 * one of them read the reason, an alias stage emptied by substitutions returned
 * a 403 while the same condition on a normal route returned the 503.
 */
async function readSuppressionReason(
	ctx: ProxyContext,
	accountId: string,
	scope: string,
	model: string,
): Promise<string | null> {
	const routing = ctx.dbOps.routing;
	if (routing.modelSuppressionReason)
		return routing.modelSuppressionReason(accountId, scope, model, Date.now());
	return (await routing.isModelSuppressed(accountId, scope, model, Date.now()))
		? ""
		: null;
}

import { getValidAccessToken } from "./handlers/token-manager";
import { isModelExcludedForRequest } from "./request-model-exclusions";
import {
	type BuildRouteInput,
	buildResolvedRoute,
	type DestinationRestrictions,
	destinationExclusionReason,
	getResolvedRoute,
	installAliasRoutes,
	installResolvedRoute,
	type ResolvedRoute,
	RoutingPolicyError,
	routeAccountLabel,
} from "./resolved-route";

const services = new WeakMap<object, AccountModelPermissionService>();

/**
 * Read each account's permissions into `into`. An account whose stored row
 * changed after `accounts` was read (an identity write landing just after
 * sign-in) is recorded in `stale` instead of failing the whole request.
 */
async function readPermissions(
	service: AccountModelPermissionService,
	accounts: readonly Account[],
	into: Map<string, AccountModelPermissions>,
	stale: Set<string>,
): Promise<void> {
	await Promise.all(
		accounts.map(async (a) => {
			try {
				into.set(a.id, await service.permissions(a));
			} catch (err) {
				if (!(err instanceof AccountIdentityChangedError)) throw err;
				stale.add(a.id);
			}
		}),
	);
}

/**
 * The model an alias stage sends: the target as written, or the sibling
 * variant that serves the requested effort (Devin keeps the effort in the model
 * id). The variants come from the first account in pool order that discovered
 * the target, so every account in the stage is asked for the same model.
 */
function stageVariantModel(
	target: string,
	requestedEffort: string | null | undefined,
	pool: readonly Account[],
	permissions: ReadonlyMap<string, AccountModelPermissions>,
): string {
	const variants = pool
		.map((a) => permissions.get(a.id)?.model_variants)
		.find((map) => map && Object.hasOwn(map, target));
	return selectEffortVariant(target, requestedEffort, variants ?? {});
}

/** Drop stale accounts for this request only; the next one reads the fresh row. */
function withoutStale(
	accounts: Account[],
	stale: ReadonlySet<string>,
	priorExclusions: Map<string, string>,
): Account[] {
	if (!stale.size) return accounts;
	return accounts.filter((a) => {
		if (!stale.has(a.id)) return true;
		priorExclusions.set(
			a.id,
			`${routeAccountLabel(a)}: account changed while this request was being routed`,
		);
		return false;
	});
}
export function getModelPermissionService(
	ctx: ProxyContext,
): AccountModelPermissionService {
	if (ctx.modelPermissions) return ctx.modelPermissions;
	let service = services.get(ctx.dbOps);
	if (!service) {
		service = new AccountModelPermissionService({
			repository: ctx.dbOps.routing,
			listAccounts: () => ctx.dbOps.getAllAccounts(),
			getAccessToken: (a) => getValidAccessToken(a, ctx),
		});
		services.set(ctx.dbOps, service);
	}
	return service;
}
export async function initializeRequestRoute(
	meta: RequestMeta,
	ctx: ProxyContext,
	apiKeyId: string | null,
	forcedAccountId: string | null,
): Promise<void> {
	const model = meta.requestedModel;
	if (!model)
		throw new RoutingPolicyError("Inference requests require a model");
	const sdkBridgeInner = getSdkBridgeInnerMetaContext(meta);
	if (sdkBridgeInner)
		return initializeSdkBridgeInnerRoute(
			meta,
			ctx,
			sdkBridgeInner,
			model,
			apiKeyId,
		);
	if (apiKeyId && !meta.internal) {
		const pin = await ctx.dbOps.getApiKeyPin(apiKeyId);
		if (!pin || pin.malformed)
			throw new RoutingPolicyError(
				"API key destinations are missing or invalid",
			);
		meta.pin = {
			accountId: pin.pinnedAccountId,
			providers: pin.pinnedProviders,
			excludedProviders: pin.excludedProviders ?? null,
		};
	}
	const headerAccountId = meta.headers?.get("x-clankermux-account-id") ?? null;
	let maintenance: BuildRouteInput["maintenance"];
	if (meta.internal) {
		if (!headerAccountId)
			throw new RoutingPolicyError(
				"Internal inference must name its destination account",
			);
		if (meta.headers?.get("x-clankermux-keepalive"))
			maintenance = { accountId: headerAccountId, purpose: "keepalive" };
		else if (meta.headers?.get("x-clankermux-auto-refresh"))
			maintenance = { accountId: headerAccountId, purpose: "auto_refresh" };
		else
			throw new RoutingPolicyError(
				"Internal inference requires a recognized maintenance purpose",
			);
	}
	const [accounts, rules] = await Promise.all([
		ctx.dbOps.getAllAccounts(),
		ctx.dbOps.routing.listRules(),
	]);
	const winning = maintenance ? null : matchRoutingRule(rules, apiKeyId, model);
	const restrictions = {
		pin: meta.pin ?? null,
		forcedAccountId,
		headerAccountId,
		excludeOfficialAnthropic: meta.excludeOfficialAnthropic === true,
		maintenance,
	};
	// An account dropped here never reaches buildResolvedRoute's own loop, so
	// carry its reason along or the rejection can only explain the survivors.
	const priorExclusions = new Map<string, string>();
	const pool = accounts.filter((a) => {
		const blocked = destinationExclusionReason(a, restrictions, winning);
		if (blocked)
			priorExclusions.set(a.id, `${routeAccountLabel(a)}: ${blocked}`);
		return !blocked;
	});
	// One model for the whole pool: only the routing table can change a model id,
	// and it does not decide per account.
	const target =
		maintenance?.purpose === "keepalive"
			? model
			: resolveRoutingTarget(winning, model).upstreamModel;
	if (!maintenance && isModelAliasId(target)) {
		const alias = await ctx.dbOps.modelAliases.get(target);
		if (!alias) throw new RoutingPolicyError(`Unknown model alias "${target}"`);
		const stages: ResolvedRoute[] = [];
		const service = getModelPermissionService(ctx);
		for (const [targetIndex, destination] of alias.targets.entries()) {
			const stagePool = pool.filter(
				(a) => !destination.accountIds || destination.accountIds.includes(a.id),
			);
			if (!stagePool.length) continue;
			const permissions = new Map<string, AccountModelPermissions>();
			const stale = new Set<string>();
			await readPermissions(service, stagePool, permissions, stale);
			let stageModel = stageVariantModel(
				destination.model,
				meta.reasoningEffort,
				stagePool,
				permissions,
			);
			const stageRule: RoutingRule = {
				id: winning?.id ?? alias.id,
				name: winning?.name ?? alias.displayName,
				enabled: true,
				position: 0,
				match_api_key_id: null,
				match_model_kind: "exact",
				match_model_value: model,
				pool_kind: destination.accountIds
					? "accounts"
					: (winning?.pool_kind ?? "inherit"),
				pool_provider: destination.accountIds
					? null
					: (winning?.pool_provider ?? null),
				pool_account_ids:
					destination.accountIds ?? winning?.pool_account_ids ?? null,
				target_kind: "literal",
				target_model: stageModel,
			};
			const missing = stagePool.filter(
				(a) =>
					!stale.has(a.id) &&
					!isModelPermitted(
						permissions.get(a.id) ?? null,
						a.id,
						stageModel,
						stageRule,
					),
			);
			if (missing.length) {
				await service.refreshMisses(missing);
				await readPermissions(service, missing, permissions, stale);
				// A first discovery is what brings the variants in.
				stageModel = stageVariantModel(
					destination.model,
					meta.reasoningEffort,
					stagePool,
					permissions,
				);
				stageRule.target_model = stageModel;
			}
			const routedStage = withoutStale(stagePool, stale, priorExclusions);
			const suppressedPairs = new Set<string>();
			const substitutedPairs = new Set<string>();
			await Promise.all(
				routedStage.map(async (a) => {
					const p = permissions.get(a.id);
					if (!p) return;
					// Same reason-bearing read as the non-alias branch below. Without
					// it an alias stage emptied by substitution suppressions reports
					// the generic 403 instead of the retryable substitution terminal,
					// and the alias path RETURNS that error to the client.
					const reason = await readSuppressionReason(
						ctx,
						a.id,
						p.scope,
						stageModel,
					);
					if (reason === null) return;
					const key = JSON.stringify([a.id, stageModel]);
					suppressedPairs.add(key);
					if (reason === MODEL_SUBSTITUTION_SUPPRESSION_REASON)
						substitutedPairs.add(key);
				}),
			);
			stages.push(
				buildResolvedRoute({
					...restrictions,
					accounts: routedStage,
					rules: [stageRule],
					requestedModel: model,
					apiKeyId,
					permissions,
					priorExclusions,
					suppressedPairs,
					substitutedPairs,
					chatRequirements: getChatContext(meta)?.requirements,
					alias: { id: alias.id, revision: alias.revision, targetIndex },
				}),
			);
		}
		installAliasRoutes(meta, stages);
		return;
	}
	await installPooledRoute(meta, ctx, {
		restrictions,
		pool,
		rules,
		winning,
		target,
		model,
		apiKeyId,
		priorExclusions,
	});
}

/**
 * Read permissions and suppressions for a pre-filtered pool and install the
 * route. Shared by ordinary requests and bridge inner calls, so both admit a
 * destination on the same evidence.
 */
async function installPooledRoute(
	meta: RequestMeta,
	ctx: ProxyContext,
	input: {
		restrictions: DestinationRestrictions;
		pool: Account[];
		rules: readonly RoutingRule[];
		winning: RoutingRule | null;
		target: string;
		model: string;
		apiKeyId: string | null;
		priorExclusions: Map<string, string>;
		sdkBridgeTurnId?: string;
	},
): Promise<void> {
	const { restrictions, pool, winning, target, priorExclusions } = input;
	const service = getModelPermissionService(ctx);
	const permissions = new Map<string, AccountModelPermissions>();
	const stale = new Set<string>();
	const read = () => readPermissions(service, pool, permissions, stale);
	if (!restrictions.maintenance) {
		await read();
		const missing = pool.filter(
			(a) =>
				!stale.has(a.id) &&
				!isModelPermitted(permissions.get(a.id) ?? null, a.id, target, winning),
		);
		if (missing.length) {
			await service.refreshMisses(missing);
			await read();
		}
	}
	const routed = withoutStale(pool, stale, priorExclusions);
	const suppressedPairs = new Set<string>();
	const substitutedPairs = new Set<string>();
	await Promise.all(
		routed.map(async (a) => {
			const p = permissions.get(a.id);
			if (!p) return;
			// The REASON, not just the fact: a route emptied by substitution
			// suppressions must not present as a permission failure.
			const reason = await readSuppressionReason(ctx, a.id, p.scope, target);
			if (reason === null) return;
			const key = JSON.stringify([a.id, target]);
			suppressedPairs.add(key);
			if (reason === MODEL_SUBSTITUTION_SUPPRESSION_REASON)
				substitutedPairs.add(key);
		}),
	);
	installResolvedRoute(
		meta,
		buildResolvedRoute({
			...restrictions,
			accounts: routed,
			rules: input.rules,
			requestedModel: input.model,
			apiKeyId: input.apiKeyId,
			permissions,
			priorExclusions,
			chatRequirements: getChatContext(meta)?.requirements,
			suppressedPairs,
			substitutedPairs,
			...(input.sdkBridgeTurnId
				? { sdkBridgeTurnId: input.sdkBridgeTurnId }
				: {}),
		}),
	);
}

/**
 * The route of a bridge inner call: exactly the frozen plan's candidates for
 * the model Claude Code asked for. The key's pin, routing rules, forced
 * accounts and the account header were all applied when the outer request
 * built the plan, and none of them is consulted again here.
 *
 * The literal rule mirrors an alias stage's: it pools the planned accounts and
 * lets `isModelPermitted` admit an account the outer route admitted through an
 * account-pool rule while its discovery was still unknown.
 */
async function initializeSdkBridgeInnerRoute(
	meta: RequestMeta,
	ctx: ProxyContext,
	inner: SdkBridgeInnerContext,
	model: string,
	apiKeyId: string | null,
): Promise<void> {
	if (Date.now() > inner.deadlineAt)
		throw new RoutingPolicyError("The SDK bridge turn's deadline has passed");
	const planned = inner.plan.candidates.filter(
		(c) => c.upstreamModel === model,
	);
	if (!planned.length)
		throw new RoutingPolicyError(
			`Model "${model}" is not a destination model of this SDK bridge turn`,
		);
	const byId = new Map(planned.map((c) => [c.accountId, c]));
	const priorExclusions = new Map<string, string>();
	const restrictions: DestinationRestrictions = {
		pin: null,
		forcedAccountId: null,
		headerAccountId: null,
		excludeOfficialAnthropic: false,
	};
	const pool = (await ctx.dbOps.getAllAccounts()).filter((a) => {
		const candidate = byId.get(a.id);
		if (!candidate) return false;
		const blocked =
			candidate.provider !== a.provider
				? "provider changed since the SDK bridge turn was planned"
				: destinationExclusionReason(a, restrictions, null);
		if (blocked)
			priorExclusions.set(a.id, `${routeAccountLabel(a)}: ${blocked}`);
		return !blocked;
	});
	const accountIds = planned.map((c) => c.accountId);
	const rule: RoutingRule = {
		id: `sdk-bridge:${inner.turnId}`,
		name: "SDK bridge turn",
		enabled: true,
		position: 0,
		match_api_key_id: null,
		match_model_kind: "exact",
		match_model_value: model,
		pool_kind: "accounts",
		pool_provider: null,
		pool_account_ids: accountIds,
		target_kind: "literal",
		target_model: model,
	};
	await installPooledRoute(meta, ctx, {
		restrictions,
		pool,
		rules: [rule],
		winning: rule,
		target: model,
		model,
		apiKeyId,
		priorExclusions,
		sdkBridgeTurnId: inner.turnId,
	});
}
/** Re-evaluate admission against the frozen policy; never re-read routing rules. */
export async function eligibleRouteAccounts(
	meta: RequestMeta,
	ctx: ProxyContext,
): Promise<Account[]> {
	const route = getResolvedRoute(meta);
	const pool = (await ctx.dbOps.getAllAccounts()).filter(
		(a) => route.target(a) !== null,
	);
	const service = getModelPermissionService(ctx);
	const checked = await Promise.all(
		pool.map(async (account) => {
			const target = route.target(account);
			if (!target) return null;
			if (!route.maintenance) {
				let permissions: AccountModelPermissions;
				try {
					permissions = await service.permissions(account);
				} catch (err) {
					if (err instanceof AccountIdentityChangedError) return null;
					throw err;
				}
				if (!route.permits(account, permissions)) return null;
				// Checked alongside the persisted row, not instead of it: a pair this
				// request already saw definitively rejected may not have reached the
				// suppression table yet (see request-model-exclusions).
				if (
					isModelExcludedForRequest(meta, account.id, target.upstreamModel) ||
					(await ctx.dbOps.routing.isModelSuppressed(
						account.id,
						target.scope,
						target.upstreamModel,
						Date.now(),
					))
				)
					return null;
			}
			return account;
		}),
	);
	return checked.filter((a): a is Account => a !== null);
}
