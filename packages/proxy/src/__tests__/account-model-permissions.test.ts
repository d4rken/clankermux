import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { isModelPermitted } from "@clankermux/core";
import {
	BunSqlAdapter,
	ensureSchema,
	RoutingRepository,
} from "@clankermux/database";
import { GROK_CLI_IDENTITY_HEADERS } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import {
	ClientModelConfigSchema,
	GetCliModelConfigsResponseSchema,
	GetUserJwtResponseSchema,
	GetUserStatusResponseSchema,
	ModelFamilyMetadataEntrySchema,
	ModelFamilyMetadataSchema,
	ModelFamilyMetadataValueSchema,
	ModelFeaturesSchema,
	ModelInfoSchema,
} from "../../../providers/src/providers/devin/vendor/devin-proto";
import {
	create,
	toBinary,
} from "../../../providers/src/providers/devin/vendor/protobuf";
import {
	AccountModelPermissionService,
	modelPermissionScope,
} from "../account-model-permissions";

const account = (id = "a", patch: Partial<Account> = {}): Account =>
	({
		id,
		name: id,
		provider: "openai-compatible",
		api_key: "key",
		custom_endpoint: "https://models.example/v1",
		...patch,
	}) as Account;
const databases: Database[] = [];
function setup(
	accounts: Account[],
	fetcher: (
		input: string | URL | Request,
		init?: RequestInit,
	) => Promise<Response>,
	token?: () => Promise<string>,
	budgets?: { requestBudgetMs?: number; backgroundBudgetMs?: number },
) {
	const db = new Database(":memory:");
	databases.push(db);
	ensureSchema(db);
	const repo = new RoutingRepository(new BunSqlAdapter(db));
	const service = new AccountModelPermissionService({
		repository: repo,
		listAccounts: async () => accounts,
		getAccessToken: token ?? (async () => "token"),
		fetchImpl: fetcher as typeof fetch,
		requestBudgetMs: budgets?.requestBudgetMs ?? 25,
		backgroundBudgetMs: budgets?.backgroundBudgetMs ?? 40,
	});
	return { repo, service };
}
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
describe("account model discovery", () => {
	it("coalesces misses and replaces only discovered IDs", async () => {
		const a = account();
		let calls = 0;
		const { repo, service } = setup([a], async () => {
			calls++;
			return Response.json({ data: [{ id: "listed" }] });
		});
		await repo.setManualModels(a.id, modelPermissionScope(a), ["manual"]);
		await Promise.all([service.refresh(a), service.refresh(a)]);
		expect(calls).toBe(1);
		expect(await service.permissions(a)).toMatchObject({
			discovered_ids: ["listed"],
			manual_ids: ["manual"],
		});
		await service.refresh(a);
		expect(calls).toBe(1);
	});
	it("bounds the whole request wait across accounts including hung credentials", async () => {
		const accounts = [
			account("a", { api_key: null }),
			account("b", { api_key: null }),
		];
		let calls = 0;
		const { service } = setup(
			accounts,
			async () => {
				calls++;
				return Response.json({ data: [] });
			},
			() => new Promise(() => {}),
		);
		const start = performance.now();
		await service.refreshMisses(accounts);
		expect(performance.now() - start).toBeLessThan(120);
		expect(calls).toBe(0);
		// Let the bounded background operation settle before the test closes SQLite.
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	it("follows complete pages and preserves last good state on partial responses", async () => {
		const a = account();
		let count = 0;
		let partial = false;
		const { repo, service } = setup([a], async (input) => {
			count++;
			if (partial)
				return Response.json({ data: [{ id: "untrusted" }], has_more: true });
			return String(input).includes("after=first")
				? Response.json({ data: [{ id: "second" }], has_more: false })
				: Response.json({
						data: [{ id: "first" }],
						has_more: true,
						last_id: "first",
					});
		});
		await service.refresh(a, true);
		expect(count).toBe(2);
		partial = true;
		await service.refresh(a, true);
		expect(await repo.getPermissions(a.id)).toMatchObject({
			discovered_ids: ["first", "second"],
			completeness: "known-complete",
		});
	});
	it("scopes API key/backend changes but not ordinary OAuth refresh", () => {
		const a = account();
		expect(modelPermissionScope(a)).not.toBe(
			modelPermissionScope({ ...a, api_key: "other" }),
		);
		expect(modelPermissionScope(a)).not.toBe(
			modelPermissionScope({
				...a,
				custom_endpoint: "https://other.example/v1",
			}),
		);
		const oauth = account("oauth", {
			api_key: null,
			identity_external_id: "principal",
			access_token: "old",
			refresh_token: "refresh-old",
		});
		expect(modelPermissionScope(oauth)).toBe(
			modelPermissionScope({
				...oauth,
				access_token: "new",
				refresh_token: "refresh-new",
			}),
		);
	});
	it("discovers Codex models with only that account's bearer", async () => {
		const a = account("codex", {
			provider: "codex",
			api_key: null,
			custom_endpoint: null,
		});
		const seen: { url: string; headers: Headers }[] = [];
		const { service } = setup(
			[a],
			async (input, init) => {
				seen.push({ url: String(input), headers: new Headers(init?.headers) });
				return Response.json({ models: [{ slug: "gpt-6-astra" }] });
			},
			async () => "codex-account-token",
		);
		await service.refresh(a);
		expect(seen).toHaveLength(1);
		expect(seen[0].url).toStartWith(
			"https://chatgpt.com/backend-api/codex/models?",
		);
		expect(seen[0].headers.get("authorization")).toBe(
			"Bearer codex-account-token",
		);
		expect(await service.permissions(a)).toMatchObject({
			completeness: "known-complete",
			discovered_ids: ["gpt-6-astra"],
		});
	});
	it.each([
		true,
		false,
	])("follows Anthropic metadata pagination with account authentication, apiKey=%s", async (apiKey) => {
		const a = account("anthropic", {
			provider: "anthropic",
			api_key: apiKey ? "account-key" : null,
			custom_endpoint: null,
		});
		const seen: Headers[] = [];
		const { service } = setup([a], async (input, init) => {
			seen.push(new Headers(init?.headers));
			expect(String(input)).toStartWith("https://api.anthropic.com/v1/models?");
			return String(input).includes("after_id=first")
				? Response.json({ data: [{ id: "second" }], has_more: false })
				: Response.json({
						data: [{ id: "first" }],
						has_more: true,
						last_id: "first",
					});
		});
		await service.refresh(a);
		expect(seen).toHaveLength(2);
		expect(seen[0].get(apiKey ? "x-api-key" : "authorization")).toBe(
			apiKey ? "account-key" : "Bearer token",
		);
		expect(seen[0].get("anthropic-version")).toBe("2023-06-01");
		expect((await service.permissions(a)).discovered_ids).toEqual([
			"first",
			"second",
		]);
	});
	it("uses the OpenRouter user catalogue and isolates two account results", async () => {
		const accounts = [
			account("one", {
				provider: "openrouter",
				api_key: "key-one",
				custom_endpoint: null,
			}),
			account("two", {
				provider: "openrouter",
				api_key: "key-two",
				custom_endpoint: null,
			}),
		];
		const { service } = setup(accounts, async (input, init) => {
			expect(String(input)).toBe("https://openrouter.ai/api/v1/models/user");
			return Response.json({
				data: [
					{
						id:
							new Headers(init?.headers).get("authorization") ===
							"Bearer key-one"
								? "first"
								: "second",
					},
				],
			});
		});
		await Promise.all(accounts.map((a) => service.refresh(a)));
		expect((await service.permissions(accounts[0])).discovered_ids).toEqual([
			"first",
		]);
		expect((await service.permissions(accounts[1])).discovered_ids).toEqual([
			"second",
		]);
	});
	it("discovers Grok models from the xAI catalogue", async () => {
		const a = account("grok", {
			provider: "grok",
			api_key: "xai-key",
			custom_endpoint: null,
		});
		const seen: Headers[] = [];
		const { service } = setup([a], async (input, init) => {
			seen.push(new Headers(init?.headers));
			expect(String(input)).toBe("https://api.x.ai/v1/models");
			return Response.json({ object: "list", data: [{ id: "grok-4.6" }] });
		});
		await service.refresh(a);
		expect(seen).toHaveLength(1);
		expect(seen[0].get("authorization")).toBe("Bearer xai-key");
		expect((await service.permissions(a)).discovered_ids).toEqual(["grok-4.6"]);
	});

	it("refuses to discover Grok models from a custom backend", async () => {
		const a = account("grok-custom", {
			provider: "grok",
			api_key: "xai-key",
			custom_endpoint: "https://proxy.example/v1",
		});
		let calls = 0;
		const { service } = setup([a], async () => {
			calls++;
			return Response.json({ data: [{ id: "never-reached" }] });
		});
		await service.refresh(a);
		expect(calls).toBe(0);
		const permissions = await service.permissions(a);
		expect(permissions.discovered_ids).toEqual([]);
		expect(permissions.last_error).not.toBeNull();
	});

	it("does not overwrite a manual edit completed while discovery was in flight", async () => {
		const a = account();
		let finish!: (r: Response) => void;
		let entered!: () => void;
		const ready = new Promise<void>((r) => (entered = r));
		const { service, repo } = setup([a], async () => {
			entered();
			return new Promise((r) => (finish = r));
		});
		const pending = service.refresh(a);
		await ready;
		await repo.setManualModels(a.id, modelPermissionScope(a), [
			"manual-after-fetch",
		]);
		finish(Response.json({ data: [{ id: "stale-fetch" }] }));
		await pending;
		expect(await service.permissions(a)).toMatchObject({
			manual_ids: ["manual-after-fetch"],
			discovered_ids: [],
			completeness: "unknown",
		});
	});
	it("ignores late discovery from a replaced credential scope", async () => {
		const a = account();
		const accounts = [a];
		let finish!: (r: Response) => void;
		let entered!: () => void;
		const ready = new Promise<void>((r) => (entered = r));
		const { service, repo } = setup(accounts, async () => {
			entered();
			return new Promise((r) => (finish = r));
		});
		const pending = service.refresh(a);
		await ready;
		const replacement = { ...a, api_key: "replacement" };
		accounts[0] = replacement;
		await repo.setManualModels(a.id, modelPermissionScope(replacement), [
			"replacement-model",
		]);
		finish(Response.json({ data: [{ id: "old-model" }] }));
		await pending;
		expect(await service.permissions(replacement)).toMatchObject({
			manual_ids: ["replacement-model"],
			discovered_ids: [],
		});
	});
	it("stops discovery without persisting a fabricated timeout and observes late rejection", async () => {
		const a = account();
		let reject!: (e: Error) => void;
		let entered!: () => void;
		const ready = new Promise<void>((r) => (entered = r));
		const { service, repo } = setup([a], async () => {
			entered();
			return new Promise((_r, j) => (reject = j));
		});
		const pending = service.refresh(a);
		await ready;
		service.stop();
		reject(new Error("late fetch rejection"));
		await pending;
		expect((await repo.getPermissions(a.id))?.last_error).toBeNull();
	});
});

it("discovers only enabled concrete Devin models from native account metadata", async () => {
	const a = account("devin", { provider: "devin", custom_endpoint: null });
	const paths: string[] = [];
	let fail = false;
	const { service, repo } = setup([a], async (input) => {
		const path = new URL(String(input)).pathname;
		paths.push(path);
		if (fail) return new Response(null, { status: 503 });
		if (path.endsWith("GetUserJwt"))
			return new Response(
				new Uint8Array(
					toBinary(
						GetUserJwtResponseSchema,
						create(GetUserJwtResponseSchema, { userJwt: "jwt" }),
					),
				),
			);
		if (path.endsWith("GetCliModelConfigs"))
			return new Response(
				new Uint8Array(
					toBinary(
						GetCliModelConfigsResponseSchema,
						create(GetCliModelConfigsResponseSchema, {
							clientModelConfigs: [
								create(ClientModelConfigSchema, {
									modelUid: "swe-2-high",
									label: "SWE-2 High",
									maxTokens: 200_000,
									supportsImages: true,
									modelInfo: create(ModelInfoSchema, {
										maxTokens: 200_000,
										maxOutputTokens: 64_000,
										modelFeatures: create(ModelFeaturesSchema, {
											supportsThinking: true,
										}),
									}),
								}),
								create(ClientModelConfigSchema, {
									modelUid: "swe-2-max",
									disabled: true,
								}),
								create(ClientModelConfigSchema, {
									modelUid: "swe-2-medium",
									maxTokens: 200_000,
								}),
								create(ClientModelConfigSchema, {
									modelUid: "swe-2-invalid",
									modelInfo: create(ModelInfoSchema, {
										maxTokens: -1,
										maxOutputTokens: -1,
									}),
								}),
								create(ClientModelConfigSchema, { modelUid: "adaptive" }),
							],
						}),
					),
				),
			);
		return new Response(
			new Uint8Array(
				toBinary(
					GetUserStatusResponseSchema,
					create(GetUserStatusResponseSchema),
				),
			),
		);
	});
	const scope = modelPermissionScope(a);
	const initial = await repo.ensurePermissionScope(a.id, scope);
	await repo.completeDiscovery(
		a.id,
		scope,
		initial.generation,
		["swe-2-high"],
		Date.now(),
	);
	// Even a recently persisted ID list needs its native metadata hydrated after restart.
	await service.tick();
	const permission = await service.permissions(a);
	expect(permission.discovered_ids).toEqual([
		"swe-2-high",
		"swe-2-invalid",
		"swe-2-medium",
	]);
	expect(service.discoveredMetadata(a, permission)?.models).toEqual({
		"swe-2-medium": { inputModalities: ["text"] },
		"swe-2-invalid": { inputModalities: ["text"] },
		"swe-2-high": {
			contextWindow: 200_000,
			maxOutputTokens: 64_000,
			reasoning: true,
			inputModalities: ["text", "image"],
		},
	});
	expect(service.discoveredMetadata(a, permission)?.stale).toBe(false);
	expect(
		service.discoveredMetadata({ ...a, api_key: "replacement" }, permission),
	).toBeUndefined();
	expect(
		service.discoveredMetadata(a, {
			...permission,
			generation: permission.generation + 1,
		}),
	).toBeUndefined();
	expect(
		service.discoveredMetadata(a, {
			...permission,
			last_error: "refresh failed",
		})?.stale,
	).toBe(true);
	expect(paths).toHaveLength(3);
	expect(paths.some((p) => p.endsWith("/models"))).toBe(false);
	const first = service.discoveredMetadata(a, permission)?.models;
	if (!first) throw new Error("Expected native metadata snapshot");
	const now = Date.now();
	const clock = spyOn(Date, "now").mockReturnValue(now + 31_000);
	try {
		fail = true;
		await service.refresh(a, true);
		const failed = await service.permissions(a);
		expect(failed.last_error).not.toBeNull();
		expect(failed.discovered_ids).toEqual(permission.discovered_ids);
		expect(service.discoveredMetadata(a, failed)).toEqual({
			models: first,
			stale: true,
		});
		clock.mockReturnValue(now + 62_000);
		fail = false;
		await service.refresh(a, true);
		const recovered = await service.permissions(a);
		expect(recovered.last_error).toBeNull();
		expect(service.discoveredMetadata(a, recovered)).toEqual({
			models: first,
			stale: false,
		});
	} finally {
		clock.mockRestore();
	}
});

it("persists the family variants of the Devin models it discovers", async () => {
	const a = account("devin", { provider: "devin", custom_endpoint: null });
	const member = (modelUid: string, effort: string, disabled = false) =>
		create(ClientModelConfigSchema, {
			modelUid,
			disabled,
			modelFamilyMetadata: create(ModelFamilyMetadataSchema, {
				modelFamilyLabel: "SWE-2",
				entries: [
					create(ModelFamilyMetadataEntrySchema, {
						key: "Reasoning Effort",
						value: create(ModelFamilyMetadataValueSchema, {
							name: effort,
							order: 1,
						}),
					}),
				],
			}),
		});
	const { service } = setup([a], async (input) => {
		const path = new URL(String(input)).pathname;
		if (path.endsWith("GetUserJwt"))
			return new Response(
				new Uint8Array(
					toBinary(
						GetUserJwtResponseSchema,
						create(GetUserJwtResponseSchema, { userJwt: "jwt" }),
					),
				),
			);
		if (path.endsWith("GetCliModelConfigs"))
			return new Response(
				new Uint8Array(
					toBinary(
						GetCliModelConfigsResponseSchema,
						create(GetCliModelConfigsResponseSchema, {
							clientModelConfigs: [
								member("swe-2-high", "High"),
								member("swe-2-max", "Max", true),
								create(ClientModelConfigSchema, { modelUid: "standalone" }),
							],
						}),
					),
				),
			);
		return new Response(
			new Uint8Array(
				toBinary(
					GetUserStatusResponseSchema,
					create(GetUserStatusResponseSchema),
				),
			),
		);
	});
	await service.tick();
	const permission = await service.permissions(a);
	expect(permission.discovered_ids).toEqual(["standalone", "swe-2-high"]);
	// Disabled members are not discovered, and a model outside any family has
	// no variant to record.
	expect(permission.model_variants).toEqual({
		"swe-2-high": { family: "SWE-2", effort: "high", dimensions: "" },
	});
});

/**
 * Z.ai discovery. The endpoint is INFERRED from Z.ai's Anthropic Messages
 * compatibility, not from a published catalogue contract, so these pin the
 * request this proxy makes and — more importantly — that every way it can fail
 * leaves the account's existing permissions alone.
 */
describe("zai model discovery", () => {
	const zai = (id = "zai", patch: Partial<Account> = {}) =>
		account(id, {
			provider: "zai",
			api_key: "zai-key",
			custom_endpoint: null,
			...patch,
		});

	it("reads the fixed Z.ai catalogue with the account's own API key", async () => {
		const a = zai();
		const seen: { url: string; headers: Headers; redirect?: string }[] = [];
		const { service } = setup([a], async (input, init) => {
			seen.push({
				url: String(input),
				headers: new Headers(init?.headers),
				redirect: init?.redirect,
			});
			return Response.json({ data: [{ id: "glm-4.6" }] });
		});
		await service.refresh(a);
		expect(seen).toHaveLength(1);
		expect(seen[0].url).toBe(
			"https://api.z.ai/api/anthropic/v1/models?limit=1000",
		);
		expect(seen[0].headers.get("x-api-key")).toBe("zai-key");
		expect(seen[0].headers.get("anthropic-version")).toBe("2023-06-01");
		// An Anthropic OAuth bearer on a Z.ai request would be a credential leak.
		expect(seen[0].headers.get("authorization")).toBeNull();
		expect(seen[0].headers.get("anthropic-beta")).toBeNull();
		expect(seen[0].redirect).toBe("error");
		expect((await service.permissions(a)).discovered_ids).toEqual(["glm-4.6"]);
	});

	it("ignores a stored custom endpoint rather than redirecting the key to it", async () => {
		// zai pins its endpoint (supportsCustomEndpoint === false), but a value
		// stored before that gate existed must not become a credential redirect.
		const a = zai("zai-endpoint", {
			custom_endpoint: "https://attacker.example/v1",
		});
		const hosts: string[] = [];
		const { service } = setup([a], async (input) => {
			hosts.push(new URL(String(input)).hostname);
			return Response.json({ data: [{ id: "glm-4.6" }] });
		});
		await service.refresh(a);
		expect(hosts).toEqual(["api.z.ai"]);
	});

	it("pages with after_id and commits only the complete list", async () => {
		const a = zai("zai-pages");
		const urls: string[] = [];
		const { repo, service } = setup([a], async (input) => {
			const url = String(input);
			urls.push(url);
			return url.includes("after_id=glm-4.6")
				? Response.json({ data: [{ id: "glm-4.5" }], has_more: false })
				: Response.json({
						data: [{ id: "glm-4.6" }],
						has_more: true,
						last_id: "glm-4.6",
					});
		});
		await service.refresh(a);
		expect(urls).toHaveLength(2);
		// `after`, the OpenAI-style cursor, would silently re-request page one.
		expect(urls[1]).toContain("after_id=glm-4.6");
		expect(new URL(urls[1]).hostname).toBe("api.z.ai");
		// Stored deduped and sorted, not in page order (repository `modelIds`).
		expect(await repo.getPermissions(a.id)).toMatchObject({
			discovered_ids: ["glm-4.5", "glm-4.6"],
			completeness: "known-complete",
		});
	});

	it("records an empty catalogue as known-empty, not as unknown", async () => {
		const a = zai("zai-empty");
		const { repo, service } = setup([a], async () =>
			Response.json({ data: [], has_more: false }),
		);
		await service.refresh(a);
		expect(await repo.getPermissions(a.id)).toMatchObject({
			discovered_ids: [],
			completeness: "known-empty",
		});
	});

	it("never reaches for a token or a request when the account has no API key", async () => {
		const a = zai("zai-nokey", { api_key: null });
		let fetches = 0;
		let tokenCalls = 0;
		const { repo, service } = setup(
			[a],
			async () => {
				fetches++;
				return Response.json({ data: [{ id: "never-reached" }] });
			},
			// A Z.ai account has no OAuth path, so discovery must not ask the
			// generic helper to mint a token. This RECORDS the call and returns a
			// usable token rather than throwing: `discover` catches everything, so
			// a throwing stub would produce the same failed-discovery state whether
			// or not the helper ran, and the assertion below would prove nothing.
			async () => {
				tokenCalls++;
				return "token-that-should-never-be-requested";
			},
		);
		await service.refresh(a);
		expect({ tokenCalls, fetches }).toEqual({ tokenCalls: 0, fetches: 0 });
		expect((await repo.getPermissions(a.id))?.last_error).not.toBeNull();
	});

	it("keeps prior permissions when the guessed endpoint does not exist", async () => {
		const a = zai("zai-404");
		let ok = true;
		const { repo, service } = setup([a], async () =>
			ok
				? Response.json({ data: [{ id: "glm-4.6" }] })
				: new Response("not found", { status: 404 }),
		);
		await service.refresh(a, true);
		ok = false;
		await service.refresh(a, true);
		// The degradation argument this branch rests on: a wrong URL costs an
		// error string, never the models the account was already allowed to serve.
		expect(await repo.getPermissions(a.id)).toMatchObject({
			discovered_ids: ["glm-4.6"],
			completeness: "known-complete",
		});
		expect((await repo.getPermissions(a.id))?.last_error).not.toBeNull();
	});

	it("keeps prior permissions when a later page fails", async () => {
		const a = zai("zai-page2");
		let failSecond = false;
		const { repo, service } = setup([a], async (input) => {
			if (String(input).includes("after_id")) {
				if (failSecond) return new Response("boom", { status: 500 });
				return Response.json({ data: [{ id: "glm-4.5" }], has_more: false });
			}
			return Response.json({
				data: [{ id: "glm-4.6" }],
				has_more: true,
				last_id: "glm-4.6",
			});
		});
		await service.refresh(a, true);
		failSecond = true;
		await service.refresh(a, true);
		expect(await repo.getPermissions(a.id)).toMatchObject({
			discovered_ids: ["glm-4.5", "glm-4.6"],
		});
	});

	it("rejects a malformed catalogue instead of committing a partial list", async () => {
		const a = zai("zai-malformed");
		const { repo, service } = setup([a], async () =>
			Response.json({ data: [{ id: "glm-4.6" }, { id: 42 }] }),
		);
		await service.refresh(a);
		const permissions = await repo.getPermissions(a.id);
		expect(permissions?.discovered_ids).toEqual([]);
		expect(permissions?.last_error).not.toBeNull();
	});

	it("gives two Z.ai accounts their own key and their own result", async () => {
		const one = zai("zai-one", { api_key: "key-one" });
		const two = zai("zai-two", { api_key: "key-two" });
		const keys: string[] = [];
		const { service } = setup([one, two], async (_input, init) => {
			const key = new Headers(init?.headers).get("x-api-key") ?? "";
			keys.push(key);
			return Response.json({ data: [{ id: `model-for-${key}` }] });
		});
		await Promise.all([service.refresh(one), service.refresh(two)]);
		expect([...keys].sort()).toEqual(["key-one", "key-two"]);
		expect((await service.permissions(one)).discovered_ids).toEqual([
			"model-for-key-one",
		]);
		expect((await service.permissions(two)).discovered_ids).toEqual([
			"model-for-key-two",
		]);
	});

	it("abandons a hung Z.ai catalogue on its OWN budget, well before the general one", async () => {
		const a = zai("zai-hang");
		let entered!: () => void;
		const ready = new Promise<void>((r) => (entered = r));
		let settle!: () => void;
		let aborted = false;
		// The general budget is deliberately far ABOVE the 1s Z.ai cap. With the
		// usual 40ms test budget this test would pass with the cap deleted, since
		// min(40, 1000) is 40 either way — it would prove nothing about the cap.
		const { repo, service } = setup(
			[a],
			async (_input, init) => {
				entered();
				init?.signal?.addEventListener("abort", () => {
					aborted = true;
				});
				await new Promise<void>((r) => (settle = r));
				return Response.json({ data: [{ id: "too-late" }] });
			},
			undefined,
			{ backgroundBudgetMs: 30_000 },
		);
		const started = Date.now();
		const pending = service.refresh(a);
		await ready;
		await pending;
		const elapsed = Date.now() - started;
		// Bounded by the Z.ai cap, not the 30s general budget.
		expect(elapsed).toBeLessThan(5_000);
		expect(aborted).toBe(true);
		expect(await repo.getPermissions(a.id)).toMatchObject({
			discovered_ids: [],
			last_error: "Model discovery timed out",
		});

		// The abandoned request completing later must not resurrect its result.
		settle();
		await Promise.resolve();
		expect(await repo.getPermissions(a.id)).toMatchObject({
			discovered_ids: [],
			last_error: "Model discovery timed out",
		});
	});

	it("still honours a smaller injected general budget", async () => {
		// The cap is a ceiling, not a floor: min() must keep the smaller value so
		// a short test budget is not silently widened to a second.
		const a = zai("zai-short-budget");
		let settle!: () => void;
		const { repo, service } = setup(
			[a],
			async () => {
				await new Promise<void>((r) => (settle = r));
				return Response.json({ data: [{ id: "too-late" }] });
			},
			undefined,
			{ backgroundBudgetMs: 30 },
		);
		const started = Date.now();
		await service.refresh(a);
		expect(Date.now() - started).toBeLessThan(900);
		expect((await repo.getPermissions(a.id))?.last_error).toBe(
			"Model discovery timed out",
		);
		settle();
	});
});

/**
 * MiMo Token Plan discovery. The catalogue is NOT the Messages base with
 * `/v1/models` appended: Token Plan serves requests under `/anthropic` and its
 * catalogue on the host root, OpenAI-shaped and Bearer-authenticated, so these
 * pin the derivation and every way it is allowed to fail. The base comes from
 * the account rather than being pinned like Z.ai's, because the Token Plan
 * region lives in `custom_endpoint` and a key is accepted by its own region
 * alone — so the region is what these check hardest.
 */
describe("mimo model discovery", () => {
	const mimo = (id = "mimo", patch: Partial<Account> = {}) =>
		account(id, {
			provider: "mimo",
			api_key: "tp-key",
			custom_endpoint: null,
			...patch,
		});
	/** Verbatim from a live Token Plan subscription's catalogue read. */
	const CATALOGUE = [
		"mimo-v2.5",
		"mimo-v2.5-asr",
		"mimo-v2.5-pro",
		"mimo-v2.5-tts",
		"mimo-v2.5-tts-voiceclone",
		"mimo-v2.5-tts-voicedesign",
		"mimo-v2.6-flash",
		"mimo-v2.6-pro",
	];
	const catalogueBody = () =>
		Response.json({
			object: "list",
			data: CATALOGUE.map((id) => ({
				id,
				object: "model",
				owned_by: "xiaomi",
			})),
		});

	it("reads the default region's catalogue with the account's Token Plan key", async () => {
		const a = mimo();
		const seen: { url: string; headers: Headers; redirect?: string }[] = [];
		const { service } = setup([a], async (input, init) => {
			seen.push({
				url: String(input),
				headers: new Headers(init?.headers),
				redirect: init?.redirect,
			});
			return catalogueBody();
		});
		await service.refresh(a);
		expect(seen).toHaveLength(1);
		// The `/anthropic` the default base carries is the MESSAGES path; the
		// catalogue lives on the root, so it is stripped rather than extended.
		expect(seen[0].url).toBe("https://token-plan-sgp.xiaomimimo.com/v1/models");
		expect(seen[0].headers.get("authorization")).toBe("Bearer tp-key");
		// The root catalogue is OpenAI-shaped: the Anthropic key header and version
		// are not what it authenticates with.
		expect(seen[0].headers.get("x-api-key")).toBeNull();
		expect(seen[0].headers.get("anthropic-version")).toBeNull();
		expect(seen[0].headers.get("anthropic-beta")).toBeNull();
		expect(seen[0].redirect).toBe("error");
		expect((await service.permissions(a)).discovered_ids).toEqual(CATALOGUE);
	});

	it("discovers against the account's own region instead of the default", async () => {
		// honoursCustomEndpoint is true for mimo: inference goes to the stored
		// region, and a Token Plan key is 401 anywhere else — so a catalogue read
		// from Singapore would describe a backend this account cannot talk to.
		const a = mimo("mimo-region", {
			custom_endpoint: "https://token-plan-ams.xiaomimimo.com/anthropic",
		});
		const urls: string[] = [];
		const { service } = setup([a], async (input) => {
			urls.push(String(input));
			return catalogueBody();
		});
		await service.refresh(a);
		expect(urls).toEqual(["https://token-plan-ams.xiaomimimo.com/v1/models"]);
		expect((await service.permissions(a)).discovered_ids).toEqual(CATALOGUE);
	});

	it("strips the `/anthropic` even when the base already carries a `/v1`", async () => {
		// The stored endpoint may already carry the `/v1` that the request path
		// would otherwise supply. The catalogue still sits on the host ROOT, so
		// both segments come off: appending here would ask for
		// `/anthropic/v1/v1/models`, which is not a MiMo surface.
		const a = mimo("mimo-region-v1", {
			custom_endpoint: "https://token-plan-ams.xiaomimimo.com/anthropic/v1",
		});
		const urls: string[] = [];
		const { service } = setup([a], async (input) => {
			urls.push(String(input));
			return catalogueBody();
		});
		await service.refresh(a);
		expect(urls).toEqual(["https://token-plan-ams.xiaomimimo.com/v1/models"]);
		expect((await service.permissions(a)).discovered_ids).toEqual(CATALOGUE);
	});

	it("reaches the same catalogue from a base that ends in a slash", async () => {
		// Trailing slashes come off before either segment is matched, so a base
		// pasted with one normalizes to exactly the URL the unslashed form does.
		const a = mimo("mimo-region-v1-slash", {
			custom_endpoint: "https://token-plan-ams.xiaomimimo.com/anthropic/v1/",
		});
		const urls: string[] = [];
		const { service } = setup([a], async (input) => {
			urls.push(String(input));
			return catalogueBody();
		});
		await service.refresh(a);
		expect(urls).toEqual(["https://token-plan-ams.xiaomimimo.com/v1/models"]);
		expect((await service.permissions(a)).discovered_ids).toEqual(CATALOGUE);
	});

	it("commits the whole list from the single request it arrives in", async () => {
		// The OpenAI list shape carries no cursor and no `has_more`, so there is no
		// second page to ask for: one request either yields the catalogue or yields
		// nothing. A cursor parameter left on the URL would re-request page one.
		const a = mimo("mimo-single-request");
		const urls: string[] = [];
		const { repo, service } = setup([a], async (input) => {
			urls.push(String(input));
			return catalogueBody();
		});
		await service.refresh(a);
		expect(urls).toEqual(["https://token-plan-sgp.xiaomimimo.com/v1/models"]);
		expect(await repo.getPermissions(a.id)).toMatchObject({
			discovered_ids: CATALOGUE,
			completeness: "known-complete",
		});
	});

	it("never reaches for a token or a request when the account has no API key", async () => {
		const a = mimo("mimo-nokey", { api_key: null });
		let fetches = 0;
		let tokenCalls = 0;
		const { repo, service } = setup(
			[a],
			async () => {
				fetches++;
				return catalogueBody();
			},
			// Token Plan has no OAuth path at all. The stub RECORDS and returns a
			// usable token rather than throwing: `discover` swallows everything, so
			// a throwing stub would leave the same failed state either way and the
			// assertion below would prove nothing.
			async () => {
				tokenCalls++;
				return "token-that-should-never-be-requested";
			},
		);
		await service.refresh(a);
		expect({ tokenCalls, fetches }).toEqual({ tokenCalls: 0, fetches: 0 });
		expect((await repo.getPermissions(a.id))?.last_error).not.toBeNull();
	});

	it("refuses an endpoint that cannot serve as a base", async () => {
		// A query on the base cannot survive having a path appended to it, so the
		// shape guard rejects it before the Token Plan key is sent anywhere.
		const a = mimo("mimo-bad-endpoint", {
			custom_endpoint: "https://token-plan-cn.xiaomimimo.com/anthropic?key=x",
		});
		let fetches = 0;
		const { repo, service } = setup([a], async () => {
			fetches++;
			return catalogueBody();
		});
		await service.refresh(a);
		expect(fetches).toBe(0);
		expect(await repo.getPermissions(a.id)).toMatchObject({
			discovered_ids: [],
		});
		expect((await repo.getPermissions(a.id))?.last_error).not.toBeNull();
	});

	it("leaves manual models intact when the catalogue read fails", async () => {
		const a = mimo("mimo-404");
		const { repo, service } = setup(
			[a],
			async () => new Response("not found", { status: 404 }),
		);
		await repo.setManualModels(a.id, modelPermissionScope(a), ["mimo-manual"]);
		await service.refresh(a, true);
		// The degradation argument the whole branch rests on: a catalogue MiMo has
		// moved costs an error string, never the models the account was already
		// allowed to serve.
		expect(await repo.getPermissions(a.id)).toMatchObject({
			manual_ids: ["mimo-manual"],
			discovered_ids: [],
		});
		expect((await repo.getPermissions(a.id))?.last_error).not.toBeNull();
	});
});

/**
 * SuperGrok / X Premium discovery against cli-chat-proxy.grok.com. The fixture
 * is the catalogue that proxy returned when probed live: four ids, each on the
 * Responses backend with a 500k window.
 */
describe("grok-subscription model discovery", () => {
	const PUBLISHED = ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"];
	const catalogue = (ids: readonly string[] = PUBLISHED) =>
		Response.json({
			object: "list",
			data: ids.map((id) => ({
				id,
				object: "model",
				api_backend: "responses",
				context_window: 500000,
			})),
		});
	const grok = (id = "grok-sub", patch: Partial<Account> = {}) =>
		account(id, {
			provider: "grok-subscription",
			api_key: null,
			custom_endpoint: null,
			identity_external_id: `principal-${id}`,
			...patch,
		});
	/**
	 * Stands in for the proxy's version gate: a request that lacks any one of the
	 * Grok-CLI identity headers is answered 426, exactly as a bare bearer is.
	 */
	const gated =
		(ids: () => readonly string[] = () => PUBLISHED) =>
		async (_input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			for (const [name, value] of Object.entries(GROK_CLI_IDENTITY_HEADERS))
				if (headers.get(name) !== value)
					return new Response(
						"Your Grok CLI is out of date. Please update to version 0.2.101 or later.",
						{ status: 426 },
					);
			return catalogue(ids());
		};
	const permitted = async (
		service: AccountModelPermissionService,
		a: Account,
		model: string,
	) => isModelPermitted(await service.permissions(a), a.id, model, null);

	it("reads the fixed chat-proxy catalogue with the OAuth bearer and the CLI identity", async () => {
		const a = grok();
		const seen: { url: string; headers: Headers; redirect?: string }[] = [];
		const gate = gated();
		const { service } = setup(
			[a],
			async (input, init) => {
				seen.push({
					url: String(input),
					headers: new Headers(init?.headers),
					redirect: init?.redirect,
				});
				return gate(input, init);
			},
			async () => "grok-oauth-token",
		);
		await service.refresh(a);
		expect(seen).toHaveLength(1);
		expect(seen[0].url).toBe("https://cli-chat-proxy.grok.com/v1/models");
		expect(seen[0].headers.get("authorization")).toBe(
			"Bearer grok-oauth-token",
		);
		for (const [name, value] of Object.entries(GROK_CLI_IDENTITY_HEADERS))
			expect(seen[0].headers.get(name)).toBe(value);
		expect(seen[0].redirect).toBe("error");
		const permissions = await service.permissions(a);
		expect(permissions.completeness).toBe("known-complete");
		expect(permissions.last_error).toBeNull();
	});

	it("commits exactly the published ids and routes each of them", async () => {
		const a = grok("grok-routes");
		const { service } = setup([a], gated());
		await service.refresh(a);
		expect([...(await service.permissions(a)).discovered_ids].sort()).toEqual(
			[...PUBLISHED].sort(),
		);
		for (const id of PUBLISHED)
			expect(await permitted(service, a, id)).toBe(true);
	});

	it("refuses the served-only grok-4.6-build name after discovery", async () => {
		// xAI answers a grok-4.6 request under the name grok-4.6-build, but a
		// request that NAMES grok-4.6-build is a 404. Permitting it would route
		// clients into that 404.
		const a = grok("grok-served-name");
		const { service } = setup([a], gated());
		await service.refresh(a);
		expect(await permitted(service, a, "grok-4.6")).toBe(true);
		expect((await service.permissions(a)).discovered_ids).not.toContain(
			"grok-4.6-build",
		);
		expect(await permitted(service, a, "grok-4.6-build")).toBe(false);
	});

	it("refuses an id in neither the discovered nor the manual set, and admits a manual one", async () => {
		const a = grok("grok-unlisted");
		const { repo, service } = setup([a], gated());
		await repo.setManualModels(a.id, modelPermissionScope(a), [
			"grok-manual-extra",
		]);
		await service.refresh(a);
		expect(await permitted(service, a, "grok-4.3")).toBe(false);
		expect(await permitted(service, a, "grok-4.20-0309-reasoning")).toBe(false);
		expect(await permitted(service, a, "grok-manual-extra")).toBe(true);
	});

	it("drops a model the catalogue stops publishing while keeping manual ids", async () => {
		const a = grok("grok-removal");
		let ids: readonly string[] = PUBLISHED;
		const { repo, service } = setup(
			[a],
			gated(() => ids),
		);
		await repo.setManualModels(a.id, modelPermissionScope(a), ["grok-manual"]);
		await service.refresh(a, true);
		expect(await permitted(service, a, "grok-4.5")).toBe(true);
		ids = PUBLISHED.filter((id) => id !== "grok-4.5");
		await service.refresh(a, true);
		expect(await permitted(service, a, "grok-4.5")).toBe(false);
		expect(await permitted(service, a, "grok-4.7")).toBe(true);
		expect(await permitted(service, a, "grok-manual")).toBe(true);
	});

	it("records an empty catalogue as known-empty and leaves manual ids routable", async () => {
		const a = grok("grok-empty");
		const { repo, service } = setup(
			[a],
			gated(() => []),
		);
		await repo.setManualModels(a.id, modelPermissionScope(a), ["grok-manual"]);
		await service.refresh(a);
		expect(await repo.getPermissions(a.id)).toMatchObject({
			discovered_ids: [],
			completeness: "known-empty",
			last_error: null,
		});
		expect(await permitted(service, a, "grok-manual")).toBe(true);
		expect(await permitted(service, a, "grok-4.7")).toBe(false);
	});

	it("answers a bare-bearer request with 426, which discovery records as a failure", async () => {
		// The gate stub must actually gate, or the header assertions above prove
		// nothing: a bearer on its own is the 426 case.
		const gate = gated();
		const bare = await gate("https://cli-chat-proxy.grok.com/v1/models", {
			headers: { authorization: "Bearer grok-oauth-token" },
		});
		expect(bare.status).toBe(426);

		// And a 426 during discovery (the proxy raising its version floor) is a
		// recorded failure that keeps the last good catalogue, not a silent no-op.
		const a = grok("grok-426");
		let raised = false;
		const { repo, service } = setup([a], async (input, init) =>
			raised
				? new Response(
						"Your Grok CLI is out of date. Please update to version 9.9.9 or later.",
						{ status: 426 },
					)
				: gate(input, init),
		);
		await service.refresh(a, true);
		raised = true;
		await service.refresh(a, true);
		const permissions = await repo.getPermissions(a.id);
		expect(permissions?.last_error).not.toBeNull();
		expect(permissions?.completeness).toBe("known-complete");
		expect([...(permissions?.discovered_ids ?? [])].sort()).toEqual(
			[...PUBLISHED].sort(),
		);
	});

	it("ignores a stored custom endpoint rather than sending the bearer to it", async () => {
		// The provider pins its endpoint (honoursCustomEndpoint is false), so a
		// stored value is inert for inference and must be inert here too: neither
		// a credential redirect nor a reason to refuse discovery.
		const a = grok("grok-endpoint", {
			custom_endpoint: "https://attacker.example/v1",
		});
		const hosts: string[] = [];
		const gate = gated();
		const { service } = setup([a], async (input, init) => {
			hosts.push(new URL(String(input)).hostname);
			return gate(input, init);
		});
		await service.refresh(a);
		expect(hosts).toEqual(["cli-chat-proxy.grok.com"]);
		expect(await permitted(service, a, "grok-4.7")).toBe(true);
	});

	it("leaves the metered grok provider on api.x.ai without the CLI identity", async () => {
		const a = account("grok-metered", {
			provider: "grok",
			api_key: "xai-key",
			custom_endpoint: null,
		});
		const seen: { url: string; headers: Headers }[] = [];
		const { service } = setup([a], async (input, init) => {
			seen.push({ url: String(input), headers: new Headers(init?.headers) });
			return Response.json({ object: "list", data: [{ id: "grok-4.6" }] });
		});
		await service.refresh(a);
		expect(seen[0].url).toBe("https://api.x.ai/v1/models");
		for (const name of Object.keys(GROK_CLI_IDENTITY_HEADERS))
			expect(seen[0].headers.has(name)).toBe(false);
	});
});
