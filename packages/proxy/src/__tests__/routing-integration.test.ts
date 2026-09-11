import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	BunSqlAdapter,
	ensureSchema,
	RoutingRepository,
} from "@clankermux/database";
import { handleChatCompletionsRequest } from "@clankermux/openai-chat-adapter";
import { usageCache } from "@clankermux/providers";
import type { Account, RequestMeta, RoutingRule } from "@clankermux/types";
import {
	AccountModelPermissionService,
	modelPermissionScope,
} from "../account-model-permissions";
import { setForcedAccount } from "../handlers";
import { proxyWithAccount } from "../handlers/proxy-operations";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";
import { handleProxy } from "../proxy";
import { sendAuthorizedRequest } from "../routing-dispatch";
import { isDefinitiveModelError } from "../routing-response-audit";
import { initializeRequestRoute } from "../routing-service";
import { makeAccount, makeContext } from "./fixtures/proxy-terminal-harness";

const originalFetch = globalThis.fetch;
const dbs: Database[] = [];
const headroomAccounts: string[] = [];
afterEach(() => {
	globalThis.fetch = originalFetch;
	setForcedAccount(null);
	for (const id of headroomAccounts.splice(0)) usageCache.delete(id);
	clearProviderOverloadCooldown();
	for (const db of dbs.splice(0)) db.close();
});
const requested = "claude-fable-5-1";
const rule = (patch: Partial<RoutingRule> = {}): RoutingRule => ({
	id: "rule",
	name: "Experiment",
	position: 0,
	enabled: true,
	match_api_key_id: null,
	match_model_kind: "exact",
	match_model_value: requested,
	pool_kind: "provider",
	pool_provider: "codex",
	pool_account_ids: null,
	target_kind: "default",
	target_model: null,
	...patch,
});
async function setup(accounts: Account[], rules: RoutingRule[]) {
	const db = new Database(":memory:");
	dbs.push(db);
	ensureSchema(db);
	const routing = new RoutingRepository(new BunSqlAdapter(db));
	for (const a of accounts)
		db.run(
			"INSERT INTO accounts(id,name,provider,refresh_token,created_at) VALUES(?,?,?,'',0)",
			[a.id, a.name, a.provider],
		);
	for (const r of rules) await routing.saveRule(r);
	const ctx = makeContext(accounts);
	Object.assign(ctx.dbOps, {
		routing,
		getApiKeyPin: mock(async () => ({
			pinnedAccountId: null,
			pinnedProviders: ["codex", "openrouter"],
		})),
	});
	ctx.modelPermissions = new AccountModelPermissionService({
		repository: routing,
		listAccounts: async () => accounts,
		getAccessToken: async () => "test-token",
		fetchImpl: (async () => Response.json({ data: [] })) as typeof fetch,
	});
	return { ctx, routing };
}
function request(extra: Record<string, unknown> = {}) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: requested,
			max_tokens: 32,
			stream: false,
			messages: [{ role: "user", content: "hello" }],
			...extra,
		}),
	});
}
function codexResponse(model?: string) {
	const response = {
		id: "resp-test",
		...(model ? { model } : {}),
		status: "completed",
		output: [
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "hello" }],
			},
		],
		usage: { input_tokens: 3, output_tokens: 2 },
	};
	const events = [
		{
			type: "response.created",
			response: { id: response.id, ...(model ? { model } : {}) },
		},
		{
			type: "response.content_part.added",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "" },
		},
		{
			type: "response.output_text.delta",
			delta: "hello",
			output_index: 0,
			content_index: 0,
		},
		{ type: "response.completed", response },
	];
	return new Response(
		events
			.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}
