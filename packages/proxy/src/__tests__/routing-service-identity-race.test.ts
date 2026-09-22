import { expect, it, mock } from "bun:test";
import type {
	Account,
	AccountModelPermissions,
	RequestMeta,
} from "@clankermux/types";
import {
	AccountIdentityChangedError,
	AccountModelPermissionService,
	modelPermissionScope,
} from "../account-model-permissions";
import type { ProxyContext } from "../handlers/proxy-types";
import {
	buildResolvedRoute,
	getResolvedRoute,
	installResolvedRoute,
	RoutingPolicyError,
} from "../resolved-route";
import { sendAuthorizedRequest } from "../routing-dispatch";
import {
	eligibleRouteAccounts,
	initializeRequestRoute,
} from "../routing-service";
import { makeAccount, makeContext } from "./fixtures/proxy-terminal-harness";

const MODEL = "claude-haiku-4-5";

function permitted(account: Account): AccountModelPermissions {
	return {
		account_id: account.id,
		scope: modelPermissionScope(account),
		generation: 1,
		completeness: "known-complete",
		discovered_ids: [MODEL],
		manual_ids: [],
		last_success_at: 1,
		last_attempt_at: 1,
		last_error: null,
	};
}

// The production sequence: a sign-in inserts the account row, a request reads
// the account list, and the sign-in's identity write lands before that request
// reaches the permission read. The request's snapshot then disagrees with the
// row the permission service re-reads.
function setup() {
	const established = {
		id: "established",
		provider: "anthropic",
		name: "Established",
		api_key: null,
		custom_endpoint: null,
	} as Account;
	const justAdded = {
		id: "just-added",
		provider: "grok-subscription",
		name: "Just added",
		api_key: null,
		custom_endpoint: null,
	} as Account;
	const afterIdentityWrite = {
		...justAdded,
		identity_external_id: "xai-user",
		identity_email: "user@example.com",
	} as Account;
	const rows = new Map([[established.id, permitted(established)]]);
	let listing: Account[] = [established, afterIdentityWrite];
	const service = new AccountModelPermissionService({
		repository: {
			getPermissions: async (id: string) => rows.get(id) ?? null,
			ensurePermissionScope: async () => {
				throw new Error("a stale snapshot must never create a scope row");
			},
		} as never,
		listAccounts: async () => listing,
		getAccessToken: async () => "unused",
	});
	const refreshMisses = mock(async (_accounts: readonly Account[]) => {});
	service.refreshMisses = refreshMisses;
	const ctx = {
		dbOps: {
			getAllAccounts: async () => [established, justAdded],
			routing: {
				listRules: async () => [],
				isModelSuppressed: async () => false,
			},
		},
		modelPermissions: service,
	} as unknown as ProxyContext;
	const meta = {
		id: crypto.randomUUID(),
		requestedModel: MODEL,
		path: "/v1/messages",
		method: "POST",
		timestamp: Date.now(),
	} as RequestMeta;
	return {
		established,
		justAdded,
		afterIdentityWrite,
		rows,
		service,
		refreshMisses,
		ctx,
		meta,
		setListing: (next: Account[]) => {
			listing = next;
		},
	};
}

it("names the stale-snapshot condition with its own error type", async () => {
	const { justAdded, service } = setup();
	await expect(service.permissions(justAdded)).rejects.toBeInstanceOf(
		AccountIdentityChangedError,
	);
});

it("routes the request without an account whose identity changed mid-request", async () => {
	const { established, justAdded, refreshMisses, ctx, meta } = setup();
	await initializeRequestRoute(meta, ctx, null, null);
	const route = getResolvedRoute(meta);
	expect(route.target(established)?.upstreamModel).toBe(MODEL);
	expect(route.target(justAdded)).toBeNull();
	// Discovery for the stale snapshot would only record a failure against a
	// scope that no longer exists.
	for (const [accounts] of refreshMisses.mock.calls)
		expect(accounts.map((a) => a.id)).not.toContain(justAdded.id);
});

it("leaves an account out of eligibility when its identity changes after routing", async () => {
	const {
		established,
		justAdded,
		afterIdentityWrite,
		rows,
		ctx,
		meta,
		setListing,
	} = setup();
	// Consistent at routing time, so the route admits both accounts.
	rows.set(justAdded.id, permitted(justAdded));
	setListing([established, justAdded]);
	await initializeRequestRoute(meta, ctx, null, null);
	expect(getResolvedRoute(meta).target(justAdded)?.upstreamModel).toBe(MODEL);
	// The identity write lands, and another request re-scopes the row, between
	// the failover path's account read and its permission read.
	setListing([established, afterIdentityWrite]);
	rows.set(justAdded.id, permitted(afterIdentityWrite));
	const eligible = await eligibleRouteAccounts(meta, ctx);
	expect(eligible.map((a) => a.id)).toEqual([established.id]);
});

it("reports an identity change at the dispatch gate as a policy rejection, not a transport failure", async () => {
	const account = makeAccount({ provider: "zai", api_key: "zai-key" });
	const ctx = makeContext([account]);
	ctx.modelPermissions = {
		permissions: async () => {
			throw new AccountIdentityChangedError();
		},
	} as never;
	const recordAttempt = mock(async (_attempt: unknown) => {});
	(ctx.dbOps as { routing: unknown }).routing = {
		recordAttempt,
		finishAttempt: mock(async () => {}),
		isModelSuppressed: mock(async () => false),
	};
	ctx.dbOps.getAccount = mock(async () => account);
	const meta = {
		id: crypto.randomUUID(),
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		requestedModel: "glm-4.6",
	} as RequestMeta;
	installResolvedRoute(
		meta,
		buildResolvedRoute({
			accounts: [account],
			rules: [],
			requestedModel: "glm-4.6",
			apiKeyId: null,
			pin: null,
			permissions: new Map([
				[account.id, { ...permitted(account), discovered_ids: ["glm-4.6"] }],
			]),
		}),
	);
	const request = new Request("https://api.z.ai/api/anthropic/v1/messages", {
		method: "POST",
		body: "{}",
	});
	await expect(
		sendAuthorizedRequest(request, account, meta, ctx),
	).rejects.toBeInstanceOf(RoutingPolicyError);
	expect(recordAttempt.mock.calls[0]?.[0]).toMatchObject({
		status: 403,
		error: "Destination identity changed before dispatch",
	});
});
