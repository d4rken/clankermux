import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import {
	BunSqlAdapter,
	ensureSchema,
	RoutingRepository,
} from "@clankermux/database";
import type { Account } from "@clankermux/types";
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
		requestBudgetMs: 25,
		backgroundBudgetMs: 40,
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