describe("routing table through the real proxy", () => {
	it.each([
		false,
		true,
	])("answers OpenRouter token counts locally (forced=%s)", async (forced) => {
		const account = makeAccount({
			id: "local-count",
			provider: "openrouter",
			api_key: null,
			access_token: null,
			refresh_token: null,
		});
		const { ctx, routing } = await setup(
			[account],
			[
				rule({
					pool_provider: "openrouter",
					target_kind: "literal",
					target_model: "deepseek/deepseek-v4-pro",
				}),
			],
		);
		await routing.setManualModels(account.id, modelPermissionScope(account), [
			"deepseek/deepseek-v4-pro",
		]);
		const fetchMock = mock(async () => {
			throw new Error(
				"Local count must not send inference or refresh credentials",
			);
		});
		globalThis.fetch = fetchMock as typeof fetch;
		if (forced) setForcedAccount(account.id);
		const req = new Request("https://proxy.local/v1/messages/count_tokens", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-clankermux-token-count-source": "forged",
			},
			body: JSON.stringify({
				model: requested,
				messages: [{ role: "user", content: "hello" }],
			}),
		});
		const response = await handleProxy(req, new URL(req.url), ctx, "test-key");
		expect(response.status).toBe(200);
		expect(response.headers.get("x-clankermux-token-count-source")).toBe(
			"local-estimate",
		);
		expect((await response.json()).input_tokens).toBeGreaterThan(0);
		expect(fetchMock).not.toHaveBeenCalled();
		const attempts = dbs.at(-1)?.query("SELECT * FROM routing_attempts").all();
		expect(attempts).toHaveLength(1);
		expect(attempts[0]).toMatchObject({
			kind: "local_success",
			status: 200,
			provider: "openrouter",
			requested_model: requested,
			resolved_model: "deepseek/deepseek-v4-pro",
			outgoing_model: null,
			reported_model: null,
		});
		expect(ctx.requestRecorder.begin).not.toHaveBeenCalled();
	});
	it.each([
		false,
		true,
	])("preserves upstream OpenRouter custom-endpoint counts (forced=%s)", async (forced) => {
		const account = makeAccount({
			id: "custom-count",
			provider: "openrouter",
			custom_endpoint: "https://gateway.example",
			api_key: "upstream-key",
		});
		const { ctx, routing } = await setup(
			[account],
			[rule({ pool_provider: "openrouter", target_kind: "requested" })],
		);
		await routing.setManualModels(account.id, modelPermissionScope(account), [
			requested,
		]);
		const fetchMock = mock(async (input: Request | string | URL) => {
			expect(input).toBeInstanceOf(Request);
			const outgoing = input as Request;
			expect(outgoing.url).toBe(
				"https://gateway.example/v1/messages/count_tokens",
			);
			expect(outgoing.headers.get("authorization")).toBe("Bearer upstream-key");
			expect((await outgoing.json()).model).toBe(requested);
			return Response.json({ input_tokens: 777 });
		});
		globalThis.fetch = fetchMock as typeof fetch;
		if (forced) setForcedAccount(account.id);
		const req = new Request("https://proxy.local/v1/messages/count_tokens", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: requested,
				messages: [{ role: "user", content: "hello" }],
			}),
		});
		const response = await handleProxy(req, new URL(req.url), ctx, "test-key");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ input_tokens: 777 });
		expect(response.headers.get("x-clankermux-token-count-source")).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(ctx.requestRecorder.begin).toHaveBeenCalledTimes(1);
		const attempts = dbs.at(-1)?.query("SELECT * FROM routing_attempts").all();
		expect(attempts).toHaveLength(1);
		expect(attempts[0]).toMatchObject({
			kind: "upstream_send",
			outgoing_model: requested,
			status: 200,
		});
	});

	it.each([
		"revoked",
		"suppressed",
		"paused",
	])("does not bypass %s policy after a pinned pool becomes exhausted", async (reason) => {
		const account = makeAccount({
			id: "exhausted-policy",
			provider: "openrouter",
		});
		const { ctx, routing } = await setup([account], []);
		const scope = modelPermissionScope(account);
		await routing.setManualModels(account.id, scope, [requested]);
		ctx.strategy.select = mock(async () => {
			if (reason === "revoked")
				await routing.setManualModels(account.id, scope, [], true);
			else if (reason === "suppressed")
				await routing.suppressModel(
					account.id,
					scope,
					requested,
					Date.now() + 60000,
					"test",
				);
			else account.paused = true;
			return [];
		});
		const fetchMock = mock(async () => {
			throw new Error("policy-excluded destination contacted");
		});
		globalThis.fetch = fetchMock as typeof fetch;
		const req = new Request("https://proxy.local/v1/messages/count_tokens", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: requested,
				messages: [{ role: "user", content: "hello" }],
			}),
		});
		const response = await handleProxy(req, new URL(req.url), ctx, "test-key");
		expect(response.status).not.toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(ctx.requestRecorder.begin).not.toHaveBeenCalled();
	});

	it("does not count on a provider outside the client key's destinations", async () => {
		const account = makeAccount({
			id: "disallowed-count",
			provider: "openrouter",
		});
		const { ctx, routing } = await setup([account], []);
		await routing.setManualModels(account.id, modelPermissionScope(account), [
			requested,
		]);
		ctx.dbOps.getApiKeyPin = mock(async () => ({
			pinnedAccountId: null,
			pinnedProviders: ["codex"],
		}));
		const fetchMock = mock(async () => {
			throw new Error("Forbidden destination contacted");
		});
		globalThis.fetch = fetchMock as typeof fetch;
		const req = new Request("https://proxy.local/v1/messages/count_tokens", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: requested,
				messages: [{ role: "user", content: "hello" }],
			}),
		});
		const response = await handleProxy(req, new URL(req.url), ctx, "test-key");
		expect(response.status).toBe(403);
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("records malformed OpenRouter counts as local rejections without billing", async () => {
		const account = makeAccount({
			id: "invalid-count",
			provider: "openrouter",
			api_key: null,
		});
		const { ctx, routing } = await setup([account], []);
		await routing.setManualModels(account.id, modelPermissionScope(account), [
			requested,
		]);
		const fetchMock = mock(async () => {
			throw new Error("Local validation must not send inference");
		});
		globalThis.fetch = fetchMock as typeof fetch;
		const req = new Request("https://proxy.local/v1/messages/count_tokens", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: requested, messages: null }),
		});
		const response = await handleProxy(req, new URL(req.url), ctx, "test-key");
		expect(response.status).toBe(400);
		expect((await response.json()).error.type).toBe("invalid_request_error");
		expect(response.headers.get("x-clankermux-token-count-source")).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(
			dbs
				.at(-1)
				?.query(
					"SELECT kind,status,outgoing_model,reported_model,error FROM routing_attempts",
				)
				.all(),
		).toEqual([
			{
				kind: "local_reject",
				status: 400,
				outgoing_model: null,
				reported_model: null,
				error: "Local token count rejected (HTTP 400)",
			},
		]);
		expect(ctx.requestRecorder.begin).not.toHaveBeenCalled();
	});
	it.each([
		"revoked",
		"suppressed",
	])("rechecks %s permission before unwrapping a local count", async (reason) => {
		const account = makeAccount({
			id: "local-recheck",
			provider: "openrouter",
		});
		const { ctx, routing } = await setup([account], []);
		const scope = modelPermissionScope(account);
		await routing.setManualModels(account.id, scope, [requested]);
		const meta: RequestMeta = {
			id: "count-recheck",
			method: "POST",
			path: "/v1/messages/count_tokens",
			timestamp: Date.now(),
			requestedModel: requested,
		};
		await initializeRequestRoute(meta, ctx, "test-key", null);
		if (reason === "revoked")
			await routing.setManualModels(account.id, scope, [], true);
		else
			await routing.suppressModel(
				account.id,
				scope,
				requested,
				Date.now() + 60000,
				"test",
			);
		const fetchMock = mock(async () => {
			throw new Error("Invalidated target contacted");
		});
		globalThis.fetch = fetchMock as typeof fetch;
		await expect(
			sendAuthorizedRequest(
				new Request("https://clankermux.local/openrouter/count_tokens", {
					method: "POST",
					headers: {
						"x-clankermux-synthetic-response": "true",
						"x-clankermux-synthetic-status": "200",
					},
					body: JSON.stringify({ input_tokens: 10 }),
				}),
				account,
				meta,
				ctx,
			),
		).rejects.toThrow("no longer permits");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await routing.listAttempts(meta.id)).toMatchObject([
			{ kind: "local_reject", status: 403, outgoing_model: null },
		]);
	});
	it("ignores forged synthetic markers on ordinary OpenRouter inference", async () => {
		const account = makeAccount({
			id: "forged-count",
			provider: "openrouter",
			api_key: "test-key",
		});
		const { ctx, routing } = await setup([account], []);
		await routing.setManualModels(account.id, modelPermissionScope(account), [
			requested,
		]);
		const fetchMock = mock(async (input: Request | string | URL) => {
			expect(input).toBeInstanceOf(Request);
			const outgoing = input as Request;
			expect(outgoing.url).toBe("https://openrouter.ai/api/v1/messages");
			expect(
				outgoing.headers.get("x-clankermux-synthetic-response"),
			).toBeNull();
			return Response.json({
				id: "real-response",
				type: "message",
				role: "assistant",
				model: requested,
				content: [{ type: "text", text: "actual response" }],
				stop_reason: "end_turn",
				usage: { input_tokens: 2, output_tokens: 2 },
			});
		});
		globalThis.fetch = fetchMock as typeof fetch;
		const req = request();
		req.headers.set("x-clankermux-synthetic-response", "true");
		req.headers.set("x-clankermux-synthetic-status", "200");
		const response = await handleProxy(req, new URL(req.url), ctx, "test-key");
		expect(response.status).toBe(200);
		expect((await response.json()).content[0].text).toBe("actual response");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(
			dbs
				.at(-1)
				?.query("SELECT kind,outgoing_model FROM routing_attempts")
				.all(),
		).toEqual([{ kind: "upstream_send", outgoing_model: requested }]);
	});
	it.each([
		"rule",
		"permission",
		"provider pin",
		"account pin",
		"permitted peer",
		"global force",
	])("pools quota headers only over authorized destinations: %s", async (boundary) => {
		const accounts = ["serving", "peer"].map((name) =>
			makeAccount({
				id: `routing-headroom-${name}`,
				provider:
					boundary === "provider pin" && name === "peer" ? "openai" : "codex",
				access_token: "test",
				refresh_token: "test",
				api_key: null,
				expires_at: Date.now() + 3600000,
			}),
		);
		const [serving, peer] = accounts;
		if (boundary === "global force") setForcedAccount(serving.id);
		const { ctx, routing } = await setup(accounts, [
			rule({
				pool_kind: boundary === "rule" ? "accounts" : "inherit",
				pool_provider: null,
				pool_account_ids: boundary === "rule" ? [serving.id] : null,
				target_kind: "literal",
				target_model: "gpt-6-astra",
			}),
		]);
		Object.assign(ctx.dbOps, {
			saveCodexWindowObservations: mock(async () => {}),
			getAdapter: () => ({
				runWithChanges: async () => 1,
				run: async () => {},
				get: async () => null,
			}),
		});
		if (boundary === "account pin")
			Object.assign(ctx.dbOps, {
				getApiKeyPin: mock(async () => ({
					pinnedAccountId: serving.id,
					pinnedProviders: null,
				})),
			});
		const reset = Date.now() + 72 * 3600000;
		for (const a of accounts) {
			await routing.setManualModels(
				a.id,
				modelPermissionScope(a),
				boundary === "permission" && a.id === peer.id ? [] : ["gpt-6-astra"],
			);
			headroomAccounts.push(a.id);
			usageCache.set(a.id, {
				five_hour: null,
				// Both candidates are initially outside the liveness reserve. The
				// serving account's fresher wire reading will replace its cache.
				seven_day: {
					utilization: a.id === serving.id ? 40 : 20,
					resets_at: new Date(reset).toISOString(),
				},
			} as never);
		}
		const sent: Request[] = [];
		globalThis.fetch = mock(async (input: Request | string | URL) => {
			const outgoing = input instanceof Request ? input : new Request(input);
			if (!outgoing.url.includes("chatgpt.com"))
				throw new Error(`Unexpected destination ${outgoing.url}`);
			sent.push(outgoing);
			const response = codexResponse("gpt-6-astra");
			response.headers.set("x-codex-primary-window-minutes", "10080");
			response.headers.set("x-codex-primary-used-percent", "90");
			response.headers.set("x-codex-primary-reset-after-seconds", "777");
			response.headers.set(
				"x-codex-primary-reset-at",
				String(Math.floor(reset / 1000)),
			);
			return response;
		}) as typeof fetch;
		const req = request();
		const response = await handleProxy(
			req,
			new URL(req.url),
			ctx,
			"experiment",
		);
		expect(response.status).toBe(200);
		await response.text();
		expect(sent).toHaveLength(1);
		expect((await sent[0].clone().json()).model).toBe("gpt-6-astra");
		expect(Number(response.headers.get("x-codex-primary-used-percent"))).toBe(
			boundary === "permitted peer" ? 20 : 90,
		);
		if (boundary === "global force") {
			expect(response.headers.get("x-codex-primary-reset-after-seconds")).toBe(
				"777",
			);
		}
	});
	it("translates Claude Code Fable to Codex Astra and audits raw model separately", async () => {
		const official = makeAccount({ id: "official", provider: "anthropic" }),
			codex = makeAccount({
				id: "codex",
				provider: "codex",
				api_key: null,
				access_token: "test",
				refresh_token: "rt",
				expires_at: Date.now() + 3600000,
			});
		const { ctx, routing } = await setup([official, codex], [rule()]);
		await routing.setManualModels(codex.id, modelPermissionScope(codex), [
			"gpt-6-astra",
		]);
		const sent: Request[] = [];
		globalThis.fetch = mock(async (input: Request | string | URL) => {
			const req = input instanceof Request ? input : new Request(input);
			if (!req.url.includes("chatgpt.com"))
				throw new Error(`Unexpected destination ${req.url}`);
			sent.push(req);
			return codexResponse();
		}) as typeof fetch;
		const req = request();
		const response = await handleProxy(
			req,
			new URL(req.url),
			ctx,
			"experiment",
		);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.model).toBe("gpt-6-astra");
		expect(sent).toHaveLength(1);
		expect((await sent[0].clone().json()).model).toBe("gpt-6-astra");
		const rows = dbs[0]
			.query<{ request_id: string }, []>(
				"SELECT request_id FROM routing_attempts",
			)
			.all();
		const audit = await routing.listAttempts(rows[0].request_id);
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({
			requested_model: requested,
			resolved_model: "gpt-6-astra",
			outgoing_model: "gpt-6-astra",
			reported_model: null,
			kind: "upstream_send",
			status: 200,
		});
	});
	it("routes to OpenRouter Muse with tool calls and preserves the upstream model", async () => {
		const a = makeAccount({
			id: "or",
			provider: "openrouter",
			api_key: "or-key",
		});
		const { ctx, routing } = await setup(
			[a],
			[
				rule({
					pool_provider: "openrouter",
					target_kind: "literal",
					target_model: "meta/muse-spark-1.3",
				}),
			],
		);
		await routing.setManualModels(a.id, modelPermissionScope(a), [
			"meta/muse-spark-1.3",
		]);
		const sent: Record<string, unknown>[] = [];
		globalThis.fetch = mock(async (input: Request | string | URL) => {
			const req = input instanceof Request ? input : new Request(input);
			expect(req.url).toBe("https://openrouter.ai/api/v1/messages");
			sent.push(await req.clone().json());
			return Response.json({
				id: "msg-test",
				type: "message",
				role: "assistant",
				model: "meta/muse-spark-1.3",
				content: [
					{
						type: "tool_use",
						id: "call-test",
						name: "lookup",
						input: { query: "hello" },
					},
				],
				stop_reason: "tool_use",
				usage: { input_tokens: 3, output_tokens: 2 },
			});
		}) as typeof fetch;
		const req = request({
			tools: [
				{
					name: "lookup",
					description: "Search",
					input_schema: {
						type: "object",
						properties: { query: { type: "string" } },
					},
				},
			],
		});
		const response = await handleProxy(
			req,
			new URL(req.url),
			ctx,
			"experiment",
		);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.model).toBe("meta/muse-spark-1.3");
		expect(body.content).toContainEqual({
			type: "tool_use",
			id: "call-test",
			name: "lookup",
			input: { query: "hello" },
		});
		expect(sent).toHaveLength(1);
		expect(sent[0].model).toBe("meta/muse-spark-1.3");
		expect(sent[0].tools).toHaveLength(1);
		const rows = dbs[0]
			.query<{ request_id: string }, []>(
				"SELECT request_id FROM routing_attempts",
			)
			.all();
		expect(
			(await routing.listAttempts(rows[0].request_id))[0].reported_model,
		).toBe("meta/muse-spark-1.3");
	});

	it.each([
		1, 2,
	])("preserves an OpenRouter provider-policy rejection across %i permitted accounts", async (count) => {
		const account = makeAccount({
			id: "or-policy",
			provider: "openrouter",
			api_key: "test-only",
		});
		const model = "meta/muse-spark-1.3";
		const accounts = Array.from({ length: count }, (_, i) => ({
			...account,
			id: `${account.id}-${i}`,
		}));
		const { ctx, routing } = await setup(accounts, [
			rule({
				pool_provider: "openrouter",
				target_kind: "literal",
				target_model: model,
			}),
		]);
		const _scope = modelPermissionScope(account);
		for (const a of accounts)
			await routing.setManualModels(a.id, modelPermissionScope(a), [model]);
		const envelope = {
			type: "error",
			error: {
				type: "not_found_error",
				message:
					"No allowed providers are available for the selected model. Providers serving meta/muse-spark-1.3: meta, but your account's allowed-providers setting permits only: openai. Visit https://openrouter.ai/settings/privacy.",
				error_type: "not_found",
			},
			metadata: { failed_routing_step: "Filter by Allowed Providers" },
		};
		const fetcher = mock(async () => Response.json(envelope, { status: 404 }));
		globalThis.fetch = fetcher as typeof fetch;
		const req = request();
		const response = await handleProxy(
			req,
			new URL(req.url),
			ctx,
			"experiment",
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual(envelope);
		expect(fetcher).toHaveBeenCalledTimes(count);
		for (const a of accounts)
			expect(
				await routing.isModelSuppressed(
					a.id,
					modelPermissionScope(a),
					model,
					Date.now(),
				),
			).toBe(false);
		const attempts = dbs[0]
			.query<{ kind: string; outgoing_model: string; status: number }, []>(
				"SELECT kind,outgoing_model,status FROM routing_attempts",
			)
			.all();
		expect(attempts).toEqual(
			accounts.map(() => ({
				kind: "upstream_send",
				outgoing_model: model,
				status: 404,
			})),
		);
	});

	it("names the resolved target when all accounts reject a remapped model", async () => {
		const account = makeAccount({ id: "denied-target", provider: "codex" });
		const { ctx, routing } = await setup([account], [rule()]);
		await routing.setManualModels(account.id, modelPermissionScope(account), [
			"gpt-6-astra",
		]);
		globalThis.fetch = mock(async () =>
			Response.json(
				{
					detail:
						"The gpt-6-astra model is not supported when using Codex with a ChatGPT account.",
				},
				{ status: 400 },
			),
		) as typeof fetch;
		const req = request();
		await expect(
			handleProxy(req, new URL(req.url), ctx, "experiment"),
		).rejects.toThrow(
			"rejected its resolved model (gpt-6-astra). Requested model: 'claude-fable-5-1'",
		);
	});
	it("never sends when an experiment key conflicts with an official-only winning rule", async () => {
		const official = makeAccount({ id: "official", provider: "anthropic" });
		const { ctx } = await setup(
			[official],
			[rule({ pool_provider: "anthropic", target_kind: "requested" })],
		);
		const fetcher = mock(async () => {
			throw new Error("Must not send");
		});
		globalThis.fetch = fetcher as typeof fetch;
		const req = request();
		const response = await handleProxy(
			req,
			new URL(req.url),
			ctx,
			"experiment",
		);
		expect(response.status).toBe(403);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("rejects model-switch escape fields before a send", async () => {
		const a = makeAccount({ id: "c", provider: "codex" });
		const { ctx, routing } = await setup([a], [rule()]);
		await routing.setManualModels(a.id, modelPermissionScope(a), [
			"gpt-6-astra",
		]);
		const fetcher = mock(async () => {
			throw new Error("Must not send");
		});
		globalThis.fetch = fetcher as typeof fetch;
		const req = request({ models: ["other"] });
		const response = await handleProxy(
			req,
			new URL(req.url),
			ctx,
			"experiment",
		);
		expect(response.status).toBe(403);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("records local preparation failure on its own account without overwriting the previous send", async () => {
		const first = makeAccount({
			id: "first",
			provider: "openrouter",
			api_key: "test",
		});
		const second = makeAccount({
			id: "second",
			provider: "codex",
			api_key: "test",
		});
		const { ctx, routing } = await setup([first, second], []);
		for (const a of [first, second])
			await routing.setManualModels(a.id, modelPermissionScope(a), [
				"gpt-6-astra",
			]);
		const req = new Request("https://proxy.local/v1/unsupported", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "gpt-6-astra", messages: [] }),
		});
		const meta: RequestMeta = {
			id: "audit-separate",
			method: "POST",
			path: "/v1/unsupported",
			timestamp: Date.now(),
			requestedModel: "gpt-6-astra",
			headers: req.headers,
		};
		await initializeRequestRoute(meta, ctx, null, null);
		globalThis.fetch = mock(async () =>
			Response.json(
				{ error: { type: "api_error", message: "unavailable" } },
				{ status: 502 },
			),
		) as typeof fetch;
		const body = await req.clone().arrayBuffer();
		await proxyWithAccount(
			req,
			new URL(req.url),
			first,
			meta,
			body,
			() => undefined,
			0,
			ctx,
		);
		const before = await routing.listAttempts(meta.id);
		expect(before).toHaveLength(1);
		await proxyWithAccount(
			req,
			new URL(req.url),
			second,
			meta,
			body,
			() => undefined,
			1,
			ctx,
		);
		const after = await routing.listAttempts(meta.id);
		expect(after).toHaveLength(2);
		expect(after.find((a) => a.account_id === first.id)?.error).toBe(
			before[0].error,
		);
		expect(after.find((a) => a.account_id === second.id)).toMatchObject({
			kind: "local_reject",
			outgoing_model: null,
			resolved_model: "gpt-6-astra",
		});
	});
	it("rechecks model permission immediately before dispatch after a manual revocation", async () => {
		const account = makeAccount({ id: "revoked", provider: "codex" });
		const { ctx, routing } = await setup([account], [rule()]);
		await routing.setManualModels(account.id, modelPermissionScope(account), [
			"gpt-6-astra",
		]);
		const req = request();
		const meta: RequestMeta = {
			id: "revoke",
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			requestedModel: requested,
			headers: req.headers,
		};
		await initializeRequestRoute(meta, ctx, "experiment", account.id);
		await routing.setManualModels(
			account.id,
			modelPermissionScope(account),
			[],
			true,
		);
		const fetcher = mock(async () => Response.json({}));
		globalThis.fetch = (async (input: Request | string | URL) => {
			const url = input instanceof Request ? input.url : String(input);
			// The pricing singleton may finish its lazy cache read during this test.
			// Exclude only its exact public metadata endpoint; count every other send.
			if (url === "https://models.dev/api.json") return Response.json({});
			return fetcher();
		}) as typeof fetch;
		await expect(
			sendAuthorizedRequest(
				new Request("https://upstream.test/v1/messages", {
					method: "POST",
					body: JSON.stringify({ model: "gpt-6-astra" }),
				}),
				account,
				meta,
				ctx,
			),
		).rejects.toThrow("no longer permits");
		expect(fetcher).not.toHaveBeenCalled();
		expect(await routing.listAttempts(meta.id)).toMatchObject([
			{ kind: "local_reject", outgoing_model: null, status: 403 },
		]);
	});
	it("requires the internal dispatch flag before maintenance can bypass discovery", async () => {
		const account = makeAccount({ id: "maintenance", provider: "codex" });
		const { ctx } = await setup([account], []);
		const headers = new Headers({
			"x-clankermux-account-id": account.id,
			"x-clankermux-keepalive": "true",
		});
		const base: RequestMeta = {
			id: "external-probe",
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			requestedModel: "gpt-6-astra",
			headers,
		};
		await expect(
			initializeRequestRoute(base, ctx, null, null),
		).rejects.toThrow();
		await expect(
			initializeRequestRoute(
				{ ...base, id: "trusted-probe", internal: true },
				ctx,
				null,
				null,
			),
		).resolves.toBeUndefined();
		await expect(
			initializeRequestRoute(
				{
					...base,
					id: "unnamed-probe",
					internal: true,
					headers: new Headers({ "x-clankermux-keepalive": "true" }),
				},
				ctx,
				null,
				null,
			),
		).rejects.toThrow("name its destination");
	});
	it.each([
		{ error: { code: "model_not_entitled" } },
		{
			detail:
				"The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.",
		},
	])("suppresses only the exact account/model pair on definitive rejection %j", async (payload) => {
		const account = makeAccount({ id: "denied", provider: "codex" });
		const { ctx, routing } = await setup([account], [rule()]);
		const scope = modelPermissionScope(account);
		await routing.setManualModels(account.id, scope, ["gpt-6-astra"]);
		const meta: RequestMeta = {
			id: "denied-attempt",
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			requestedModel: requested,
			headers: new Headers(),
		};
		await initializeRequestRoute(meta, ctx, null, null);
		globalThis.fetch = mock(async () =>
			Response.json(payload, { status: 403 }),
		) as typeof fetch;
		const response = await sendAuthorizedRequest(
			new Request("https://upstream.test/v1/messages", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-6-astra" }),
			}),
			account,
			meta,
			ctx,
		);
		await response.text();
		expect(
			await routing.isModelSuppressed(
				account.id,
				scope,
				"gpt-6-astra",
				Date.now(),
			),
		).toBe(true);
		expect(
			await routing.isModelSuppressed(
				"other",
				scope,
				"gpt-6-astra",
				Date.now(),
			),
		).toBe(false);
		expect(
			await routing.isModelSuppressed(
				account.id,
				scope,
				"gpt-5.6-sol",
				Date.now(),
			),
		).toBe(false);
		expect((await routing.getPermissions(account.id))?.manual_ids).toContain(
			"gpt-6-astra",
		);
		for (const status of [429, 500, 529])
			expect(
				isDefinitiveModelError(
					{ error: { code: "model_not_entitled" } },
					status,
				),
			).toBe(false);
	});
	it("suppresses a model-access error delivered inside HTTP200 SSE", async () => {
		const account = makeAccount({ id: "stream-denied", provider: "codex" });
		const { ctx, routing } = await setup([account], [rule()]);
		const scope = modelPermissionScope(account);
		await routing.setManualModels(account.id, scope, ["gpt-6-astra"]);
		const meta: RequestMeta = {
			id: "stream-denied-attempt",
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			requestedModel: requested,
			headers: new Headers(),
		};
		await initializeRequestRoute(meta, ctx, null, null);
		globalThis.fetch = mock(
			async () =>
				new Response(
					'data: {"type":"response.failed","response":{"error":{"code":"model_not_entitled"}}}\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				),
		) as typeof fetch;
		const response = await sendAuthorizedRequest(
			new Request("https://upstream.test/v1/messages", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-6-astra" }),
			}),
			account,
			meta,
			ctx,
		);
		await response.text();
		expect(
			await routing.isModelSuppressed(
				account.id,
				scope,
				"gpt-6-astra",
				Date.now(),
			),
		).toBe(true);
	});
});

