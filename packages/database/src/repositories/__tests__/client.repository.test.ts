import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "@clankermux/core";
import type { ClientProfile } from "@clankermux/types";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { ClientRepository } from "../client.repository";

const profile = (id: string): ClientProfile => ({
	apiKeyId: id,
	application: "generic",
	revision: 1,
	catalogues: {
		anthropic: {
			models: [
				{
					id: "claude-test",
					displayName: "Claude",
					targetModel: "claude-test",
					accountIds: null,
				},
			],
			defaultModel: null,
		},
		openai: {
			models: [
				{
					id: "plain-test",
					displayName: "Plain",
					targetModel: "plain-test",
					accountIds: null,
				},
			],
			defaultModel: "plain-test",
		},
		codex: { models: [], defaultModel: null },
	},
	notices: [],
	global: null,
});
describe("independent client catalogues", () => {
	let db: Database;
	let repo: ClientRepository;
	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		repo = new ClientRepository(new BunSqlAdapter(db));
		for (const id of ["a", "b"])
			db.query(
				"INSERT INTO api_keys(id,name,hashed_key,prefix_last_8,created_at,is_active) VALUES(?,?,?,?,?,?)",
			).run(id, id, `hash-${id}`, id, 123, id === "a" ? 1 : 0);
	});
	afterEach(() => db.close());
	it("copies every format independently, including disabled keys, and preserves credentials", async () => {
		const keysBefore = db.query("SELECT * FROM api_keys ORDER BY id").all();
		expect(await repo.bootstrap([profile("a"), profile("b")])).toBe(true);
		// biome-ignore lint/style/noNonNullAssertion: bootstrap() inserted a profile for key a on the line above
		const a = (await repo.getProfile("a"))!;
		a.catalogues.openai.models = [];
		a.catalogues.openai.defaultModel = null;
		await repo.saveProfile(a, 1);
		expect((await repo.getProfile("a"))?.catalogues.openai.models).toEqual([]);
		expect((await repo.getProfile("b"))?.catalogues.openai.models[0]?.id).toBe(
			"plain-test",
		);
		expect(
			(await repo.getProfile("a"))?.catalogues.anthropic.models[0]?.id,
		).toBe("claude-test");
		expect(db.query("SELECT * FROM api_keys ORDER BY id").all()).toEqual(
			keysBefore,
		);
	});
	it("never recopies on restart, including an explicit empty catalogue", async () => {
		await repo.bootstrap([profile("a"), profile("b")]);
		// biome-ignore lint/style/noNonNullAssertion: bootstrap() inserted a profile for key a on the line above
		const a = (await repo.getProfile("a"))!;
		a.catalogues.anthropic.models = [];
		await repo.saveProfile(a, 1);
		expect(await repo.bootstrap([profile("a"), profile("b")])).toBe(false);
		expect((await repo.getProfile("a"))?.catalogues.anthropic.models).toEqual(
			[],
		);
	});
	it("rolls back all profiles and the marker if a key is missing", async () => {
		await expect(
			repo.bootstrap([profile("a"), profile("missing")]),
		).rejects.toThrow();
		expect(await repo.getProfile("a")).toBeNull();
		expect(await repo.isBootstrapped()).toBe(false);
	});
	it("rejects stale edits", async () => {
		await repo.bootstrap([profile("a"), profile("b")]);
		await repo.saveProfile(profile("a"), 1);
		await expect(repo.saveProfile(profile("a"), 1)).rejects.toThrow("changed");
	});
	it("claims the migration once under concurrent callers", async () => {
		expect(
			(
				await Promise.all([
					repo.bootstrap([profile("a"), profile("b")]),
					repo.bootstrap([profile("a"), profile("b")]),
				])
			).sort(),
		).toEqual([false, true]);
	});
});

