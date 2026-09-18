import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import {
	BunSqlAdapter,
	ensureSchema,
	ModelAliasRepository,
	RoutingRepository,
} from "@clankermux/database";
import { handleResponsesRequest } from "@clankermux/openai-responses-adapter";
import { mockFetch } from "@clankermux/test-support";
import {
	AccountModelPermissionService,
	modelPermissionScope,
} from "../account-model-permissions";
import { clearAliasAffinity } from "../model-alias-routing";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";
import { handleProxy } from "../proxy";
import { makeAccount, makeContext } from "./fixtures/proxy-terminal-harness";

const originalFetch = globalThis.fetch;
const databases: Database[] = [];
const services: AccountModelPermissionService[] = [];
afterEach(() => {
	globalThis.fetch = originalFetch;
	clearAliasAffinity();
	clearProviderOverloadCooldown();
	for (const service of services.splice(0)) service.stop();
	for (const db of databases.splice(0)) db.close();
});

async function setup(
	backupProvider: "openrouter" | "codex",
	primaryProvider: "anthropic" | "openrouter" = "anthropic",
) {
	const primary = makeAccount({
		id: crypto.randomUUID(),
		provider: primaryProvider,
		custom_endpoint: "https://primary-alias.test",
		api_key: "primary-key",
	});
	const backup = makeAccount({
		id: crypto.randomUUID(),
		provider: backupProvider,
		custom_endpoint:
			backupProvider === "codex"
				? "https://backup-alias.test/responses"
				: "https://backup-alias.test/api/v1",
		api_key: backupProvider === "codex" ? null : "backup-key",
		refresh_token: backupProvider === "codex" ? "backup-refresh" : "",
		access_token: "backup-access",
		expires_at: Date.now() + 3_600_000,
	});
	const accounts = [primary, backup];
	const backupModel =
		backupProvider === "codex" ? "gpt-6-astra" : "openai/gpt-6-astra";
	const db = new Database(":memory:");
	databases.push(db);
	ensureSchema(db);
	const adapter = new BunSqlAdapter(db);
	const routing = new RoutingRepository(adapter);
	const modelAliases = new ModelAliasRepository(adapter);
	for (const account of accounts)
		db.run(
			"INSERT INTO accounts(id,name,provider,created_at) VALUES(?,?,?,0)",
			[account.id, account.name, account.provider],
		);
	await modelAliases.save({
		id: "alias:cross-provider",
		displayName: "Cross-provider",
		revision: 0,
		targets: [
			{ model: "claude-fable-5", accountIds: [primary.id] },
			{ model: backupModel, accountIds: [backup.id] },
		],
	});
	const ctx = makeContext(accounts);
	Object.assign(ctx.dbOps, { routing, modelAliases });
	const permissions = new AccountModelPermissionService({
		repository: routing,
		listAccounts: async () => accounts,
		getAccessToken: async () => "unused",
		fetchImpl: mockFetch(async () => Response.json({ data: [] })),
	});
	services.push(permissions);
	ctx.modelPermissions = permissions;
	await routing.setManualModels(primary.id, modelPermissionScope(primary), [
		"claude-fable-5",
	]);
	await routing.setManualModels(backup.id, modelPermissionScope(backup), [
		backupModel,
	]);
	return { ctx, primary, backup, backupModel };
}

type Dispatch = {
	url: string;
	body: Record<string, unknown>;
	authorization: string | null;
};
function mockUpstreams(respond: (dispatch: Dispatch) => Response) {
	const dispatches: Dispatch[] = [];
	globalThis.fetch = mockFetch(async (input) => {
		if (
			!(input instanceof Request) ||
			!new URL(input.url).hostname.endsWith("-alias.test")
		)
			return new Response("Background discovery unavailable", { status: 503 });
		const dispatch = {
			url: input.url,
			body: await input.clone().json(),
			authorization: input.headers.get("authorization"),
		};
		dispatches.push(dispatch);
		return respond(dispatch);
	});
	return dispatches;
}
function messagesRequest() {
	return new Request("https://proxy.test/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "alias:cross-provider",
			max_tokens: 32,
			stream: false,
			messages: [
				{ role: "user", content: "Explain this code." },
				{
					role: "system",
					content: "Use more effort now.",
					output_config: { effort: "high" },
				},
			],
		}),
	});
}
function messageSuccess(model: string) {
	return Response.json({
		id: "msg-backup",
		type: "message",
		role: "assistant",
		model,
		content: [{ type: "text", text: "Backup answered." }],
		stop_reason: "end_turn",
		usage: { input_tokens: 5, output_tokens: 3 },
	});
}