describe("Chat ingress through real route and provider conversion", () => {
	for (const provider of ["codex", "openrouter"])
		for (const forced of [false, true])
			for (const stream of [false, true])
				it(`${provider}, forced=${forced}, stream=${stream}: one authorized send, truthful model fallback and one usage finalization`, async () => {
					const account = makeAccount({
						provider,
						id: `chat-${provider}-${forced}`,
						access_token: provider === "codex" ? "test" : null,
						refresh_token: null,
						api_key: provider === "openrouter" ? "test" : null,
						expires_at: Date.now() + 3600000,
					});
					const official = makeAccount({
						provider: "anthropic",
						id: `denied-${provider}-${forced}`,
					});
					const { ctx, routing } = await setup(
						[official, account],
						[
							rule({
								pool_provider: provider,
								target_kind: "literal",
								target_model: "gpt-6-astra",
							}),
						],
					);
					await routing.setManualModels(
						account.id,
						modelPermissionScope(account),
						["gpt-6-astra"],
					);
					if (forced) setForcedAccount(account.id);
					const sent: Request[] = [];
					globalThis.fetch = mock(async (input: Request | string | URL) => {
						const outgoing =
							input instanceof Request ? input : new Request(input);
						if (
							!outgoing.url.includes(
								provider === "codex" ? "chatgpt.com" : "openrouter.ai",
							)
						)
							throw new Error("Denied destination reached");
						sent.push(outgoing.clone());
						if (provider === "codex") return codexResponse();
						const events = [
							{
								type: "message_start",
								message: {
									id: "msg",
									type: "message",
									role: "assistant",
									content: [],
									usage: { input_tokens: 3, output_tokens: 0 },
								},
							},
							{
								type: "content_block_start",
								index: 0,
								content_block: { type: "text", text: "" },
							},
							{
								type: "content_block_delta",
								index: 0,
								delta: { type: "text_delta", text: "hello" },
							},
							{ type: "content_block_stop", index: 0 },
							{
								type: "message_delta",
								delta: { stop_reason: "end_turn" },
								usage: { output_tokens: 2 },
							},
							{ type: "message_stop" },
						];
						return new Response(
							events
								.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
								.join(""),
							{ headers: { "content-type": "text/event-stream" } },
						);
					}) as typeof fetch;
					const req = new Request(
						"http://proxy/wire/openai/v1/chat/completions",
						{
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								model: requested,
								stream,
								messages: [{ role: "user", content: "hello" }],
							}),
						},
					);
					const response = await handleChatCompletionsRequest(
						req,
						new URL(req.url),
						handleProxy as Parameters<typeof handleChatCompletionsRequest>[2],
						ctx,
						"chat-key",
						undefined,
						7777,
					);
					if (response.status !== 200) throw new Error(await response.text());
					expect(response.status).toBe(200);
					if (stream) {
						const result = await response.text();
						expect(result).toContain("[DONE]");
						expect(result).toContain('"content":"hello"');
						expect(result).toContain('"model":"gpt-6-astra"');
					} else {
						const result = await response.json();
						expect(result.model).toBe("gpt-6-astra");
						expect(result.choices[0].message.content).toBe("hello");
					}
					expect(sent).toHaveLength(1);
					const outgoing = await sent[0].json();
					expect(outgoing.model).toBe("gpt-6-astra");
					expect(outgoing.stream).toBe(true);
					if (provider === "openrouter") expect(outgoing.max_tokens).toBe(7777);
					else expect(outgoing.max_tokens).toBeUndefined();
					await new Promise((r) => setTimeout(r, 10));
					const attempts = dbs
						.at(-1)
						?.query("SELECT * FROM routing_attempts")
						.all();
					expect(attempts).toHaveLength(1);
					expect(attempts[0]).toMatchObject({
						kind: "upstream_send",
						requested_model: requested,
						resolved_model: "gpt-6-astra",
						outgoing_model: "gpt-6-astra",
						reported_model: null,
						status: 200,
						error: null,
					});
					expect(ctx.recorder.finishTransport).toHaveBeenCalledTimes(1);
					expect(ctx.recorder.attachUsageSummary.mock.calls.length).toBe(1);
				});
	it("rejects explicit Codex output caps locally with 400 and a single local audit", async () => {
		const account = makeAccount({
			provider: "codex",
			id: "chat-cap",
			access_token: "test",
			expires_at: Date.now() + 3600000,
		});
		const { ctx, routing } = await setup(
			[account],
			[rule({ target_kind: "literal", target_model: "gpt-6-astra" })],
		);
		await routing.setManualModels(account.id, modelPermissionScope(account), [
			"gpt-6-astra",
		]);
		const fetchMock = mock(async () => {
			throw new Error("No upstream request expected");
		});
		globalThis.fetch = fetchMock as typeof fetch;
		const req = new Request("http://proxy/wire/openai/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				model: requested,
				max_tokens: 32,
				messages: [{ role: "user", content: "hello" }],
			}),
		});
		const response = await handleChatCompletionsRequest(
			req,
			new URL(req.url),
			handleProxy as Parameters<typeof handleChatCompletionsRequest>[2],
			ctx,
			"chat-key",
		);
		expect(response.status).toBe(400);
		expect((await response.json()).error.param).toBe("max_tokens");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(
			dbs
				.at(-1)
				?.query("SELECT kind,status,outgoing_model FROM routing_attempts")
				.all(),
		).toEqual([{ kind: "local_reject", status: 400, outgoing_model: null }]);
	});
});

