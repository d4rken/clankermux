import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "@clankermux/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __pricingTestHooks, matchRoutingRule } from "@clankermux/core";
import { DatabaseOperations } from "@clankermux/database";
import { HttpError } from "@clankermux/errors";
import {
	AccountModelPermissionService,
	type CodexModelCatalogCache,
	modelPermissionScope,
} from "@clankermux/proxy";
import { tempDbTracker } from "@clankermux/test-support";
import type {
	ClientDraft,
	ClientModel,
	ClientView,
	RoutingRule,
} from "@clankermux/types";
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
	it("publishes reusable aliases in every dialect without requiring account pins", async () => {
		await dbOps.modelAliases.save({
			id: "alias:good",
			displayName: "Good",
			revision: 0,
			targets: [
				{ model: "gpt-real", accountIds: ["c"] },
				{ model: "other", accountIds: ["d"] },
			],
		});
		const draft = blank();
		for (const format of ["openai", "anthropic", "codex"] as const)
			draft.catalogues[format].models = [
				{
					id: "good",
					displayName: "Good",
					targetModel: "alias:good",
					accountIds: null,
				},
			];
		const review = await service.review(draft);
		expect(review.aliasRules).toHaveLength(1);
		expect(review.aliasRules[0]).toMatchObject({
			target_model: "alias:good",
			pool_kind: "inherit",
		});
		const { client } = await service.commit(review.token);
		const discovery = await (
			await service.wire(client.apiKeyId, "codex")
		).json();
		expect(discovery.models[0]).toMatchObject({
			slug: "good",
			supports_reasoning_summaries: false,
			supported_reasoning_levels: [],
		});
		expect(discovery.models[0].base_instructions).not.toContain("gpt-real");
		expect(discovery.models[0].context_window).toBeUndefined();
		expect(
			(await service.suggestions(draft.destinations)).models,
		).toContainEqual({
			id: "alias:good",
			displayName: "Good",
			accountIds: ["c", "d"],
			codexMetadataAvailable: true,
		});
	});
	it("rejects missing reusable aliases and invalidates review after alias edits", async () => {
		const draft = blank();
		draft.catalogues.openai.models = [
			{
				id: "good",
				displayName: "Good",
				targetModel: "alias:good",
				accountIds: null,
			},
		];
		await expect(service.review(draft)).rejects.toThrow("Alias alias:good");
		await dbOps.modelAliases.save({
			id: "alias:good",
			displayName: "Good",
			revision: 0,
			targets: [{ model: "gpt-real", accountIds: null }],
		});
		const review = await service.review(draft);
		const alias = await dbOps.modelAliases.get("alias:good");
		if (!alias) throw new Error("Missing alias fixture");
		await dbOps.modelAliases.save({ ...alias, displayName: "Changed" });
		await expect(service.commit(review.token)).rejects.toThrow();
	});
	/**
	 * A `model_overrides` row as a pre-2026.9.52 database already holds one.
	 *
	 * Raw SQL because the table is read-only now: there is no repository write
	 * left to build the fixture with, and the backfill has to keep working
	 * against rows that were written before the writer was removed.
	 */
	function writeLegacyOverride(row: {
		dialect: "anthropic" | "openai";
		modelId: string;
		hidden?: 0 | 1;
		custom?: 0 | 1;
		displayName?: string | null;
		now: number;
	}): void {
		dbOps
			.getAdapter()
			.getSQLiteDb()
			.query(
				`INSERT INTO model_overrides
				   (dialect, model_id, hidden, custom, display_name, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				row.dialect,
				row.modelId,
				row.hidden ?? 0,
				row.custom ?? 0,
				row.displayName ?? null,
				row.now,
				row.now,
			);
	}
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
			},
			staticModelIds: ["gpt-static"],
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
	it("saves setup credentials atomically and excludes them from client views", async () => {
		const { client, apiKey } = await create();
		// biome-ignore lint/style/noNonNullAssertion: create() commits a draft with no id, so commit() returned the generated plaintext key
		expect(await dbOps.getApiKeySetupSecret(client.apiKeyId)).toBe(apiKey!);
		// biome-ignore lint/style/noNonNullAssertion: the same create() key asserted on the line above
		expect(JSON.stringify(await service.list())).not.toContain(apiKey!);
		const changed = edit(client);
		changed.name = "Renamed";
		await service.commit((await service.review(changed)).token);
		// biome-ignore lint/style/noNonNullAssertion: the same create() key asserted above
		expect(await dbOps.getApiKeySetupSecret(client.apiKeyId)).toBe(apiKey!);
	});

	it("keeps a missing catalogue manageable and repairs it only after review", async () => {
		const { client, apiKey } = await create();
		if (!apiKey) throw new Error("expected create() to return a plaintext key");
		const sql = dbOps.getAdapter().getSQLiteDb();
		sql
			.query("DELETE FROM client_profiles WHERE api_key_id=?")
			.run(client.apiKeyId);
		const views = await service.list();
		// biome-ignore lint/style/noNonNullAssertion: only the client_profiles row was deleted above, so list() still reports this api_keys row
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
		expect(repaired.client.key.prefixLast8).toBe(apiKey.slice(-8));
		expect(repaired.client.revision).toBe(1);
		expect(
			(await (await service.wire(client.apiKeyId, "openai")).json()).data.map(
				(m: { id: string }) => m.id,
			),
		).toEqual(["chosen"]);
		await expect(service.commit(stale.token)).rejects.toThrow("Client changed");
	});
	it("uses one account snapshot when reviewing and serving multiple Codex entries", async () => {
		if (!currentRaw) throw new Error("expected a seeded catalogue payload");
		const entry = JSON.parse(currentRaw.bodyText).models[0];
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
		// The table has no writer left; a legacy row is what an upgrading database
		// arrives holding, so the fixture writes one the way that database does.
		writeLegacyOverride({
			dialect: "openai",
			modelId: "custom",
			custom: 1,
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
		writeLegacyOverride({
			dialect: "openai",
			modelId: "gpt-static",
			hidden: 1,
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

	// --- bulk catalogue edits -------------------------------------------------

	/** A committed client under `name`, optionally with a shaped draft. */
	async function makeClient(
		name: string,
		shape?: (draft: ClientDraft) => void,
	): Promise<ClientView> {
		const draft = blank();
		draft.name = name;
		shape?.(draft);
		return (await create(draft)).client;
	}
	const plain = (id: string): ClientModel => ({
		id,
		displayName: id,
		targetModel: id,
		accountIds: null,
	});
	const alias = (id: string, target = "gpt-static"): ClientModel => ({
		id,
		displayName: id,
		targetModel: target,
		accountIds: ["c"],
	});
	const bulkStatus = async (input: unknown): Promise<number> => {
		try {
			await service.bulkReview(input);
		} catch (error) {
			return error instanceof HttpError ? error.status : -1;
		}
		return 0;
	};
	const rules = () =>
		dbOps
			.getAdapter()
			.getSQLiteDb()
			.query("SELECT id,name,position FROM routing_rules ORDER BY position")
			.all() as { id: string; name: string; position: number }[];
	const aliasOwners = () =>
		dbOps
			.getAdapter()
			.getSQLiteDb()
			.query(
				"SELECT api_key_id,rule_id FROM client_alias_rules ORDER BY rule_id",
			)
			.all() as { api_key_id: string; rule_id: string }[];

	it("adds one entry to the selected clients and leaves the rest untouched", async () => {
		await service.bootstrap();
		const a = await makeClient("Alpha");
		const b = await makeClient("Bravo");
		const c = await makeClient("Charlie");
		const review = await service.bulkReview({
			clientIds: [a.apiKeyId, b.apiKeyId],
			operation: { format: "openai", mode: "add", models: [plain("shared")] },
		});
		expect(review.clients.map((r) => r.apiKeyId)).toEqual([
			a.apiKeyId,
			b.apiKeyId,
		]);
		expect(review.clients.map((r) => r.status)).toEqual(["changed", "changed"]);
		expect(review.clients[0]?.added).toEqual(["shared"]);
		expect(review.clients[0]?.removed).toEqual([]);
		expect(review.clients[0]?.modified).toEqual([]);
		expect(review.clients[0]?.notices.length).toBeGreaterThan(0);
		const committed = await service.bulkCommit(review.token);
		expect(committed.clients.map((v) => v.apiKeyId)).toEqual([
			a.apiKeyId,
			b.apiKeyId,
		]);
		for (const id of [a.apiKeyId, b.apiKeyId]) {
			const profile = await dbOps.clients.getProfile(id);
			expect(profile?.catalogues.openai.models.map((m) => m.id)).toEqual([
				"shared",
			]);
			expect(profile?.revision).toBe(2);
		}
		const untouched = await dbOps.clients.getProfile(c.apiKeyId);
		expect(untouched?.catalogues.openai.models).toEqual([]);
		expect(untouched?.revision).toBe(1);
	});

	it("reports a client that already publishes the added ID as unchanged", async () => {
		await service.bootstrap();
		const a = await makeClient("Alpha", (d) => {
			d.catalogues.openai.models = [plain("shared")];
		});
		const b = await makeClient("Bravo");
		const review = await service.bulkReview({
			clientIds: [a.apiKeyId, b.apiKeyId],
			operation: {
				format: "openai",
				mode: "add",
				models: [
					{
						id: "shared",
						displayName: "Rewritten",
						targetModel: "somewhere-else",
						accountIds: ["c"],
					},
				],
			},
		});
		expect(review.clients.map((r) => r.status)).toEqual([
			"unchanged",
			"changed",
		]);
		expect(review.clients[0]?.added).toEqual([]);
		expect(review.clients[0]?.modified).toEqual([]);
		await service.bulkCommit(review.token);
		// An add never overwrites an entry the operator already tuned by hand.
		expect(
			(await dbOps.clients.getProfile(a.apiKeyId))?.catalogues.openai.models,
		).toEqual([plain("shared")]);
		expect((await dbOps.clients.getProfile(a.apiKeyId))?.revision).toBe(1);
	});

	it("clears a default model that the removal took away, and says so", async () => {
		await service.bootstrap();
		const a = await makeClient("Alpha", (d) => {
			d.catalogues.openai.models = [plain("keep"), plain("drop")];
			d.catalogues.openai.defaultModel = "drop";
		});
		const review = await service.bulkReview({
			clientIds: [a.apiKeyId],
			operation: {
				format: "openai",
				mode: "remove",
				models: [{ id: "drop" }],
			},
		});
		const result = review.clients[0];
		expect(result?.status).toBe("changed");
		expect(result?.removed).toEqual(["drop"]);
		expect(result?.added).toEqual([]);
		expect(result?.defaultModelChange).toEqual({ from: "drop", to: null });
		expect(result?.notices).toContain(
			"Default model cleared: drop is no longer in this catalogue.",
		);
		await service.bulkCommit(review.token);
		const catalogue = (await dbOps.clients.getProfile(a.apiKeyId))?.catalogues
			.openai;
		expect(catalogue?.models.map((m) => m.id)).toEqual(["keep"]);
		expect(catalogue?.defaultModel).toBeNull();
	});

	it("replaces one format wholesale and leaves the other two alone", async () => {
		await service.bootstrap();
		const a = await makeClient("Alpha", (d) => {
			d.catalogues.anthropic.models = [plain("claude-known")];
			d.catalogues.openai.models = [plain("old-one"), plain("old-two")];
		});
		const review = await service.bulkReview({
			clientIds: [a.apiKeyId],
			operation: {
				format: "openai",
				mode: "replace",
				models: [plain("fresh")],
				defaultModel: "fresh",
			},
		});
		expect(review.clients[0]?.added).toEqual(["fresh"]);
		expect(review.clients[0]?.removed).toEqual(["old-one", "old-two"]);
		expect(review.clients[0]?.defaultModelChange).toEqual({
			from: null,
			to: "fresh",
		});
		await service.bulkCommit(review.token);
		const catalogues = (await dbOps.clients.getProfile(a.apiKeyId))?.catalogues;
		expect(catalogues?.openai.models.map((m) => m.id)).toEqual(["fresh"]);
		expect(catalogues?.openai.defaultModel).toBe("fresh");
		expect(catalogues?.anthropic.models.map((m) => m.id)).toEqual([
			"claude-known",
		]);
		expect(catalogues?.codex.models).toEqual([]);
	});

	it("reports a repointed ID as modified rather than as no change at all", async () => {
		await service.bootstrap();
		const a = await makeClient("Alpha", (d) => {
			d.catalogues.openai.models = [alias("fast", "target-a")];
		});
		const review = await service.bulkReview({
			clientIds: [a.apiKeyId],
			operation: {
				format: "openai",
				mode: "replace",
				models: [alias("fast", "target-b")],
			},
		});
		const result = review.clients[0];
		expect(result?.status).toBe("changed");
		expect(result?.modified).toEqual(["fast"]);
		expect(result?.added).toEqual([]);
		expect(result?.removed).toEqual([]);
		await service.bulkCommit(review.token);
		expect(
			(await dbOps.clients.getProfile(a.apiKeyId))?.catalogues.openai.models[0]
				?.targetModel,
		).toBe("target-b");
	});

	it("skips a client whose own routing conflicts with its destinations and commits the rest", async () => {
		await service.bootstrap();
		const pinned = await makeClient("Pinned", (d) => {
			d.destinations = { accountId: "d", providers: null };
		});
		const open = await makeClient("Open");
		// A manual rule pooling an account the key's pin excludes. This is the
		// ordinary-conflict case: `assertPinCompatible` throws a plain Error, so a
		// catch filtering on typed errors alone would abort the whole batch.
		dbOps
			.getAdapter()
			.getSQLiteDb()
			.query(
				`INSERT INTO routing_rules
				   (id,name,enabled,position,match_api_key_id,match_model_kind,match_model_value,
				    pool_kind,pool_provider,pool_account_ids,target_kind,target_model)
				 VALUES ('manual','Manual pin',1,0,?,'any',NULL,'accounts',NULL,'["c"]','requested',NULL)`,
			)
			.run(pinned.apiKeyId);
		const before = await dbOps.clients.getProfile(pinned.apiKeyId);
		const review = await service.bulkReview({
			clientIds: [pinned.apiKeyId, open.apiKeyId],
			operation: { format: "openai", mode: "add", models: [plain("shared")] },
		});
		expect(review.clients[0]?.status).toBe("rejected");
		expect(review.clients[0]?.reason).toContain(
			"conflicts with API key destinations",
		);
		expect(review.clients[1]?.status).toBe("changed");
		const committed = await service.bulkCommit(review.token);
		expect(committed.clients.map((v) => v.apiKeyId)).toEqual([open.apiKeyId]);
		// biome-ignore lint/style/noNonNullAssertion: makeClient wrote Pinned's profile, so the read above returned one
		expect(await dbOps.clients.getProfile(pinned.apiKeyId)).toEqual(before!);
		expect(
			(
				await dbOps.clients.getProfile(open.apiKeyId)
			)?.catalogues.openai.models.map((m) => m.id),
		).toEqual(["shared"]);
	});

	it("rejects an incompatible Anthropic ID for Claude Code while a generic client takes it", async () => {
		await service.bootstrap();
		const cc = await makeClient("Claude Code", (d) => {
			d.application = "claude-code";
		});
		const generic = await makeClient("Generic");
		const review = await service.bulkReview({
			clientIds: [cc.apiKeyId, generic.apiKeyId],
			operation: {
				format: "anthropic",
				mode: "add",
				models: [plain("gpt-fast")],
			},
		});
		expect(review.clients[0]?.status).toBe("rejected");
		expect(review.clients[0]?.reason).toBe(
			"Claude Code requires a compatible alias for gpt-fast",
		);
		expect(review.clients[1]?.status).toBe("changed");
		await service.bulkCommit(review.token);
		expect(
			(await dbOps.clients.getProfile(cc.apiKeyId))?.catalogues.anthropic
				.models,
		).toEqual([]);
		expect(
			(
				await dbOps.clients.getProfile(generic.apiKeyId)
			)?.catalogues.anthropic.models.map((m) => m.id),
		).toEqual(["gpt-fast"]);
	});

	it("refuses an over-long generated rule name at review, for one client or many", async () => {
		await service.bootstrap();
		const longId = "a".repeat(200);
		const short = await makeClient("Short");
		const long = await makeClient("N".repeat(100));
		const draft = edit(long);
		draft.catalogues.openai.models = [alias(longId)];
		// Without a review-time check this only fails inside the commit
		// transaction, after a batch has already applied other clients' work.
		await expect(service.review(draft)).rejects.toThrow("Invalid rule name");
		expect(rules()).toEqual([]);
		const review = await service.bulkReview({
			clientIds: [short.apiKeyId, long.apiKeyId],
			operation: { format: "openai", mode: "add", models: [alias(longId)] },
		});
		expect(review.clients[0]?.status).toBe("changed");
		expect(review.clients[1]?.status).toBe("rejected");
		expect(review.clients[1]?.reason).toBe("Invalid rule name");
		await service.bulkCommit(review.token);
		expect(rules().map((r) => r.name)).toEqual([`Short: ${longId}`]);
	});

	it("rejects malformed bulk requests before touching any client", async () => {
		const a = await makeClient("Alpha");
		const operation = (models: unknown) => ({
			clientIds: [a.apiKeyId],
			operation: { format: "openai", mode: "add", models },
		});
		expect(await bulkStatus(operation([null]))).toBe(400);
		expect(
			await bulkStatus(
				operation([
					{ displayName: "No ID", targetModel: "x", accountIds: null },
				]),
			),
		).toBe(400);
		expect(await bulkStatus(operation([plain("dup"), plain("dup")]))).toBe(400);
		expect(await bulkStatus(operation("not-an-array"))).toBe(400);
		expect(
			await bulkStatus({
				clientIds: [],
				operation: { format: "openai", mode: "add", models: [] },
			}),
		).toBe(400);
		expect(
			await bulkStatus({
				clientIds: [a.apiKeyId, a.apiKeyId],
				operation: { format: "openai", mode: "add", models: [] },
			}),
		).toBe(400);
		expect(
			await bulkStatus({
				clientIds: [a.apiKeyId],
				operation: { format: "sideways", mode: "add", models: [] },
			}),
		).toBe(400);
		expect(
			await bulkStatus({
				clientIds: [a.apiKeyId],
				operation: { format: "openai", mode: "merge", models: [] },
			}),
		).toBe(400);
	});

	it("accepts a plain remove of many entries across many clients", async () => {
		await service.bootstrap();
		const ids = Array.from({ length: 51 }, (_, i) => `drop-${i}`);
		const clients: ClientView[] = [];
		for (let i = 0; i < 10; i++)
			clients.push(
				await makeClient(`Bulk ${i}`, (d) => {
					d.catalogues.openai.models = ids.map(plain);
				}),
			);
		// The remove contract reads only `id`, so no entry carries a target model
		// and no alias is involved anywhere in this batch.
		const review = await service.bulkReview({
			clientIds: clients.map((c) => c.apiKeyId),
			operation: {
				format: "openai",
				mode: "remove",
				models: ids.map((id) => ({ id })),
			},
		});
		expect(review.clients.map((r) => r.status)).toEqual(
			Array(clients.length).fill("changed"),
		);
		await service.bulkCommit(review.token);
		for (const client of clients)
			expect(
				(await dbOps.clients.getProfile(client.apiKeyId))?.catalogues.openai
					.models,
			).toEqual([]);
	}, 60000);

	it("counts the alias rules a batch retains against the routing-rewrite bound", async () => {
		await service.bootstrap();
		const ids = Array.from({ length: 51 }, (_, i) => `alias-${i}`);
		const clients: ClientView[] = [];
		for (let i = 0; i < 10; i++)
			clients.push(
				await makeClient(`Bulk ${i}`, (d) => {
					d.catalogues.openai.models = ids.map((id) => alias(id));
				}),
			);
		expect(rules().length).toBe(510);
		// Every entry has id === targetModel, so the request declares no aliases.
		// Hiding the entries keeps all 510 owned rules alive as retained alias
		// rules, so each client still renumbers the whole table twice.
		await expect(
			service.bulkReview({
				clientIds: clients.map((c) => c.apiKeyId),
				operation: {
					format: "openai",
					mode: "remove",
					models: ids.map((id) => ({
						id,
						targetModel: id,
						displayName: id,
						accountIds: null,
					})),
				},
			}),
		).rejects.toThrow("too many routing rules");
	}, 60000);

	it("rejects the client whose entry carries a non-array account pin instead of failing the batch", async () => {
		await service.bootstrap();
		const a = await makeClient("Alpha", (d) => {
			d.catalogues.openai.models = [
				{
					id: "fast",
					displayName: "Fast",
					targetModel: "fast",
					accountIds: null,
				},
			];
		});
		const b = await makeClient("Bravo");
		// Alpha already publishes `fast` under the same display name and target,
		// so the modified-diff compares the pins of the two entries.
		const review = await service.bulkReview({
			clientIds: [a.apiKeyId, b.apiKeyId],
			operation: {
				format: "openai",
				mode: "replace",
				models: [
					{
						id: "fast",
						displayName: "Fast",
						targetModel: "fast",
						accountIds: {},
					},
				],
			},
		});
		expect(review.clients.map((r) => r.status)).toEqual([
			"rejected",
			"rejected",
		]);
		expect(review.clients[0]?.reason).toBe("Choose allowed accounts for fast");
		expect(review.clients[1]?.reason).toBe("Choose allowed accounts for fast");
	});

	it("reports no change when an Anthropic replacement differs only in stored createdAt", async () => {
		await service.bootstrap();
		const shape = (d: ClientDraft) => {
			d.catalogues.anthropic.models = [
				{
					id: "claude-alias",
					displayName: "Claude Alias",
					targetModel: "claude-known",
					accountIds: ["c"],
				},
			];
			d.catalogues.anthropic.defaultModel = "claude-alias";
		};
		const source = await makeClient("Source", shape);
		const dest = await makeClient("Dest", shape);
		const sql = dbOps.getAdapter().getSQLiteDb();
		// prepareDraft stamps createdAt per client from the wall clock, so force
		// the two apart rather than hoping the creates land in different
		// milliseconds.
		for (const [id, stamp] of [
			[source.apiKeyId, "2020-01-01T00:00:00.000Z"],
			[dest.apiKeyId, "2021-01-01T00:00:00.000Z"],
		] as const) {
			const row = sql
				.query("SELECT catalogues FROM client_profiles WHERE api_key_id=?")
				.get(id) as { catalogues: string };
			const parsed = JSON.parse(row.catalogues);
			parsed.anthropic.models[0].createdAt = stamp;
			sql
				.query("UPDATE client_profiles SET catalogues=? WHERE api_key_id=?")
				.run(JSON.stringify(parsed), id);
		}
		// biome-ignore lint/style/noNonNullAssertion: makeClient wrote Source's profile
		const sourceProfile = (await dbOps.clients.getProfile(source.apiKeyId))!;
		const from = sourceProfile.catalogues.anthropic;
		// biome-ignore lint/style/noNonNullAssertion: makeClient wrote Dest's profile
		const before = (await dbOps.clients.getProfile(dest.apiKeyId))!;
		// biome-ignore lint/style/noNonNullAssertion: Dest's catalogue publishes the claude-alias alias, so it owns a client_alias_rules row
		const ownedBefore = aliasOwners().find(
			(o) => o.api_key_id === dest.apiKeyId,
		)!;
		const review = await service.bulkReview({
			clientIds: [dest.apiKeyId],
			operation: {
				format: "anthropic",
				mode: "replace",
				models: structuredClone(from.models),
				defaultModel: from.defaultModel,
			},
		});
		// Both catalogues publish the same ID, target, display name and pin, and
		// preparation restamps createdAt from Dest's own entry regardless.
		expect(review.clients[0]?.status).toBe("unchanged");
		await service.bulkCommit(review.token);
		// biome-ignore lint/style/noNonNullAssertion: makeClient wrote Dest's profile and bulkCommit never deletes one
		const after = (await dbOps.clients.getProfile(dest.apiKeyId))!;
		expect(after.revision).toBe(before.revision);
		expect(after.catalogues).toEqual(before.catalogues);
		expect(aliasOwners().find((o) => o.api_key_id === dest.apiKeyId)).toEqual(
			ownedBefore,
		);
	});

	it("rolls the whole batch back when a later client's revision moved underneath it", async () => {
		await service.bootstrap();
		await dbOps.routing.saveRule(broad);
		const a = await makeClient("Alpha");
		const b = await makeClient("Bravo");
		const review = await service.bulkReview({
			clientIds: [a.apiKeyId, b.apiKeyId],
			operation: { format: "openai", mode: "add", models: [alias("shared")] },
		});
		expect(review.clients.map((r) => r.status)).toEqual(["changed", "changed"]);
		const before = {
			a: await dbOps.clients.getProfile(a.apiKeyId),
			b: await dbOps.clients.getProfile(b.apiKeyId),
		};
		const rulesBefore = rules();
		// The batch applies in apiKeyId order, so bumping the last one's revision
		// fails the CAS only after the earlier client has already been written.
		// biome-ignore lint/style/noNonNullAssertion: a two-element array always has a last element
		const last = [a.apiKeyId, b.apiKeyId].sort().at(-1)!;
		const first = last === a.apiKeyId ? b.apiKeyId : a.apiKeyId;
		dbOps
			.getAdapter()
			.getSQLiteDb()
			.query(
				"UPDATE client_profiles SET revision=revision+1 WHERE api_key_id=?",
			)
			.run(last);
		await expect(service.bulkCommit(review.token)).rejects.toThrow(
			"Client changed",
		);
		const after = await dbOps.clients.getProfile(first);
		expect(after).toEqual(
			(first === a.apiKeyId ? before.a : before.b) as NonNullable<typeof after>,
		);
		expect(rules()).toEqual(rulesBefore);
		expect(aliasOwners()).toEqual([]);
	});

	it("refuses a bulk commit whose routing moved after the review", async () => {
		await service.bootstrap();
		const a = await makeClient("Alpha");
		const review = await service.bulkReview({
			clientIds: [a.apiKeyId],
			operation: { format: "openai", mode: "add", models: [plain("shared")] },
		});
		await dbOps.routing.saveRule(broad);
		await expect(service.bulkCommit(review.token)).rejects.toThrow("changed");
		expect(
			(await dbOps.clients.getProfile(a.apiKeyId))?.catalogues.openai.models,
		).toEqual([]);
	});

	it("refuses an expired token and a token fed to the wrong commit", async () => {
		await service.bootstrap();
		const a = await makeClient("Alpha");
		const expired = await service.bulkReview({
			clientIds: [a.apiKeyId],
			operation: { format: "openai", mode: "add", models: [plain("shared")] },
		});
		const pending = (
			service as unknown as { pending: Map<string, { expires: number }> }
		).pending;
		// biome-ignore lint/style/noNonNullAssertion: bulkReview registered this token in pending on the line above
		pending.get(expired.token)!.expires = Date.now() - 1;
		await expect(service.bulkCommit(expired.token)).rejects.toThrow(
			"Review expired",
		);

		const bulk = await service.bulkReview({
			clientIds: [a.apiKeyId],
			operation: { format: "openai", mode: "add", models: [plain("shared")] },
		});
		await expect(service.commit(bulk.token)).rejects.toThrow("Review expired");
		const single = await service.review(edit(a));
		await expect(service.bulkCommit(single.token)).rejects.toThrow(
			"Review expired",
		);
	});

	it("gives every client its own alias rule, all ahead of the pre-existing rule", async () => {
		await service.bootstrap();
		await dbOps.routing.saveRule(broad);
		const a = await makeClient("Alpha");
		const b = await makeClient("Bravo");
		const review = await service.bulkReview({
			clientIds: [a.apiKeyId, b.apiKeyId],
			operation: { format: "openai", mode: "add", models: [alias("shared")] },
		});
		await service.bulkCommit(review.token);
		const owners = aliasOwners();
		expect(owners.map((o) => o.api_key_id).sort()).toEqual(
			[a.apiKeyId, b.apiKeyId].sort(),
		);
		const table = rules();
		const positionOf = (id: string) => {
			const row = table.find((r) => r.id === id);
			if (!row) throw new Error(`No routing rule ${id}`);
			return row.position;
		};
		const broadPosition = positionOf("broad");
		for (const owner of owners)
			expect(positionOf(owner.rule_id)).toBeLessThan(broadPosition);
		for (const id of [a.apiKeyId, b.apiKeyId])
			expect(
				matchRoutingRule(await dbOps.routing.listRules(), id, "shared")
					?.target_model,
			).toBe("gpt-static");
	});

	// --- published model metadata ---------------------------------------------

	describe("published model metadata", () => {
		const originalCacheHome = process.env.XDG_CACHE_HOME;
		const originalFetch = globalThis.fetch;
		let cacheDir: string;
		/**
		 * Two providers publishing the same slug at different figures, so a test
		 * can tell "both routes counted" from "only the eligible one did".
		 */
		const catalogue = {
			openai: {
				models: {
					"gpt-6-astra": {
						id: "gpt-6-astra",
						name: "Astra",
						limit: { context: 400_000, output: 128_000 },
						reasoning: true,
						modalities: { input: ["text", "image"] },
						cost: { input: 10, output: 50 },
					},
					// One id the bundled seed has never heard of, which is what marks
					// the merged table a real catalogue rather than the fallback.
					"gpt-9-unlisted": {
						id: "gpt-9-unlisted",
						name: "Unlisted",
						cost: { input: 1, output: 2 },
					},
				},
			},
			"openai-compatible": {
				models: {
					"fast-backup": {
						id: "fast-backup",
						name: "Fast backup",
						limit: { context: 100_000, output: 32_000 },
						reasoning: false,
						modalities: { input: ["text"] },
						cost: { input: 1, output: 2 },
					},
					"gpt-6-astra": {
						id: "gpt-6-astra",
						name: "Astra via compatible provider",
						limit: { context: 200_000, output: 64_000 },
						reasoning: false,
						modalities: { input: ["text"] },
						cost: { input: 9, output: 49 },
					},
				},
			},
		};
		/** Give an account a completed discovery listing exactly `ids`. */
		async function discovered(accountId: string, ids: string[]): Promise<void> {
			const account = await dbOps.getAccount(accountId);
			if (!account) throw new Error(`fixture account ${accountId}`);
			const scope = modelPermissionScope(account);
			const row = await dbOps.routing.ensurePermissionScope(accountId, scope);
			await dbOps.routing.completeDiscovery(
				accountId,
				scope,
				row.generation,
				ids,
				100,
			);
		}
		/** A client publishing `gpt-6-astra` under its own name. */
		async function astraClient(
			accountIds: string[] | null = null,
			destinations: ClientDraft["destinations"] = {
				accountId: null,
				providers: null,
			},
		): Promise<string> {
			const draft = blank();
			draft.destinations = destinations;
			draft.catalogues.openai.models = [
				{
					id: "gpt-6-astra",
					displayName: "Astra",
					targetModel: "gpt-6-astra",
					accountIds,
				},
			];
			return (await create(draft)).client.apiKeyId;
		}
		beforeEach(async () => {
			dbOps
				.getAdapter()
				.getSQLiteDb()
				.query("UPDATE accounts SET provider='openai-compatible' WHERE id='d'")
				.run();
			cacheDir = mkdtempSync(join(tmpdir(), "cmux-client-metadata-"));
			process.env.XDG_CACHE_HOME = cacheDir;
			__pricingTestHooks.reset();
			globalThis.fetch = (async () =>
				new Response(JSON.stringify(catalogue), {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as unknown as typeof fetch;
			await __pricingTestHooks.loadPricing();
		});
		afterEach(() => {
			globalThis.fetch = originalFetch;
			__pricingTestHooks.reset();
			if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
			else process.env.XDG_CACHE_HOME = originalCacheHome;
			rmSync(cacheDir, { recursive: true, force: true });
		});

		it("reduces limits and retention across fallback targets, pins, and live alias edits", async () => {
			await discovered("c", ["gpt-6-astra"]);
			await discovered("d", ["fast-backup"]);
			const alias = await dbOps.modelAliases.save({
				id: "alias:good",
				displayName: "Good",
				revision: 0,
				targets: [
					{ model: "gpt-6-astra", accountIds: ["c"] },
					{ model: "fast-backup", accountIds: ["d"] },
				],
			});
			const draft = blank();
			for (const format of ["openai", "codex"] as const)
				draft.catalogues[format].models = [
					{
						id: "good",
						displayName: "Good",
						targetModel: alias.id,
						accountIds: null,
					},
				];
			const id = (await create(draft)).client.apiKeyId;
			expect((await service.modelMetadata(id, "openai")).models.good).toEqual({
				contextWindow: 100_000,
				maxOutputTokens: 32_000,
				reasoning: false,
				inputModalities: ["text"],
				cacheRetention: expect.objectContaining({
					basis: "heuristic",
					retentionMs: 300_000,
					confidence: "low",
				}),
				cachePolicy: {
					mode: "unknown",
					expiry: "unavailable",
					source: "unknown",
				},
			});
			const before = await (await service.wire(id, "codex")).json();
			expect(before.models[0]).toMatchObject({
				slug: "good",
				context_window: 100_000,
				input_modalities: ["text"],
			});
			const pinnedDraft = structuredClone(draft);
			pinnedDraft.name = "Pinned alias";
			pinnedDraft.destinations.accountId = "c";
			const pinnedId = (await create(pinnedDraft)).client.apiKeyId;
			expect(
				(await service.modelMetadata(pinnedId, "openai")).models.good
					?.contextWindow,
			).toBe(872_000);
			expect(
				(await service.modelMetadata(pinnedId, "openai")).models.good
					?.cacheRetention,
			).toMatchObject({ basis: "inferred", retentionMs: 1_800_000 });
			await dbOps.modelAliases.save({
				...alias,
				targets: alias.targets.slice(0, 1),
			});
			const after = await (await service.wire(id, "codex")).json();
			expect(after.models[0].context_window).toBe(872_000);
			const enriched = await (await service.wire(id, "openai", true)).json();
			expect(enriched.data[0].clankermux.cacheRetention).toMatchObject({
				basis: "inferred",
				retentionMs: 1_800_000,
			});
		});

		it("enriches only this client's aliases and resolves cache policy per endpoint and dialect", async () => {
			const sql = dbOps.getAdapter().getSQLiteDb();
			sql.query("UPDATE accounts SET provider='anthropic' WHERE id='d'").run();
			await discovered("d", ["claude-haiku-4-5-20251001"]);
			const draft = blank();
			draft.destinations = { accountId: "d", providers: null };
			for (const format of ["anthropic", "openai"] as const)
				draft.catalogues[format].models = [
					{
						id: "friendly",
						displayName: "Friendly",
						targetModel: "claude-haiku-4-5-20251001",
						accountIds: ["d"],
					},
				];
			const id = (await create(draft)).client.apiKeyId;
			const policy = {
				mode: "explicit",
				expiry: "estimated",
				source: "gateway-policy",
				defaultTtlMs: 300000,
				supportedTtlMs: [300000, 3600000],
				refreshOnReuse: true,
				ttlAnchor: "request_start",
				ttlSemantics: "minimum",
			};
			const before = await dbOps.clients.getProfile(id);
			const plain = await (await service.wire(id, "anthropic")).json();
			expect(plain.data[0].clankermux).toBeUndefined();
			const enriched = await (await service.wire(id, "anthropic", true)).json();
			expect(enriched.data.map((m: { id: string }) => m.id)).toEqual([
				"friendly",
			]);
			expect(enriched.data[0].clankermux.cachePolicy).toEqual(policy);
			expect(JSON.stringify(enriched)).not.toContain("accountIds");
			expect(await dbOps.clients.getProfile(id)).toEqual(before);
			const openai = await (await service.wire(id, "openai", true)).json();
			expect(openai.data[0].clankermux.cachePolicy).toEqual({
				mode: "unknown",
				expiry: "unavailable",
				source: "unknown",
			});
			// A configured custom host does not inherit the official provider's TTL.
			sql
				.query(
					"UPDATE accounts SET custom_endpoint='https://custom.example' WHERE id='d'",
				)
				.run();
			await discovered("d", ["claude-haiku-4-5-20251001"]);
			const custom = await (await service.wire(id, "anthropic", true)).json();
			expect(custom.data[0].clankermux.cachePolicy).toEqual({
				mode: "unknown",
				expiry: "unavailable",
				source: "unknown",
			});
		});
		it("publishes a labelled inferred Astra retention estimate without changing verified policy", async () => {
			await discovered("c", ["gpt-6-astra"]);
			const id = await astraClient(["c"], { accountId: "c", providers: null });
			const native = await (await service.wire(id, "openai")).json();
			expect(native.data[0].clankermux).toBeUndefined();
			const enriched = await (await service.wire(id, "openai", true)).json();
			expect(enriched.data[0].clankermux.cachePolicy).toEqual({
				mode: "implicit",
				expiry: "unavailable",
				source: "gateway-policy",
			});
			expect(enriched.data[0].clankermux.cacheRetention).toMatchObject({
				basis: "inferred",
				retentionMs: 1_800_000,
				anchor: "request_start",
				anchorBasis: "assumed",
			});
			expect(enriched.data[0].clankermux.cacheRetention.sources).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						url: "https://developers.openai.com/api/docs/guides/prompt-caching",
					}),
				]),
			);
			expect(enriched.data.map((model: { id: string }) => model.id)).toEqual([
				"gpt-6-astra",
			]);
		});

		it("gives an unfamiliar custom model a heuristic without exposing private route state", async () => {
			dbOps
				.getAdapter()
				.getSQLiteDb()
				.query(
					"UPDATE accounts SET custom_endpoint='https://private-route.example/v1' WHERE id='d'",
				)
				.run();
			await discovered("d", ["unfamiliar-model"]);
			const draft = blank();
			draft.destinations = { accountId: "d", providers: null };
			draft.catalogues.openai.models = [
				{
					id: "friendly",
					displayName: "Friendly",
					targetModel: "unfamiliar-model",
					accountIds: ["d"],
				},
			];
			const id = (await create(draft)).client.apiKeyId;
			const before = await dbOps.clients.getProfile(id);
			const plain = await (await service.wire(id, "openai")).json();
			const enriched = await (await service.wire(id, "openai", true)).json();
			const metadata = enriched.data[0].clankermux;
			expect(metadata.cacheRetention).toMatchObject({
				basis: "heuristic",
				retentionMs: 300_000,
				confidence: "low",
				semantics: "heuristic",
				anchorBasis: "assumed",
				refreshBasis: "assumed",
			});
			for (const forbidden of [
				"private-route.example",
				"unfamiliar-model",
				"accountIds",
				"account_id",
				"thinkingLevels",
				"session",
				"estimatedExpiresAt",
			]) {
				expect(JSON.stringify(enriched)).not.toContain(forbidden);
			}
			delete enriched.data[0].clankermux;
			expect(enriched).toEqual(plain);
			expect(await dbOps.clients.getProfile(id)).toEqual(before);
		});

		it("recomputes retention when a routing rule excludes an unknown endpoint", async () => {
			dbOps
				.getAdapter()
				.getSQLiteDb()
				.query(
					"UPDATE accounts SET custom_endpoint='https://private-route.example/v1' WHERE id='d'",
				)
				.run();
			await discovered("c", ["gpt-6-astra"]);
			await discovered("d", ["gpt-6-astra"]);
			const id = await astraClient();
			const pooled = await (await service.wire(id, "openai", true)).json();
			expect(pooled.data[0].clankermux.cacheRetention).toMatchObject({
				basis: "heuristic",
				retentionMs: 300_000,
				confidence: "low",
			});
			await dbOps.routing.saveRule({
				...broad,
				id: "codex-retention-only",
				match_api_key_id: id,
				pool_kind: "accounts",
				pool_account_ids: ["c"],
			});
			const narrowed = await (await service.wire(id, "openai", true)).json();
			expect(narrowed.data[0].clankermux.cacheRetention).toMatchObject({
				basis: "inferred",
				retentionMs: 1_800_000,
			});
			expect(JSON.stringify(pooled)).not.toContain("private-route.example");
		});

		it("serves the native catalogue with empty metadata when enrichment stalls", async () => {
			await discovered("c", ["gpt-6-astra"]);
			const id = await astraClient(["c"], { accountId: "c", providers: null });
			const stalled = spyOn(permissions, "permissions").mockImplementation(
				() => new Promise(() => {}),
			);
			try {
				const response = await service.wire(id, "openai", true);
				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({
					object: "list",
					data: [{ id: "gpt-6-astra", clankermux: {} }],
				});
			} finally {
				stalled.mockRestore();
			}
		});

		it("publishes native Devin limits without a models.dev entry or account requests", async () => {
			dbOps
				.getAdapter()
				.getSQLiteDb()
				.query("UPDATE accounts SET provider='devin' WHERE id='d'")
				.run();
			await discovered("d", ["swe-2-high"]);
			const native = spyOn(
				permissions,
				"discoveredMetadata",
			).mockImplementation((account) =>
				account.id === "d"
					? {
							models: {
								"swe-2-high": {
									contextWindow: 200_000,
									maxOutputTokens: 64_000,
									reasoning: true,
									inputModalities: ["text", "image"],
								},
							},
							stale: false,
						}
					: undefined,
			);
			try {
				const draft = blank();
				draft.destinations = { accountId: "d", providers: null };
				draft.catalogues.openai.models = [
					{
						id: "swe",
						displayName: "SWE",
						targetModel: "swe-2-high",
						accountIds: ["d"],
					},
				];
				const id = (await create(draft)).client.apiKeyId;
				// Make models.dev unavailable, including its previously loaded snapshot.
				__pricingTestHooks.reset();
				globalThis.fetch = (async () => {
					throw new Error("No network during native metadata lookup");
				}) as unknown as typeof fetch;
				const result = await service.modelMetadata(id, "openai");
				expect(result.models.swe).toEqual({
					cacheRetention: expect.any(Object),
					cachePolicy: {
						mode: "unknown",
						expiry: "unavailable",
						source: "unknown",
					},
					contextWindow: 200_000,
					maxOutputTokens: 64_000,
					reasoning: true,
					inputModalities: ["text", "image"],
				});
				expect(result.catalogueLoaded).toBe(true);
				expect(result.catalogueStale).toBe(false);
			} finally {
				native.mockRestore();
			}
		});

		it("keeps native account pools distinct when aliases share a Devin target", async () => {
			dbOps
				.getAdapter()
				.getSQLiteDb()
				.query("UPDATE accounts SET provider='devin' WHERE id='d'")
				.run();
			await discovered("c", ["swe-2-high"]);
			await discovered("d", ["swe-2-high"]);
			dbOps
				.getAdapter()
				.getSQLiteDb()
				.query("UPDATE accounts SET provider='devin' WHERE id='c'")
				.run();
			await discovered("c", ["swe-2-high"]);
			const native = spyOn(
				permissions,
				"discoveredMetadata",
			).mockImplementation((account) => ({
				models: {
					"swe-2-high": {
						contextWindow: account.id === "c" ? 100_000 : 200_000,
						maxOutputTokens: account.id === "c" ? 32_000 : 64_000,
						inputModalities: account.id === "c" ? ["text"] : ["text", "image"],
					},
				},
				stale: account.id === "c",
			}));
			try {
				const draft = blank();
				draft.catalogues.openai.models = [
					{
						id: "pooled",
						displayName: "Pooled",
						targetModel: "swe-2-high",
						accountIds: ["c", "d"],
					},
					{
						id: "large",
						displayName: "Large",
						targetModel: "swe-2-high",
						accountIds: ["d"],
					},
				];
				const id = (await create(draft)).client.apiKeyId;
				const result = await service.modelMetadata(id, "openai");
				expect(result.models.pooled).toEqual({
					cacheRetention: expect.any(Object),
					cachePolicy: {
						mode: "unknown",
						expiry: "unavailable",
						source: "unknown",
					},
					contextWindow: 100_000,
					maxOutputTokens: 32_000,
					inputModalities: ["text"],
				});
				expect(result.models.large).toEqual({
					cacheRetention: expect.any(Object),
					cachePolicy: {
						mode: "unknown",
						expiry: "unavailable",
						source: "unknown",
					},
					contextWindow: 200_000,
					maxOutputTokens: 64_000,
					inputModalities: ["text", "image"],
				});
				expect(result.catalogueStale).toBe(true);
			} finally {
				native.mockRestore();
			}
		});

		it("reports a mixed native and catalogue client unresolved when models.dev fails", async () => {
			dbOps
				.getAdapter()
				.getSQLiteDb()
				.query("UPDATE accounts SET provider='devin' WHERE id='d'")
				.run();
			await discovered("d", ["swe-2-high"]);
			await discovered("c", ["gpt-6-astra"]);
			const native = spyOn(
				permissions,
				"discoveredMetadata",
			).mockImplementation((account) =>
				account.id === "d"
					? {
							models: {
								"swe-2-high": {
									contextWindow: 262_000,
									maxOutputTokens: 128_000,
								},
							},
							stale: false,
						}
					: undefined,
			);
			try {
				const draft = blank();
				draft.catalogues.openai.models = [
					{
						id: "swe",
						displayName: "SWE",
						targetModel: "swe-2-high",
						accountIds: ["d"],
					},
					{
						id: "astra",
						displayName: "Astra",
						targetModel: "gpt-6-astra",
						accountIds: ["c"],
					},
				];
				const id = (await create(draft)).client.apiKeyId;
				rmSync(join(cacheDir, "clankermux", "models.dev.json"), {
					force: true,
				});
				__pricingTestHooks.reset();
				globalThis.fetch = (async () => {
					throw new Error("Catalogue unavailable");
				}) as unknown as typeof fetch;
				const result = await service.modelMetadata(id, "openai");
				expect(result.models.swe).toEqual({
					cacheRetention: expect.any(Object),
					cachePolicy: {
						mode: "unknown",
						expiry: "unavailable",
						source: "unknown",
					},
					contextWindow: 262_000,
					maxOutputTokens: 128_000,
				});
				expect(result.models.astra?.contextWindow).toBe(872_000);
				expect(result.catalogueLoaded).toBe(false);
			} finally {
				native.mockRestore();
			}
		});

		it("reports missing native snapshots as unresolved despite a loaded models.dev catalogue", async () => {
			dbOps
				.getAdapter()
				.getSQLiteDb()
				.query("UPDATE accounts SET provider='devin' WHERE id='d'")
				.run();
			await discovered("d", ["swe-2-high"]);
			const draft = blank();
			draft.destinations = { accountId: "d", providers: null };
			draft.catalogues.openai.models = [
				{
					id: "swe",
					displayName: "SWE",
					targetModel: "swe-2-high",
					accountIds: ["d"],
				},
			];
			const id = (await create(draft)).client.apiKeyId;
			const result = await service.modelMetadata(id, "openai");
			expect(result.models.swe).toEqual({
				cacheRetention: expect.objectContaining({
					basis: "heuristic",
					retentionMs: 300_000,
					confidence: "low",
				}),
			});
			expect(result.catalogueLoaded).toBe(false);
		});

		it("describes the route a literal rule sends the alias to", async () => {
			await discovered("c", ["gpt-6-astra"]);
			const draft = blank();
			draft.destinations = { accountId: "c", providers: null };
			draft.catalogues.openai.models = [
				{
					id: "fast",
					displayName: "Fast",
					targetModel: "fast",
					accountIds: null,
				},
			];
			const id = (await create(draft)).client.apiKeyId;
			await dbOps.routing.saveRule({
				...broad,
				id: "remap",
				match_api_key_id: id,
				match_model_kind: "exact",
				match_model_value: "fast",
				target_kind: "literal",
				target_model: "gpt-6-astra",
			});
			const result = await service.modelMetadata(id, "openai");
			// `fast` is permitted on no account; the rule's target is, and it is the
			// model the client's requests would actually reach.
			expect(result.models.fast?.contextWindow).toBe(872_000);
			expect(result.models.fast?.maxOutputTokens).toBe(128_000);
			expect(result.catalogueLoaded).toBe(true);
		});

		it("narrows the eligible accounts to a rule's pool", async () => {
			await discovered("c", ["gpt-6-astra"]);
			await discovered("d", ["gpt-6-astra"]);
			const id = await astraClient();
			// Both accounts serve the model, so both routes count.
			const pooled = await service.modelMetadata(id, "openai");
			expect(pooled.models["gpt-6-astra"]).toEqual({
				cacheRetention: expect.any(Object),
				cachePolicy: {
					mode: "implicit",
					expiry: "unavailable",
					source: "gateway-policy",
				},
				contextWindow: 200_000,
				maxOutputTokens: 64_000,
				reasoning: false,
				inputModalities: ["text"],
			});
			await dbOps.routing.saveRule({
				...broad,
				id: "codex-only",
				match_api_key_id: id,
				pool_kind: "accounts",
				pool_account_ids: ["c"],
			});
			const narrowed = await service.modelMetadata(id, "openai");
			expect(narrowed.models["gpt-6-astra"]).toEqual({
				cacheRetention: expect.any(Object),
				cachePolicy: {
					mode: "implicit",
					expiry: "unavailable",
					source: "gateway-policy",
				},
				contextWindow: 872_000,
				maxOutputTokens: 128_000,
				reasoning: true,
				inputModalities: ["text", "image"],
				// cacheRead/cacheWrite come from the bundled table backfilling the
				// rates models.dev leaves out of this entry.
				cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
			});
		});

		it("excludes an account whose permissions do not list the target", async () => {
			await discovered("c", ["gpt-6-astra"]);
			await discovered("d", ["swe-2-high"]);
			const result = await service.modelMetadata(await astraClient(), "openai");
			expect(result.models["gpt-6-astra"]?.maxOutputTokens).toBe(128_000);
		});

		it("offers only a labelled heuristic while account permissions are unknown", async () => {
			await discovered("c", ["gpt-6-astra"]);
			const account = await dbOps.getAccount("d");
			if (!account) throw new Error("fixture account d");
			// A row exists but discovery never completed: this account may or may not
			// serve the model, so the alias cannot be described from `c` alone.
			await dbOps.routing.ensurePermissionScope(
				"d",
				modelPermissionScope(account),
			);
			const result = await service.modelMetadata(await astraClient(), "openai");
			expect(result.models["gpt-6-astra"]).toEqual({
				cacheRetention: expect.objectContaining({
					basis: "heuristic",
					retentionMs: 300_000,
					confidence: "low",
				}),
			});
			expect(result.catalogueLoaded).toBe(false);
		});

		it("narrows the eligible accounts to a rule's provider pool", async () => {
			await discovered("c", ["gpt-6-astra"]);
			const account = await dbOps.getAccount("d");
			if (!account) throw new Error("fixture account d");
			// `d` is an openai-compatible account whose discovery never completed, so it is
			// neither eligible nor dismissible on its own.
			await dbOps.routing.ensurePermissionScope(
				"d",
				modelPermissionScope(account),
			);
			const id = await astraClient(null, {
				accountId: null,
				providers: ["codex", "openai-compatible"],
			});
			await dbOps.routing.saveRule({
				...broad,
				id: "codex-provider-only",
				match_api_key_id: id,
				pool_kind: "provider",
				pool_provider: "codex",
			});
			// The rule routes only to codex accounts, so `d` is off the route
			// entirely and its unread permissions say nothing about this alias.
			const result = await service.modelMetadata(id, "openai");
			expect(result.models["gpt-6-astra"]).toEqual({
				cacheRetention: expect.any(Object),
				cachePolicy: {
					mode: "implicit",
					expiry: "unavailable",
					source: "gateway-policy",
				},
				contextWindow: 872_000,
				maxOutputTokens: 128_000,
				reasoning: true,
				inputModalities: ["text", "image"],
				cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
			});
			expect(result.catalogueLoaded).toBe(true);
		});

		it("describes the surviving route when a saved account pin names no live account", async () => {
			await discovered("c", ["gpt-6-astra"]);
			await discovered("d", ["gpt-6-astra"]);
			const id = await astraClient(["d"]);
			// `gpt-6-astra` is published under its own name, so committing this
			// catalogue wrote no routing rule: the stored `accountIds` reach nothing
			// the proxy reads, and its pool stays every pin-allowed account that
			// permits the target. Dropping `d` therefore leaves `c` serving the
			// model, and the dialog has to describe that route instead of reporting
			// no route at all.
			dbOps
				.getAdapter()
				.getSQLiteDb()
				.query("DELETE FROM accounts WHERE id=?")
				.run("d");
			const result = await service.modelMetadata(id, "openai");
			expect(result.models["gpt-6-astra"]).toEqual({
				cacheRetention: expect.any(Object),
				cachePolicy: {
					mode: "implicit",
					expiry: "unavailable",
					source: "gateway-policy",
				},
				contextWindow: 872_000,
				maxOutputTokens: 128_000,
				reasoning: true,
				inputModalities: ["text", "image"],
				cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
			});
			expect(result.catalogueLoaded).toBe(true);
		});
	});
});
