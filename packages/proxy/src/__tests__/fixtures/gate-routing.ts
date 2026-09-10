import { resolveRoutingTarget } from "@clankermux/core";
import type { Account, RequestMeta } from "@clankermux/types";
import { modelPermissionScope } from "../../account-model-permissions";
import {
	getResolvedRoute,
	installResolvedRoute,
	ResolvedRoute,
} from "../../resolved-route";
/** Gate unit tests receive resolved targets, just as production selection does. */
export function installGateRoute(
	meta: RequestMeta,
	accounts: Account[],
	model: string,
	targets: ReadonlyMap<string, string> = new Map(),
) {
	try {
		getResolvedRoute(meta);
		return;
	} catch {}
	installResolvedRoute(
		meta,
		new ResolvedRoute(
			{
				accounts,
				rules: [],
				requestedModel: model,
				apiKeyId: null,
				pin: meta.pin ?? null,
				permissions: new Map(),
			},
			null,
			new Map(
				accounts.map((a) => [
					a.id,
					{
						upstreamModel:
							targets.get(a.id) ??
							resolveRoutingTarget(null, a.provider, model).upstreamModel,
						targetSource: targets.has(a.id) ? "literal" : "provider_default",
						provider: a.provider,
						scope: modelPermissionScope(a),
					},
				]),
			),
		),
	);
}
export function installGatePermissions(
	ctx: import("../../handlers/proxy-types").ProxyContext,
	_accounts: Account[],
	model: string,
	targets: ReadonlyMap<string, string> = new Map(),
) {
	Object.assign(ctx.dbOps, {
		routing: { isModelSuppressed: async () => false },
	});
	ctx.modelPermissions = {
		permissions: async (a: Account) => ({
			account_id: a.id,
			scope: modelPermissionScope(a),
			generation: 1,
			completeness: "known-complete",
			discovered_ids: [
				targets.get(a.id) ??
					resolveRoutingTarget(null, a.provider, model).upstreamModel,
			],
			manual_ids: [],
		}),
		refreshMisses: async () => {},
	} as never;
}