it("exhausts Anthropic then applies OpenRouter's own Messages endpoint, authentication and effort adaptation", async () => {
	const { ctx, backupModel } = await setup("openrouter");
	const sent = mockUpstreams(({ body }) =>
		body.model === "claude-fable-5"
			? Response.json({ error: { type: "rate_limit_error" } }, { status: 429 })
			: messageSuccess(backupModel),
	);
	const req = messagesRequest();
	const response = await handleProxy(req, new URL(req.url), ctx);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		model: backupModel,
		content: [{ type: "text", text: "Backup answered." }],
	});
	expect(sent.map(({ body }) => body.model)).toEqual([
		"claude-fable-5",
		backupModel,
	]);
	expect(sent[1]).toMatchObject({
		url: "https://backup-alias.test/api/v1/messages",
		authorization: "Bearer backup-key",
		body: {
			output_config: { effort: "high" },
			messages: [
				{ role: "user", content: "Explain this code." },
				{ role: "system", content: "Use more effort now." },
			],
		},
	});
});

it("keeps API-key destination restrictions when a cross-provider fallback is available", async () => {
	const { ctx, primary, backupModel } = await setup("openrouter");
	Object.assign(ctx.dbOps, {
		getApiKeyPin: async () => ({
			pinnedAccountId: null,
			pinnedProviders: ["anthropic"],
			malformed: false,
		}),
	});
	const sent = mockUpstreams(({ body }) =>
		body.model === "claude-fable-5"
			? Response.json({ error: { type: "rate_limit_error" } }, { status: 429 })
			: messageSuccess(backupModel),
	);
	const req = messagesRequest();
	const response = await handleProxy(
		req,
		new URL(req.url),
		ctx,
		"restricted-client",
	);
	await response.text();
	expect(response.status).toBe(503);
	expect(sent.map(({ body }) => body.model)).toEqual(["claude-fable-5"]);
	// An exhausted account pin must be equally strict even for an unrestricted provider list.
	Object.assign(ctx.dbOps, {
		getApiKeyPin: async () => ({
			pinnedAccountId: primary.id,
			pinnedProviders: null,
			malformed: false,
		}),
	});
	const second = messagesRequest();
	await (
		await handleProxy(second, new URL(second.url), ctx, "account-pinned-client")
	).text();
	expect(sent.every(({ body }) => body.model === "claude-fable-5")).toBe(true);
});

it.each([
	"anthropic",
	"openrouter",
] as const)("preserves native Responses input with a %s primary and Codex backup", async (primaryProvider) => {
	const { ctx, backupModel } = await setup("codex", primaryProvider);
	const result = {
		id: "resp-alias",
		object: "response",
		status: "completed",
		model: backupModel,
		output: [
			{
				type: "message",
				id: "msg-codex",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Native backup answered." }],
			},
		],
		usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
	};
	const sse = `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: result.id, model: backupModel } })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: result })}\n\n`;
	const sent = mockUpstreams(({ body }) =>
		body.model === "claude-fable-5"
			? Response.json({ error: { type: "rate_limit_error" } }, { status: 429 })
			: new Response(sse, { headers: { "content-type": "text/event-stream" } }),
	);
	const input = [
		{
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "Preserve this Responses input." }],
		},
	];
	const req = new Request("https://proxy.test/v1/responses", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "alias:cross-provider",
			instructions: "Be brief.",
			input,
			stream: false,
		}),
	});
	const response = await handleResponsesRequest(
		req,
		new URL(req.url),
		handleProxy as never,
		ctx,
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual(result);
	// Responses ingress excludes official Anthropic accounts before dispatch.
	// OpenRouter is permitted, so it receives the translated Messages request
	// and its 429 causes a real provider/model fallback to native Codex.
	expect(sent.map(({ body }) => body.model)).toEqual(
		primaryProvider === "anthropic"
			? [backupModel]
			: ["claude-fable-5", backupModel],
	);
	if (primaryProvider === "openrouter")
		expect(sent[0]?.body.messages).toBeDefined();
	const nativeDispatch = sent.at(-1);
	expect(nativeDispatch).toMatchObject({
		url: "https://backup-alias.test/responses",
		authorization: "Bearer backup-access",
		body: {
			model: backupModel,
			input,
			instructions: "Be brief.",
			stream: true,
		},
	});
	expect(nativeDispatch?.body.messages).toBeUndefined();
});
