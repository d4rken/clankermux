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
