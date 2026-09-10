import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	BunSqlAdapter,
	ensureSchema,
	RoutingRepository,
} from "@clankermux/database";
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
