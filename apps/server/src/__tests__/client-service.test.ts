import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "@clankermux/core";
import { matchRoutingRule } from "@clankermux/core";
import { DatabaseOperations } from "@clankermux/database";
import {
	AccountModelPermissionService,
	type CodexModelCatalogCache,
	modelPermissionScope,
} from "@clankermux/proxy";
import { tempDbTracker } from "@clankermux/test-support";
import type { ClientDraft, ClientView, RoutingRule } from "@clankermux/types";
import { ClientService } from "../client-service";
import { ModelCatalogService } from "../model-catalog-service";

const temp = tempDbTracker("client-service");
const raw = (slug = "gpt-real", context = 64000) => ({
	bodyText: JSON.stringify({
		models: [
			{
				slug,
				display_name: slug,
				context_window: context,
				base_instructions: `instructions for ${slug}`,
			},
		],
		server_version: "test",
	}),
	etag: "upstream",
});
const blank = (): ClientDraft => ({
	name: "CNC",
	application: "generic",
	destinations: { accountId: null, providers: null },
	catalogues: {
		anthropic: { models: [], defaultModel: null },
		openai: { models: [], defaultModel: null },
		codex: { models: [], defaultModel: null },
	},
});
const edit = (client: ClientView): ClientDraft => ({
	id: client.apiKeyId,
	revision: client.revision,
	name: client.key.name,
	application: client.application,
	destinations: {
		accountId: client.key.pinnedAccountId,
		providers: client.key.pinnedProviders,
	},
	catalogues: client.catalogues,
});
const broad: RoutingRule = {
	id: "broad",
	name: "Broad existing rule",
	position: 0,
	enabled: true,
	match_api_key_id: null,
	match_model_kind: "any",
	match_model_value: null,
	pool_kind: "inherit",
	pool_provider: null,
	pool_account_ids: null,
	target_kind: "requested",
	target_model: null,
};
describe("client service integration", () => {
	let dbOps: DatabaseOperations;
	let service: ClientService;
	let permissions: AccountModelPermissionService;
	let currentRaw: ReturnType<typeof raw> | null;
	beforeEach(() => {
		dbOps = new DatabaseOperations(temp.next());
		for (const [id, provider] of [
			["c", "codex"],
			["d", "devin"],
		])
			dbOps
				.getAdapter()
				.getSQLiteDb()
				.query(
					"INSERT INTO accounts(id,name,provider,created_at) VALUES(?,?,?,?)",
				)
				.run(id, id, provider, 100);
		currentRaw = raw();
		permissions = new AccountModelPermissionService({
			repository: dbOps.routing,
			listAccounts: () => dbOps.getAllAccounts(),
			getAccessToken: async () => {
				throw new Error("No test network");
			},
		});
		const codex = {
			getForPin: async (pin: {
				accountId: string | null;
				providers: string[] | null;
			}) =>
				pin.accountId === "d" ||
				(pin.providers && !pin.providers.includes("codex"))
					? null
					: currentRaw,
		} as unknown as CodexModelCatalogCache;
		const catalog = new ModelCatalogService({
			anthropicCatalog: {
				get: async () => ({
					models: [
						{
							id: "claude-known",
							displayName: "Claude Known",
							createdAt: "2025-01-01T00:00:00Z",
						},
					],
					source: "upstream",
					fetchedAt: 100,
				}),
			},
			codexCatalog: {
				get: async (id) => {
					const pin = id ? await dbOps.getApiKeyPin(id) : null;
					return pin?.pinnedAccountId === "d" ? null : currentRaw;
				},
				getFetchedAt: () => 100,
			},
			staticModelIds: ["gpt-static"],
			listOverrides: (d) => dbOps.listModelOverrides(d),
			upsertOverride: (i) => dbOps.upsertModelOverride(i),
			removeOverride: (d, id) => dbOps.removeModelOverride(d, id),
		});
		service = new ClientService({
			dbOps,
			permissions,
			codexCatalog: codex,
			modelCatalog: catalog,
		});
	});
	afterEach(async () => {
		permissions.stop();
		await dbOps.dispose();
		temp.cleanup();
	});
	async function create(draft = blank()) {
		return service.commit((await service.review(draft)).token);
	}
	it("keeps a missing catalogue manageable and repairs it only after review", async () => {
		const { client, apiKey } = await create();
		const sql = dbOps.getAdapter().getSQLiteDb();
		sql
			.query("DELETE FROM client_profiles WHERE api_key_id=?")
			.run(client.apiKeyId);
		const views = await service.list();
		const missing = views.find((c) => c.apiKeyId === client.apiKeyId)!;
		expect(missing.revision).toBe(0);
		expect(missing.notices.join(" ")).toContain("missing");
		expect(await dbOps.clients.getProfile(client.apiKeyId)).toBeNull();
		await expect(service.wire(client.apiKeyId, "openai")).rejects.toThrow();
		const other = blank();
		other.name = "Unaffected";
		expect((await create(other)).client.key.name).toBe("Unaffected");
		const draft = edit(missing);
		draft.catalogues.openai.models = [
			{
				id: "chosen",
				targetModel: "chosen",
				displayName: "Chosen",
				accountIds: null,
			},
		];
		const reviewed = await service.review(draft);
		const stale = await service.review(draft);
		const repaired = await service.commit(reviewed.token);
		expect(repaired.apiKey).toBeUndefined();
		expect(repaired.client.apiKeyId).toBe(client.apiKeyId);
		expect(repaired.client.key.prefixLast8).toBe(apiKey?.slice(-8));
		expect(repaired.client.revision).toBe(1);
		expect(
			(await (await service.wire(client.apiKeyId, "openai")).json()).data.map(
				(m: { id: string }) => m.id,
			),
		).toEqual(["chosen"]);
		await expect(service.commit(stale.token)).rejects.toThrow("Client changed");
	});
	it("uses one account snapshot when reviewing and serving multiple Codex entries", async () => {
		const entry = JSON.parse(currentRaw?.bodyText).models[0];
		currentRaw = {
			bodyText: JSON.stringify({
				models: Array.from({ length: 20 }, (_, i) => ({
					...entry,
					slug: `gpt-${i}`,
				})),
			}),
			etag: "test",
		};
		const draft = blank();
		draft.catalogues.codex.models = Array.from({ length: 20 }, (_, i) => ({
			id: `gpt-${i}`,
			targetModel: `gpt-${i}`,
			displayName: `GPT ${i}`,
			accountIds: null,
		}));
		const original = dbOps.getAllAccounts.bind(dbOps);
		const read = spyOn(dbOps, "getAllAccounts").mockImplementation(original);
		try {
			const { client } = await create(draft);
			expect(read).toHaveBeenCalledTimes(1);
			read.mockClear();
			const response = await service.wire(client.apiKeyId, "codex");
			expect((await response.json()).models).toHaveLength(20);
			expect(read).toHaveBeenCalledTimes(1);
		} finally {
			read.mockRestore();
		}
	});
	it("migrates actual scoped formats once and initializes compatibility-created keys atomically", async () => {
		await dbOps.createApiKey({
			id: "legacy",
			name: "Legacy",
			hashedKey: "legacy-hash",
			prefixLast8: "abcdefgh",
			createdAt: 10,
			isActive: false,
			pinnedAccountId: "d",
		});
		await dbOps.upsertModelOverride({
			dialect: "openai",
			modelId: "custom",
			hidden: false,
			custom: true,
			displayName: "Custom",
			now: 123,
		});
		await service.bootstrap();
		const before = await dbOps.getApiKey("legacy");
		expect(
			(await service.wire("legacy", "anthropic").then((r) => r.json())).data[0]
				.id,
		).toBe("claude-known");
		expect(
			(await service.wire("legacy", "codex").then((r) => r.json())).data.map(
				(m: { id: string }) => m.id,
			),
		).toEqual(["gpt-static", "custom"]);
		await dbOps.upsertModelOverride({
			dialect: "openai",
			modelId: "gpt-static",
			hidden: true,
			custom: false,
			displayName: null,
			now: 124,
		});
		await service.bootstrap();
		expect(await dbOps.getApiKey("legacy")).toEqual(before);
		expect(
			(await service.wire("legacy", "openai").then((r) => r.json())).data,
		).toHaveLength(2);
		await dbOps.createApiKey({
			id: "new",
			name: "Compatibility",
			hashedKey: "new-hash",
			prefixLast8: "newnew12",
			createdAt: 20,
			isActive: true,
		});
		expect(await dbOps.clients.getProfile("new")).not.toBeNull();
	});
	it("creates aliases only on commit, gives reviewed precedence, and hiding retains routing", async () => {
		await service.bootstrap();
		await dbOps.routing.saveRule(broad);
		const draft = blank();
		draft.application = "claude-code";
		draft.destinations = { accountId: "d", providers: null };
		draft.catalogues.anthropic.models = [
			{
				id: "claude-devin-swe",
				displayName: "Devin SWE",
				targetModel: "swe-2-high",
				accountIds: ["d"],
			},
		];
		const review = await service.review(draft);
		expect(review.precedingRules).toEqual(["Broad existing rule"]);
		expect(await dbOps.getApiKeys()).toHaveLength(0);
		const result = await service.commit(review.token);
		expect(result.apiKey).toBeTruthy();
		expect(
			matchRoutingRule(
				await dbOps.routing.listRules(),
				result.client.apiKeyId,
				"claude-devin-swe",
			)?.target_model,
		).toBe("swe-2-high");
		const changed = edit(result.client);
		changed.catalogues.anthropic.models = [];
		await create(changed);
		expect(
			(
				await service
					.wire(result.client.apiKeyId, "anthropic")
					.then((r) => r.json())
			).data,
		).toEqual([]);
		expect(
			matchRoutingRule(
				await dbOps.routing.listRules(),
				result.client.apiKeyId,
				"claude-devin-swe",
			)?.target_model,
		).toBe("swe-2-high");
		await service.remove(result.client.apiKeyId);
		expect((await dbOps.routing.listRules()).map((r) => r.id)).toEqual([
			"broad",
		]);
	});
	it("rejects a stale routing review without creating any key", async () => {
		await service.bootstrap();
		const review = await service.review(blank());
		await dbOps.routing.saveRule(broad);
		await expect(service.commit(review.token)).rejects.toThrow("changed");
		expect(await dbOps.getApiKeys()).toHaveLength(0);
	});
	it("rolls back key, profile and rules when the transaction fails", async () => {
		await service.bootstrap();
		const review = await service.review(blank());
		dbOps
			.getAdapter()
			.getSQLiteDb()
			.exec(
				"CREATE TRIGGER fail_client BEFORE INSERT ON client_profiles BEGIN SELECT RAISE(ABORT,'test-failure'); END",
			);
		await expect(service.commit(review.token)).rejects.toThrow("test-failure");
		expect(await dbOps.getApiKeys()).toHaveLength(0);
		expect(await dbOps.routing.listRules()).toEqual([]);
	});
	it("refuses browser-supplied Codex metadata for an unknown target", async () => {
		await service.bootstrap();
		const draft = blank();
		draft.catalogues.codex.models = [
			{
				id: "fake",
				displayName: "Fake",
				targetModel: "fake",
				accountIds: null,
				codexMetadata: { slug: "fake", base_instructions: "forged" },
			},
		];
		await expect(service.review(draft)).rejects.toThrow("Known Codex metadata");
	});
	it("refreshes capabilities without publishing newly discovered IDs and scopes metadata by destination", async () => {
		await service.bootstrap();
		const draft = blank();
		draft.catalogues.codex.models = [
			{
				id: "gpt-real",
				displayName: "Real",
				targetModel: "gpt-real",
				accountIds: null,
			},
		];
		const { client } = await create(draft);
		currentRaw = raw("gpt-real", 128000);
		expect(
			(await service.wire(client.apiKeyId, "codex").then((r) => r.json()))
				.models[0].context_window,
		).toBe(128000);
		currentRaw = raw("gpt-new", 256000);
		expect(
			(
				await service.wire(client.apiKeyId, "codex").then((r) => r.json())
			).models.map((m: { slug: string }) => m.slug),
		).toEqual(["gpt-real"]);
		await dbOps.updateApiKeyPin(client.apiKeyId, "d", null);
		expect(
			(
				await service.wire(client.apiKeyId, "codex").then((r) => r.json())
			).data.map((m: { id: string }) => m.id),
		).toEqual(["gpt-real"]);
	});
	it("returns rich suggestions with provenance even before permission discovery, without publishing them", async () => {
		await service.bootstrap();
		const result = await create();
		const suggestions = await service.suggestions({
			accountId: "c",
			providers: null,
		});
		expect(suggestions.models).toContainEqual({
			id: "gpt-real",
			displayName: "gpt-real",
			accountIds: ["c"],
			codexMetadataAvailable: true,
		});
		expect(suggestions.accounts[0]?.completeness).toBe("unknown");
		expect(
			(await dbOps.clients.getProfile(result.client.apiKeyId))?.catalogues.codex
				.models,
		).toEqual([]);
	});
	it("keeps successful permissions when discovery has failed", async () => {
		const account = await dbOps.getAccount("d");
		if (!account) throw new Error("fixture");
		const scope = modelPermissionScope(account);
		await dbOps.routing.ensurePermissionScope("d", scope);
		await dbOps.routing.completeDiscovery("d", scope, 1, ["swe-2-high"], 100);
		await dbOps.routing.failDiscovery("d", scope, 1, "Unavailable", 101);
		const result = await service.suggestions({
			accountId: "d",
			providers: null,
		});
		expect(result.models[0]?.id).toBe("swe-2-high");
		expect(result.accounts[0]?.error).toBe("Unavailable");
	});
	it("falls back during migration on malformed upstream metadata, preserving generic selections", async () => {
		await dbOps.createApiKey({
			id: "legacy",
			name: "Legacy",
			hashedKey: "hash",
			prefixLast8: "abcdefgh",
			createdAt: 10,
			isActive: true,
		});
		currentRaw = { bodyText: "bad-json", etag: null as unknown as string };
		await service.bootstrap();
		expect(
			(await service.wire("legacy", "codex").then((r) => r.json())).data[0].id,
		).toBe("gpt-static");
		expect(
			(await dbOps.clients.getProfile("legacy"))?.notices.length,
		).toBeGreaterThan(0);
	});
});
