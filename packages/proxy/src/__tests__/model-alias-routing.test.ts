import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import {
	BunSqlAdapter,
	ensureSchema,
	ModelAliasRepository,
	RoutingRepository,
} from "@clankermux/database";
import { mockFetch } from "@clankermux/test-support";
import type { ModelAlias } from "@clankermux/types";
import {
	AccountModelPermissionService,
	modelPermissionScope,
} from "../account-model-permissions";
import { cacheBodyStore } from "../cache-body-store";
import {
	clearAnthropicBurstThrottle,
	markAnthropicBurstThrottle,
} from "../handlers/burst-cooldown";
import { clearAliasAffinity } from "../model-alias-routing";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";
import { handleProxy } from "../proxy";
import { makeAccount, makeContext } from "./fixtures/proxy-terminal-harness";

const originalFetch = globalThis.fetch;
const dbs: Database[] = [];
afterEach(() => {
	globalThis.fetch = originalFetch;
	clearAliasAffinity();
	cacheBodyStore.setEnabled(false);
	clearAnthropicBurstThrottle();
	clearProviderOverloadCooldown();
	for (const db of dbs.splice(0)) db.close();
});
async function setup() {
	const accounts = [0, 1, 2].map((i) =>
		makeAccount({
			id: `alias-account-${i}`,
			name: `Account ${i}`,
			custom_endpoint: `https://upstream-${i}.test`,
			provider: "anthropic",
		}),
	);
	const db = new Database(":memory:");
	dbs.push(db);
	ensureSchema(db);
	const adapter = new BunSqlAdapter(db);
	const routing = new RoutingRepository(adapter);
	const modelAliases = new ModelAliasRepository(adapter);
	for (const a of accounts)
		db.run(
			"INSERT INTO accounts(id,name,provider,created_at) VALUES(?,?,?,0)",
			[a.id, a.name, a.provider],
		);
	const alias: ModelAlias = {
		id: "alias:good",
		displayName: "Good model",
		revision: 0,
		targets: [
			{
				model: "primary-model",
				accountIds: accounts.slice(0, 2).map((a) => a.id),
			},
			{ model: "backup-model", accountIds: [accounts[2].id] },
		],
	};
	await modelAliases.save(alias);
	const ctx = makeContext(accounts);
	Object.assign(ctx.dbOps, { routing, modelAliases });
	ctx.modelPermissions = new AccountModelPermissionService({
		repository: routing,
		listAccounts: async () => accounts,
		getAccessToken: async () => "token",
		fetchImpl: mockFetch(async () => Response.json({ data: [] })),
	});
	for (const a of accounts)
		await routing.setManualModels(a.id, modelPermissionScope(a), [
			"primary-model",
			"backup-model",
		]);
	return { ctx, accounts, routing, modelAliases };
}
function request(session?: string, extra: Record<string, unknown> = {}) {
	return new Request("https://proxy.test/v1/messages", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(session ? { "x-claude-code-session-id": session } : {}),
		},
		body: JSON.stringify({
			model: "alias:good",
			max_tokens: 32,
			messages: [{ role: "user", content: "hello" }],
			...extra,
		}),
	});
}
function success(model: string) {
	return Response.json({
		id: "msg-test",
		type: "message",
		role: "assistant",
		model,
		content: [{ type: "text", text: "hello" }],
		stop_reason: "end_turn",
		usage: { input_tokens: 2, output_tokens: 1 },
	});
}
function upstream(handler: (model: string, url: string) => Response) {
	const seen: Array<{ model: string; url: string }> = [];
	globalThis.fetch = mockFetch(async (input) => {
		if (!(input instanceof Request) || !input.url.includes(".test"))
			return new Response("unavailable", { status: 503 });
		const model = (await input.clone().json()).model;
		seen.push({ model, url: input.url });
		return handler(model, input.url);
	});
	return seen;
}
async function run(ctx: ReturnType<typeof makeContext>, req = request()) {
	const response = await handleProxy(req, new URL(req.url), ctx);
	await response.clone().text();
	return response;
}
it("exhausts all primary accounts before sending the fallback and audits the reason", async () => {
	const { ctx, routing } = await setup();
	const seen = upstream((model) =>
		model === "primary-model"
			? Response.json({ error: { type: "rate_limit_error" } }, { status: 429 })
			: success(model),
	);
	expect((await run(ctx)).status).toBe(200);
	expect(seen.map((s) => s.model)).toEqual([
		"primary-model",
		"primary-model",
		"backup-model",
	]);
	const rows = await ctx.dbOps.getAllAccounts();
	expect(rows).toHaveLength(3);
	const db = dbs.at(-1);
	if (!db) throw new Error("missing database");
	const attempts = db
		.query("SELECT request_id FROM routing_attempts LIMIT 1")
		.get() as { request_id: string };
	const audit = await routing.listAttempts(attempts.request_id);
	expect(audit.map((a) => a.outgoing_model)).toEqual([
		"primary-model",
		"primary-model",
		"backup-model",
	]);
	expect(JSON.parse(audit.at(-1)?.route_snapshot ?? "{}").alias).toMatchObject({
		id: "alias:good",
		targetIndex: 1,
		reason: "quota_exhausted",
	});
});
it("skips a primary pool already cooling down", async () => {
	const { ctx, accounts } = await setup();
	for (const a of accounts.slice(0, 2))
		a.rate_limited_until = Date.now() + 60000;
	const seen = upstream((model) => success(model));
	expect((await run(ctx)).status).toBe(200);
	expect(seen.map((s) => s.model)).toEqual(["backup-model"]);
});
it.each([400, 403])("does not switch models after HTTP %s", async (status) => {
	const { ctx } = await setup();
	const seen = upstream(() =>
		Response.json(
			{ error: { type: "invalid_request_error", message: "request rejected" } },
			{ status },
		),
	);
	expect((await run(ctx)).status).toBe(status);
	expect(seen.every((s) => s.model === "primary-model")).toBe(true);
});
it("does not fall back after every primary account rejects authentication", async () => {
	const { ctx } = await setup();
	const seen = upstream(() =>
		Response.json({ error: { type: "authentication_error" } }, { status: 401 }),
	);
	const response = await run(ctx);
	expect(response.status).toBe(503);
	expect(seen.every((s) => s.model === "primary-model")).toBe(true);
});
it("does not treat a successful refusal as unavailability", async () => {
	const { ctx } = await setup();
	const seen = upstream((model) =>
		Response.json({
			id: "msg",
			type: "message",
			role: "assistant",
			model,
			content: [],
			stop_reason: "refusal",
			usage: { input_tokens: 1, output_tokens: 0 },
		}),
	);
	expect((await run(ctx)).status).toBe(200);
	expect(seen.map((s) => s.model)).toEqual(["primary-model"]);
});
it("preserves literal routing precedence over the alias registry", async () => {
	const { ctx, routing } = await setup();
	await routing.saveRule({
		id: "override",
		name: "override",
		enabled: true,
		position: 0,
		match_api_key_id: null,
		match_model_kind: "exact",
		match_model_value: "alias:good",
		pool_kind: "accounts",
		pool_account_ids: ["alias-account-0"],
		pool_provider: null,
		target_kind: "literal",
		target_model: "primary-model",
	});
	const seen = upstream((model) => success(model));
	expect((await run(ctx)).status).toBe(200);
	expect(seen.map((s) => s.model)).toEqual(["primary-model"]);
});
it("does not escape an explicit account header during fallback", async () => {
	const { ctx, accounts } = await setup();
	accounts[0].rate_limited_until = Date.now() + 60000;
	const req = request();
	req.headers.set("x-clankermux-account-id", accounts[0].id);
	const seen = upstream((model) => success(model));
	expect((await run(ctx, req)).status).toBe(503);
	expect(seen).toEqual([]);
});