describe("global catalogue storage", () => {
	let db: Database;
	let repo: ClientRepository;
	const adapter = () => new BunSqlAdapter(db);
	const catalogues = (ids: string[]) => ({
		anthropic: { models: [], defaultModel: null },
		openai: {
			models: ids.map((id) => ({
				id,
				displayName: id,
				targetModel: id,
				accountIds: null,
			})),
			defaultModel: ids[0] ?? null,
		},
		codex: { models: [], defaultModel: null },
	});
	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		repo = new ClientRepository(adapter());
		db.query(
			"INSERT INTO api_keys(id,name,hashed_key,prefix_last_8,created_at,is_active) VALUES('a','a','h','a',1,1)",
		).run();
	});
	afterEach(() => db.close());
	it("reads an empty revision 0 until the first save, then advances one revision per save", async () => {
		expect(await repo.getGlobal()).toEqual({
			revision: 0,
			catalogues: catalogues([]) as never,
		});
		repo.saveGlobalInTransaction(catalogues(["one"]), 0);
		expect((await repo.getGlobal()).revision).toBe(1);
		repo.saveGlobalInTransaction(catalogues(["one", "two"]), 1);
		const saved = await repo.getGlobal();
		expect(saved.revision).toBe(2);
		expect(saved.catalogues.openai.models.map((m) => m.id)).toEqual([
			"one",
			"two",
		]);
	});
	it("refuses a save made against a stale revision", async () => {
		repo.saveGlobalInTransaction(catalogues(["one"]), 0);
		expect(() => repo.saveGlobalInTransaction(catalogues([]), 0)).toThrow(
			"global catalogue changed",
		);
		expect(() => repo.saveGlobalInTransaction(catalogues([]), 5)).toThrow(
			"global catalogue changed",
		);
		expect((await repo.getGlobal()).revision).toBe(1);
	});
	it("round-trips a client's global state and lists subscribers", async () => {
		const global = {
			appliedRevision: 3,
			formats: {
				openai: {
					additions: [],
					removals: ["gone"],
					inheritDefault: true,
					defaultModel: null,
					skipped: [{ id: "x", reason: "why" }],
				},
			},
		};
		repo.insertInTransaction({ ...profile("a"), global });
		expect((await repo.getProfile("a"))?.global).toEqual(global);
		expect(await repo.subscribers()).toEqual(["a"]);
		repo.markGlobalAppliedInTransaction("a", 1, {
			...global,
			appliedRevision: 4,
		});
		const after = await repo.getProfile("a");
		expect(after?.global?.appliedRevision).toBe(4);
		expect(after?.revision).toBe(1);
		expect(() => repo.markGlobalAppliedInTransaction("a", 2, global)).toThrow(
			"Client changed",
		);
	});
	it("protects aliases and accounts the global catalogue names", () => {
		db.query(
			"INSERT INTO model_aliases(id,display_name,targets,revision) VALUES('alias:x','X','[]',1)",
		).run();
		db.query(
			"INSERT INTO accounts(id,name,provider,created_at) VALUES('acc','acc','codex',1)",
		).run();
		const entries = catalogues([]);
		entries.openai.models = [
			{
				id: "x",
				displayName: "x",
				targetModel: "alias:x",
				accountIds: null,
			},
			{
				id: "pinned",
				displayName: "pinned",
				targetModel: "other",
				accountIds: ["acc"] as never,
			},
		];
		repo.saveGlobalInTransaction(entries, 0);
		expect(() =>
			db.query("DELETE FROM model_aliases WHERE id='alias:x'").run(),
		).toThrow("referenced by the global catalogue");
		expect(() => db.query("DELETE FROM accounts WHERE id='acc'").run()).toThrow(
			"referenced by the global catalogue",
		);
		repo.saveGlobalInTransaction(catalogues([]), 1);
		db.query("DELETE FROM model_aliases WHERE id='alias:x'").run();
		db.query("DELETE FROM accounts WHERE id='acc'").run();
	});
});
