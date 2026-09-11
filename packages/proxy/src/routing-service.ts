import {
	isModelPermitted,
	matchRoutingRule,
	resolveRoutingTarget,
} from "@clankermux/core";
import type {
	Account,
	AccountModelPermissions,
	RequestMeta,
} from "@clankermux/types";
import { getChatContext } from "@clankermux/types";
import { AccountModelPermissionService } from "./account-model-permissions";
import type { ProxyContext } from "./handlers/proxy-types";
import { getValidAccessToken } from "./handlers/token-manager";
import { isModelExcludedForRequest } from "./request-model-exclusions";
import {
	type BuildRouteInput,
	buildResolvedRoute,
	destinationExclusionReason,
	getResolvedRoute,
	installResolvedRoute,
	RoutingPolicyError,
	routeAccountLabel,
} from "./resolved-route";

const services = new WeakMap<object, AccountModelPermissionService>();
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
	if (apiKeyId && !meta.internal) {
		const pin = await ctx.dbOps.getApiKeyPin(apiKeyId);
		if (!pin || pin.malformed)
			throw new RoutingPolicyError(
				"API key destinations are missing or invalid",
			);
		meta.pin = {
			accountId: pin.pinnedAccountId,
			providers: pin.pinnedProviders,
		};
	}
	const headerAccountId =
		meta.headers?.get("x-clankermux-account-id") ??
		meta.headers?.get("x-better-ccflare-account-id") ??
		null;
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
	const service = getModelPermissionService(ctx);
	const permissions = new Map<string, AccountModelPermissions>();
	const read = async () => {
		await Promise.all(
			pool.map(async (a) =>
				permissions.set(a.id, await service.permissions(a)),
			),
		);
	};
	if (!maintenance) {
		await read();
		const missing = pool.filter(
			(a) =>
				!isModelPermitted(permissions.get(a.id) ?? null, a.id, target, winning),
		);
		if (missing.length) {
			await service.refreshMisses(missing);
			await read();
		}
	}
	const suppressedPairs = new Set<string>();
	await Promise.all(
		pool.map(async (a) => {
			const p = permissions.get(a.id);
			if (
				p &&
				(await ctx.dbOps.routing.isModelSuppressed(
					a.id,
					p.scope,
					target,
					Date.now(),
				))
			)
				suppressedPairs.add(JSON.stringify([a.id, target]));
		}),
	);
	installResolvedRoute(
		meta,
		buildResolvedRoute({
			...restrictions,
			accounts: pool,
			rules,
			requestedModel: model,
			apiKeyId,
			permissions,
			priorExclusions,
			chatRequirements: getChatContext(meta)?.requirements,
			suppressedPairs,
		}),
	);
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
				const permissions = await service.permissions(account);
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