it("keeps a successful fallback for the conversation after primary capacity returns", async () => {
	const { ctx, accounts } = await setup();
	for (const a of accounts.slice(0, 2))
		a.rate_limited_until = Date.now() + 60000;
	const seen = upstream((model) => success(model));
	expect((await run(ctx, request("conversation-one"))).status).toBe(200);
	for (const a of accounts) a.rate_limited_until = null;
	expect((await run(ctx, request("conversation-one"))).status).toBe(200);
	expect((await run(ctx, request("conversation-two"))).status).toBe(200);
	expect(seen.map((s) => s.model)).toEqual([
		"backup-model",
		"backup-model",
		"primary-model",
	]);
});
it("invalidates conversation target preference when the alias is edited", async () => {
	const { ctx, accounts, modelAliases } = await setup();
	for (const a of accounts.slice(0, 2))
		a.rate_limited_until = Date.now() + 60000;
	const seen = upstream((model) => success(model));
	await run(ctx, request("conversation"));
	for (const a of accounts) a.rate_limited_until = null;
	await modelAliases.save({
		...((await modelAliases.get("alias:good")) ??
			(() => {
				throw new Error("missing alias");
			})()),
		displayName: "Updated",
	});
	await run(ctx, request("conversation"));
	expect(seen.map((s) => s.model)).toEqual(["backup-model", "primary-model"]);
});
it("does not retry another model after a streaming response begins", async () => {
	const { ctx } = await setup();
	const seen = upstream(
		() =>
			new Response(
				'event: message_start\ndata: {"type":"message_start","message":{"id":"msg","type":"message","role":"assistant","model":"primary-model","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\nevent: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"interrupted"}}\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			),
	);
	const response = await run(ctx, request(undefined, { stream: true }));
	expect(response.status).toBe(200);
	expect(await response.text()).toContain("partial");
	expect(seen.map((s) => s.model)).toEqual(["primary-model"]);
});
it("falls back on transient upstream server errors", async () => {
	const { ctx } = await setup();
	const seen = upstream((model) =>
		model === "primary-model"
			? new Response("temporarily unavailable", { status: 503 })
			: success(model),
	);
	expect((await run(ctx)).status).toBe(200);
	expect(seen.map((s) => s.model)).toEqual([
		"primary-model",
		"primary-model",
		"backup-model",
	]);
});
it("keeps a frozen alias plan when configuration changes during an attempt", async () => {
	const { ctx, modelAliases } = await setup();
	const seen: string[] = [];
	globalThis.fetch = mockFetch(async (input) => {
		if (!(input instanceof Request) || !input.url.includes(".test"))
			return new Response("unavailable", { status: 503 });
		const model = (await input.clone().json()).model;
		seen.push(model);
		if (seen.length === 1)
			await modelAliases.save({
				...((await modelAliases.get("alias:good")) ??
					(() => {
						throw new Error("missing alias");
					})()),
				targets: [{ model: "unauthorized-new-model", accountIds: null }],
			});
		return model === "primary-model"
			? Response.json({ error: { type: "rate_limit_error" } }, { status: 429 })
			: success(model);
	});
	expect((await run(ctx)).status).toBe(200);
	expect(seen).toEqual(["primary-model", "primary-model", "backup-model"]);
});

it("does not let an unavailable fallback permission block a healthy preferred target", async () => {
	const { ctx, accounts, routing } = await setup();
	await routing.setManualModels(
		accounts[2].id,
		modelPermissionScope(accounts[2]),
		[],
		true,
	);
	const seen = upstream((model) => success(model));
	expect((await run(ctx)).status).toBe(200);
	expect(seen.map((s) => s.model)).toEqual(["primary-model"]);
});

it("reprobes the primary target during a known provider-wide burst", async () => {
	const { ctx, accounts } = await setup();
	for (const a of accounts.slice(0, 2)) a.refresh_token = "test-oauth";
	markAnthropicBurstThrottle();
	const seen = upstream((model) => success(model));
	expect((await run(ctx)).status).toBe(200);
	expect(seen.map((s) => s.model)).toEqual(["primary-model"]);
});
it("does not mistake missing account credentials for a network outage", async () => {
	const { ctx, accounts, routing } = await setup();
	for (const a of accounts.slice(0, 2)) {
		a.provider = "anthropic-compatible";
		a.api_key = null;
		await routing.setManualModels(a.id, modelPermissionScope(a), [
			"primary-model",
		]);
	}
	const seen = upstream((model) => success(model));
	expect((await run(ctx)).status).toBe(503);
	expect(seen).toEqual([]);
});

it("suppresses OAuth sibling diversion after a burst reprobe fails", async () => {
	const { ctx, accounts } = await setup();
	for (const a of accounts.slice(0, 2)) a.refresh_token = "test-oauth";
	markAnthropicBurstThrottle();
	const seen = upstream((model) =>
		model === "primary-model"
			? new Response("still unavailable", { status: 503 })
			: success(model),
	);
	expect((await run(ctx)).status).toBe(200);
	expect(seen.map((s) => s.model)).toEqual(["primary-model", "backup-model"]);
});

it("preserves the upstream error when remaining alias targets share the burst throttle", async () => {
	const { ctx, accounts } = await setup();
	for (const a of accounts) a.refresh_token = "test-oauth";
	markAnthropicBurstThrottle();
	const seen = upstream(
		() => new Response("upstream temporarily unavailable", { status: 503 }),
	);
	const response = await run(ctx);
	expect(response.status).toBe(503);
	expect(await response.text()).toBe("upstream temporarily unavailable");
	expect(seen.map((s) => s.model)).toEqual(["primary-model"]);
});

it("preserves the final error with a burst-suppressed trailing account", async () => {
	const { ctx, accounts, modelAliases } = await setup();
	accounts[0].refresh_token = "test-oauth";
	accounts[2].refresh_token = "test-oauth";
	const alias = await modelAliases.get("alias:good");
	if (!alias) throw new Error("missing alias");
	await modelAliases.save({
		...alias,
		targets: [
			{ model: "primary-model", accountIds: [accounts[0].id] },
			{ model: "backup-model", accountIds: [accounts[1].id, accounts[2].id] },
		],
	});
	markAnthropicBurstThrottle();
	const seen = upstream((model) => new Response(model, { status: 503 }));
	const response = await run(ctx);
	expect(response.status).toBe(503);
	expect(await response.text()).toBe("backup-model");
	expect(seen.map((s) => s.model)).toEqual(["primary-model", "backup-model"]);
});

it("cleans staged bodies and audits the rejected fallback target", async () => {
	const { ctx, accounts, routing } = await setup();
	await routing.setManualModels(
		accounts[2].id,
		modelPermissionScope(accounts[2]),
		[],
		true,
	);
	cacheBodyStore.setEnabled(true);
	let stagedDuringAttempt = false;
	const seen = upstream(() => {
		stagedDuringAttempt ||= cacheBodyStore.getStagingSize() > 0;
		return new Response("temporarily unavailable", { status: 503 });
	});
	const response = await run(
		ctx,
		request(undefined, {
			system: [
				{
					type: "text",
					text: "cached instructions",
					cache_control: { type: "ephemeral" },
				},
			],
		}),
	);
	expect(response.status).toBe(403);
	expect(stagedDuringAttempt).toBe(true);
	expect(cacheBodyStore.getStagingSize()).toBe(0);
	expect(seen.map((s) => s.model)).toEqual(["primary-model", "primary-model"]);
	const calls = ctx.recorder.recordSynthetic.mock.calls as unknown[][];
	expect(calls).toHaveLength(1);
	expect(calls[0][0]).toMatchObject({ responseStatus: 403 });
	const db = dbs.at(-1);
	if (!db) throw new Error("missing database");
	const row = db
		.query("SELECT request_id FROM routing_attempts LIMIT 1")
		.get() as { request_id: string };
	const rejected = (await routing.listAttempts(row.request_id)).find(
		(attempt) => attempt.kind === "local_reject",
	);
	expect(rejected).toBeDefined();
	expect(JSON.parse(rejected?.route_snapshot ?? "{}").alias).toMatchObject({
		id: "alias:good",
		targetIndex: 1,
	});
});
