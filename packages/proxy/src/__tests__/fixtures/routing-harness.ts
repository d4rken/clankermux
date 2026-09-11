/** Routing setup for pre-routing-table behavior tests. New isolation tests use
 * explicit repositories and permissions instead of this permissive fixture. */
import { mock } from "bun:test";
import { resolveRoutingTarget } from "@clankermux/core";
import type {
	Account,
	AccountModelPermissions,
	RequestMeta,
	RoutingAttempt,
} from "@clankermux/types";
import { getNativeResponsesRequestContext } from "@clankermux/types";
import { modelPermissionScope } from "../../account-model-permissions";
import { selectAccountsForRequest as runSelection } from "../../handlers/account-selector";
import {
	proxyWithAccount as runAccount,
	proxyForcedAccount as runForced,
} from "../../handlers/proxy-operations";
import type { ProxyContext } from "../../handlers/proxy-types";
import { handleProxy as runProxy } from "../../proxy";
import { getResolvedRoute } from "../../resolved-route";
import { initializeRequestRoute } from "../../routing-service";

export * from "../../handlers";
export * from "../../handlers/account-selector";
export * from "../../handlers/proxy-operations";
export * from "../../proxy";

const fixturePermissions = new WeakMap<
	ProxyContext,
	Map<string, AccountModelPermissions>
