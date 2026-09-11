import {
	isAccountAllowedByPin,
	isModelPermitted,
	matchRoutingRule,
	resolveRoutingTarget,
} from "@clankermux/core";
import { devinClient } from "@clankermux/providers";
import type {
	Account,
	AccountModelPermissions,
	RequestMeta,
} from "@clankermux/types";
import {
	AccountModelPermissionService,
	modelPermissionScope,
} from "./account-model-permissions";
import type { ProxyContext } from "./handlers/proxy-types";
import { getValidAccessToken } from "./handlers/token-manager";
import { isOfficialAnthropicProvider } from "./provider-overload-cooldown";
import {
	type BuildRouteInput,
	buildResolvedRoute,
	type CanonicalRoutingTarget,
	getResolvedRoute,
	installResolvedRoute,
	RoutingPolicyError,
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
	const pool = accounts.filter(
		(a) =>
			isAccountAllowedByPin(meta.pin, a) &&
			(!forcedAccountId || forcedAccountId === a.id) &&
			(!headerAccountId || headerAccountId === a.id) &&
			(!meta.excludeOfficialAnthropic ||
				!isOfficialAnthropicProvider(a.provider)) &&
			(winning?.pool_kind !== "provider" ||
				winning.pool_provider === a.provider) &&
			(winning?.pool_kind !== "accounts" ||
				winning.pool_account_ids?.includes(a.id)),
	);
	const canonicalTargets = new Map<string, CanonicalRoutingTarget>();
	const baseTarget = (account: Account) =>
		maintenance?.purpose === "keepalive"
			? model
			: resolveRoutingTarget(winning, account.provider, model).upstreamModel;
	// Resolve only Devin's advertised family alias. A failed/disabled alias has no
	// destination; it must not silently select another family or bypass permissions.
	await Promise.all(
		pool.map(async (account) => {
			if (
				account.provider !== "devin" ||
				baseTarget(account) !== "swe-2" ||
				!account.api_key
			)
				return;
			const scope = modelPermissionScope(account);
			try {
				const info = await devinClient.getAccount(
					account.api_key,
					account.custom_endpoint ?? undefined,
					AbortSignal.timeout(2_000),
				);
				canonicalTargets.set(account.id, {
					upstreamModel: devinClient.resolveModel(
						info.models,
						"swe-2",
						meta.reasoningEffort ?? undefined,
					).id,
					scope,
				});
			} catch {
				// Metadata lookup already bounds authentication recovery. No inference is sent.
			}
		}),
	);
	const actualTarget = (account: Account): string | null => {
		const base = baseTarget(account);
		if (account.provider !== "devin" || base !== "swe-2") return base;
		const canonical = canonicalTargets.get(account.id);
		return canonical?.scope === modelPermissionScope(account)
			? canonical.upstreamModel
			: null;
	};
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
		const missing = pool.filter((a) => {
			const target = actualTarget(a);
			return (
				target !== null &&
				!isModelPermitted(permissions.get(a.id) ?? null, a.id, target, winning)
			);
		});
		if (missing.length) {
			await service.refreshMisses(missing);
			await read();
		}
	}
	const suppressedPairs = new Set<string>();
	await Promise.all(
		pool.map(async (a) => {
			const target = actualTarget(a);
			if (target === null) return;
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
	try {
		installResolvedRoute(
			meta,
			buildResolvedRoute({
				accounts: pool,
				rules,
				requestedModel: model,
				apiKeyId,
				pin: meta.pin ?? null,
				permissions,
				canonicalTargets,
				forcedAccountId,
				headerAccountId,
				excludeOfficialAnthropic: meta.excludeOfficialAnthropic === true,
				maintenance,
				suppressedPairs,
			}),
		);
	} catch (error) {
		if (
			error instanceof RoutingPolicyError &&
			pool.some((a) => a.provider === "devin" && baseTarget(a) === "swe-2") &&
			!pool.some((a) => a.provider === "devin" && actualTarget(a) !== null)
		) {
			error.message =
				"Could not resolve an enabled SWE-2 model for the selected Devin accounts. Refresh Devin model access, reconnect the account, or select an enabled concrete model.";
		}
		throw error;
	}
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
				if (
					await ctx.dbOps.routing.isModelSuppressed(
						account.id,
						target.scope,
						target.upstreamModel,
						Date.now(),
					)
				)
					return null;
			}
			return account;
		}),
	);
	return checked.filter((a): a is Account => a !== null);
}