describe("Chat cancellation across routing and providers", () => {
	for (const provider of ["codex", "openrouter"])
		for (const phase of ["headers", "before-text", "during-text", "json"]) {
			it(`${provider}: abort during ${phase} cancels transport without retry`, async () => {
				const account = makeAccount({
					id: `cancel-${provider}-${phase}`,
					provider,
					access_token: provider === "codex" ? "test" : null,
					api_key: provider === "openrouter" ? "test" : null,
					refresh_token: null,
					expires_at: Date.now() + 3600000,
				});
				const { ctx, routing } = await setup([account], []);
				await routing.setManualModels(
					account.id,
					modelPermissionScope(account),
					["gpt-6-astra"],
				);
				const ac = new AbortController();
				let sends = 0,
					canceled = false;
				let started!: () => void;
				const sent = new Promise<void>((r) => {
					started = r;
				});
				globalThis.fetch = (async (input: Request | string | URL) => {
					const req = input instanceof Request ? input : new Request(input);
					sends++;
					started();
					if (phase === "headers")
						return new Promise<Response>((_, reject) => {
							req.signal.addEventListener(
								"abort",
								() => {
									canceled = true;
									reject(req.signal.reason);
								},
								{ once: true },
							);
						});
					const events =
						provider === "codex"
							? [
									{
										type: "response.created",
										response: { id: "r", model: "gpt-6-astra" },
									},
									...(phase === "during-text"
										? [
												{
													type: "response.content_part.added",
													output_index: 0,
													content_index: 0,
													part: { type: "output_text", text: "" },
												},
												{
													type: "response.output_text.delta",
													output_index: 0,
													content_index: 0,
													delta: "hello",
												},
											]
										: []),
								]
							: [
									{
										type: "message_start",
										message: {
											id: "m",
											model: "gpt-6-astra",
											usage: { input_tokens: 1, output_tokens: 0 },
										},
									},
									...(phase === "during-text"
										? [
												{
													type: "content_block_start",
													index: 0,
													content_block: { type: "text", text: "" },
												},
												{
													type: "content_block_delta",
													index: 0,
													delta: { type: "text_delta", text: "hello" },
												},
											]
										: []),
								];
					return new Response(
						new ReadableStream({
							start(c) {
								c.enqueue(
									new TextEncoder().encode(
										events
											.map(
												(e) =>
													`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`,
											)
											.join(""),
									),
								);
							},
							cancel() {
								canceled = true;
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				}) as typeof fetch;
				const req = new Request(
					"http://proxy/wire/openai/v1/chat/completions",
					{
						method: "POST",
						signal: ac.signal,
						body: JSON.stringify({
							model: "gpt-6-astra",
							stream: phase !== "json",
							messages: [{ role: "user", content: "hello" }],
						}),
					},
				);
				const pending = handleChatCompletionsRequest(
					req,
					new URL(req.url),
					handleProxy as Parameters<typeof handleChatCompletionsRequest>[2],
					ctx,
					"chat-key",
				);
				await sent;
				if (phase === "headers" || phase === "json") {
					await new Promise((r) => setTimeout(r, 5));
					ac.abort();
					expect((await pending).status).toBe(499);
				} else {
					const response = await pending;
					const reader = response.body?.getReader();
					let content = "";
					do {
						const n = await reader.read();
						content += new TextDecoder().decode(n.value);
					} while (phase === "during-text" && !content.includes("hello"));
					ac.abort();
					await reader.cancel();
				}
				await new Promise((r) => setTimeout(r, 25));
				expect(canceled).toBe(true);
				expect(sends).toBe(1);
			});
		}
});

it("retries Chat only within the frozen compatible destinations after 429", async () => {
	const accounts = [
		makeAccount({ id: "retry-first", provider: "openrouter", api_key: "test" }),
		makeAccount({
			id: "incompatible",
			provider: "codex",
			access_token: "test",
		}),
		makeAccount({
			id: "retry-second",
			provider: "openrouter",
			api_key: "test",
		}),
	];
	const { ctx, routing } = await setup(accounts, []);
	for (const account of accounts)
		await routing.setManualModels(account.id, modelPermissionScope(account), [
			"gpt-6-astra",
		]);
	let sends = 0;
	globalThis.fetch = (async (input: Request | string | URL) => {
		const req = input instanceof Request ? input : new Request(input);
		expect(req.url).toContain("openrouter.ai");
		const body = await req.json();
		expect(body.max_tokens).toBe(32);
		sends++;
		if (sends === 1) {
			await routing.saveRule(
				rule({
					match_model_kind: "any",
					match_model_value: null,
					pool_provider: "codex",
				}),
			);
			return Response.json(
				{ error: { type: "rate_limit_error", message: "limited" } },
				{ status: 429, headers: { "retry-after": "1" } },
			);
		}
		return new Response(
			'event: message_start\ndata: {"type":"message_start","message":{"model":"actual","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
			{ headers: { "content-type": "text/event-stream" } },
		);
	}) as typeof fetch;
	const req = new Request("http://proxy/wire/openai/v1/chat/completions", {
		method: "POST",
		body: JSON.stringify({
			model: "gpt-6-astra",
			max_tokens: 32,
			messages: [{ role: "user", content: "hi" }],
		}),
	});
	const response = await handleChatCompletionsRequest(
		req,
		new URL(req.url),
		handleProxy as Parameters<typeof handleChatCompletionsRequest>[2],
		ctx,
		"chat-key",
	);
	expect(response.status).toBe(200);
	await response.text();
	expect(sends).toBe(2);
	const attempts = dbs
		.at(-1)
		?.query(
			"SELECT a.account_id,a.status,s.content AS policy_snapshot FROM routing_attempts a JOIN routing_snapshots s ON s.id=a.route_snapshot_id ORDER BY a.account_id",
		)
		.all() as { account_id: string; status: number; policy_snapshot: string }[];
	expect(attempts.map((a) => a.account_id)).toEqual([
		"retry-first",
		"retry-second",
	]);
	expect(attempts.map((a) => a.status)).toEqual([429, 200]);
	expect(attempts[0].policy_snapshot).toBe(attempts[1].policy_snapshot);
	expect(
		JSON.parse(attempts[0].policy_snapshot).chatRequirements.fields,
	).toEqual(["max_tokens"]);
});

it("rejects reasoning history for a Codex-only pin before any send", async () => {
	const account = makeAccount({ id: "reasoning-codex", provider: "codex" });
	const { ctx, routing } = await setup([account], []);
	Object.assign(ctx.dbOps, {
		getApiKeyPin: async () => ({
			pinnedAccountId: account.id,
			pinnedProviders: null,
		}),
	});
	await routing.setManualModels(account.id, modelPermissionScope(account), [
		"gpt-6-astra",
	]);
	const fetcher = mock(async () => {
		throw new Error("Must not send");
	});
	globalThis.fetch = fetcher as typeof fetch;
	const req = new Request("http://proxy/wire/openai/v1/chat/completions", {
		method: "POST",
		body: JSON.stringify({
			model: "gpt-6-astra",
			messages: [
				{
					role: "assistant",
					content: "answer",
					reasoning_content: "prior thought",
				},
				{ role: "user", content: "continue" },
			],
		}),
	});
	const result = await handleChatCompletionsRequest(
		req,
		new URL(req.url),
		handleProxy as Parameters<typeof handleChatCompletionsRequest>[2],
		ctx,
		"key",
	);
	expect(result.status).toBe(400);
	expect((await result.json()).error.param).toBe("reasoning_content");
	expect(fetcher).not.toHaveBeenCalled();
});