>();
const attempts = new WeakMap<ProxyContext, RoutingAttempt[]>();
export function routingAttempts(ctx: ProxyContext) {
	let rows = attempts.get(ctx);
	if (!rows) {
		rows = [];
		attempts.set(ctx, rows);
	}
	return rows;
}
export async function provisionRouting(
	ctx: ProxyContext,
	model: string,
	fallbackAccounts: Account[] = [],
) {
	if (ctx.dbOps.routing) {
		const rows = fixturePermissions.get(ctx);
		if (rows)
			for (const account of await ctx.dbOps.getAllAccounts()) {
				const row = rows.get(account.id);
				if (row)
					row.discovered_ids = [
						...new Set([
							...row.discovered_ids,
							model,
							resolveRoutingTarget(null, model).upstreamModel,
						]),
					];
			}
		return;
	}
	const db = ctx.dbOps as unknown as Record<string, unknown>;
	if (!db.getAllAccounts)
		db.getAllAccounts = mock(async () => fallbackAccounts);
	if (!db.getAccount)
		db.getAccount = mock(
			async (id: string) =>
				(await ctx.dbOps.getAllAccounts()).find((a) => a.id === id) ?? null,
		);
	if (!db.getApiKeyPin)
		db.getApiKeyPin = mock(async () => ({
			pinnedAccountId: null,
			pinnedProviders: null,
		}));
	const rows = new Map<string, AccountModelPermissions>();
	fixturePermissions.set(ctx, rows);
	if (!ctx.requestRecorder?.hasRecord && ctx.requestRecorder)
		Object.assign(ctx.requestRecorder, { hasRecord: () => false });
	for (const account of await ctx.dbOps.getAllAccounts()) {
		rows.set(account.id, {
			account_id: account.id,
			scope: modelPermissionScope(account),
			generation: 1,
			completeness: "known-complete",
			discovered_ids: [model, resolveRoutingTarget(null, model).upstreamModel],
			manual_ids: [],
			last_success_at: Date.now(),
			last_attempt_at: Date.now(),
			last_error: null,
		});
	}
	const audit = routingAttempts(ctx);
	attempts.set(ctx, audit);
	db.routing = {
		listRules: mock(async () => []),
		annotateAttempt: mock(
			async (id: string, error: string, status: number | null) => {
				const row = audit.find((a) => a.id === id);
				if (row) {
					row.error = error;
					row.status ??= status;
				}
			},
		),
		getPermissions: mock(async (id: string) => rows.get(id) ?? null),
		isModelSuppressed: mock(async () => false),
		suppressModel: mock(async () => {}),
		recordAttempt: mock(async (a: RoutingAttempt) => {
			audit.push({ ...a });
		}),
		finishAttempt: mock(
			async (
				id: string,
				finished_at: number,
				status: number,
				error: string | null,
				reported_model: string | null,
			) => {
				Object.assign(audit.find((a) => a.id === id) ?? {}, {
					finished_at,
					status,
					error: audit.find((a) => a.id === id)?.error ?? error,
					reported_model,
				});
			},
		),
	};
}
export async function handleProxy(...args: Parameters<typeof runProxy>) {
	let model = "claude-sonnet-4-5";
	try {
		model = (await args[0].clone().json()).model ?? model;
		const native = getNativeResponsesRequestContext(args[0]);
		if (native) model = JSON.parse(native.nativeBody).model ?? model;
	} catch {}
	await provisionRouting(args[2], model);
	if (args[5] && !args[0].headers.has("x-clankermux-account-id")) {
		const account = (await args[2].dbOps.getAllAccounts())[0];
		if (account) args[0].headers.set("x-clankermux-account-id", account.id);
	}
	return runProxy(...args);
}
async function authorize(
	meta: RequestMeta,
	ctx: ProxyContext,
	model: string,
	accounts: Account[],
) {
	await provisionRouting(ctx, model, accounts);
	try {
		getResolvedRoute(meta);
		return;
	} catch {}
	meta.requestedModel ??= model;
	if (
		meta.internal &&
		!meta.headers?.has("x-clankermux-keepalive") &&
		!meta.headers?.has("x-clankermux-auto-refresh")
	) {
		meta.headers ??= new Headers();
		meta.headers.set("x-clankermux-auto-refresh", "true");
	}
	if (
		meta.internal &&
		accounts[0] &&
		!meta.headers?.has("x-clankermux-account-id")
	) {
		meta.headers ??= new Headers();
		meta.headers.set("x-clankermux-account-id", accounts[0].id);
	}
	await initializeRequestRoute(meta, ctx, null, null);
}
export async function proxyWithAccount(...args: Parameters<typeof runAccount>) {
	const model =
		args[3].requestedModel ??
		(args[4]
			? JSON.parse(new TextDecoder().decode(args[4])).model
			: "claude-sonnet-4-5");
	args[3].headers = new Headers(args[0].headers);
	await authorize(args[3], args[7], model, [args[2]]);
	return runAccount(...args);
}
export async function proxyForcedAccount(
	...args: Parameters<typeof runForced>
) {
	const model =
		args[3].requestedModel ??
		(args[4]
			? JSON.parse(new TextDecoder().decode(args[4])).model
			: "claude-sonnet-4-5");
	args[3].headers = new Headers(args[0].headers);
	await authorize(args[3], args[5], model, [args[2]]);
	return runForced(...args);
}
export async function selectAccountsForRequest(
	...args: Parameters<typeof runSelection>
) {
	await authorize(
		args[0],
		args[1],
		args[2] ?? args[0].requestedModel ?? "claude-sonnet-4-5",
		[],
	);
	return runSelection(...args);
}

/**
 * An explicit account-scoped literal rule for behavior tests. Several account
 * ids share ONE rule, which is what a pool routed across a family boundary
 * looks like: every member resolves to the same cross-family target.
 */
export async function configureLiteralRoute(
	ctx: ProxyContext,
	requested: string,
	accountId: string | string[],
	target: string,
) {
	const accountIds = Array.isArray(accountId) ? accountId : [accountId];
	await provisionRouting(ctx, requested);
	for (const id of accountIds) {
		const row = fixturePermissions.get(ctx)?.get(id);
		if (row) row.manual_ids.push(target);
	}
	ctx.dbOps.routing.listRules = mock(async () => [
		{
			id: "test-literal",
			name: "Test literal",
			enabled: true,
			position: 0,
			match_api_key_id: null,
			match_model_kind: "any",
			match_model_value: null,
			pool_kind: "accounts",
			pool_provider: null,
			pool_account_ids: accountIds,
			target_kind: "literal",
			target_model: target,
		},
	]);
}
