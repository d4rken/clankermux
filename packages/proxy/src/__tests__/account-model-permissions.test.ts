import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
	BunSqlAdapter,
	ensureSchema,
	RoutingRepository,
} from "@clankermux/database";
import type { Account } from "@clankermux/types";
import {
	ClientModelConfigSchema,
	GetCliModelConfigsResponseSchema,
	GetUserJwtResponseSchema,
	GetUserStatusResponseSchema,
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
