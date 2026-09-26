import { Database } from "bun:sqlite";
import { afterEach, expect, it, mock } from "bun:test";
import {
	BunSqlAdapter,
	ensureSchema,
	RoutingRepository,
} from "@clankermux/database";
import { mockFetch } from "@clankermux/test-support";
import type { RequestMeta } from "@clankermux/types";
import {
	AccountModelPermissionService,
	modelPermissionScope,
} from "../account-model-permissions";
import { getResolvedRoute } from "../resolved-route";
import { sendAuthorizedRequest } from "../routing-dispatch";
import {
	eligibleRouteAccounts,
	initializeRequestRoute,
} from "../routing-service";
import { makeAccount, makeContext } from "./fixtures/proxy-terminal-harness";

const BARE = "claude-opus-5-5";
const dbs: Database[] = [];
afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
});

async function setup() {
	const accounts = ["kept", "suppressed"].map((id) =>
		makeAccount({ id, name: id, provider: "anthropic" }),
	);
	const db = new Database(":memory:");
	dbs.push(db);
	ensureSchema(db);
	const routing = new RoutingRepository(new BunSqlAdapter(db));
	for (const a of accounts) {
		db.run(
			"INSERT INTO accounts(id,name,provider,refresh_token,created_at) VALUES(?,?,?,'',0)",
			[a.id, a.name, a.provider],
		);
		await routing.setManualModels(a.id, modelPermissionScope(a), [BARE]);
	}
	const ctx = makeContext(accounts);
	Object.assign(ctx.dbOps, {
		routing,
		getApiKeyPin: mock(async () => null),
	});
	ctx.modelPermissions = new AccountModelPermissionService({
		repository: routing,
		listAccounts: async () => accounts,
		getAccessToken: async () => "test-token",
		fetchImpl: mockFetch(async () => Response.json({ data: [] })),
	});
	ctx.sdkBridge = {
		availability: () => ({ state: "available" }),
	} as unknown as typeof ctx.sdkBridge;
	const [, suppressed] = accounts;
	return { ctx, routing, suppressed };
}

function bridgedMeta(id: string): RequestMeta {
	return {
		id,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		requestedModel: `${BARE}[1m]`,
		officialAnthropicVia: "sdk-bridge",
		headers: new Headers(),
	};
}

it("leaves an account suppressed for the bare id out of a [1m] route", async () => {
	const { ctx, routing, suppressed } = await setup();
	await routing.suppressModel(
		suppressed.id,
		modelPermissionScope(suppressed),
		BARE,
		Date.now() + 60_000,
		"test",
	);
	const meta = bridgedMeta("one-m-suppressed");
	await initializeRequestRoute(meta, ctx, null, null);
	expect(getResolvedRoute(meta).accountIds()).toEqual(["kept"]);
});

it("drops an account suppressed for the bare id after the route was built", async () => {
	const { ctx, routing, suppressed } = await setup();
	const meta = bridgedMeta("one-m-suppressed-later");
	await initializeRequestRoute(meta, ctx, null, null);
	expect(getResolvedRoute(meta).accountIds().sort()).toEqual([
		"kept",
		"suppressed",
	]);
	await routing.suppressModel(
		suppressed.id,
		modelPermissionScope(suppressed),
		BARE,
		Date.now() + 60_000,
		"test",
	);
	expect((await eligibleRouteAccounts(meta, ctx)).map((a) => a.id)).toEqual([
		"kept",
	]);
});

it("refuses the bridged send once the bare id is suppressed", async () => {
	const { ctx, routing, suppressed } = await setup();
	const meta = bridgedMeta("one-m-suppressed-at-dispatch");
	await initializeRequestRoute(meta, ctx, null, null);
	await routing.suppressModel(
		suppressed.id,
		modelPermissionScope(suppressed),
		BARE,
		Date.now() + 60_000,
		"test",
	);
	const transport = mock(async () => new Response("turn"));
	await expect(
		sendAuthorizedRequest(
			new Request("https://proxy.local/v1/messages", {
				method: "POST",
				body: JSON.stringify({ model: `${BARE}[1m]` }),
			}),
			suppressed,
			meta,
			ctx,
			undefined,
			undefined,
			null,
			undefined,
			transport,
		),
	).rejects.toThrow("no longer permits");
	expect(transport).not.toHaveBeenCalled();
});
