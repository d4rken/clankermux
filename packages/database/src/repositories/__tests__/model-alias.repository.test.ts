import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ModelAlias } from "@clankermux/types";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import {
	ModelAliasConflictError,
	ModelAliasRepository,
} from "../model-alias.repository";
import { RoutingRepository } from "../routing.repository";

const alias = (): ModelAlias => ({
	id: "alias:good",
	displayName: "Good",
	revision: 0,
	targets: [{ model: "gpt-6-astra", accountIds: null }],
});

describe("model alias storage", () => {
	let db: Database;
	let repo: ModelAliasRepository;
	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		repo = new ModelAliasRepository(new BunSqlAdapter(db));
	});
	afterEach(() => db.close());
	it("increments revisions and rejects stale edits and deletes atomically", async () => {
		const first = await repo.save(alias());
		expect(first.revision).toBe(1);
		const second = await repo.save({
			...first,
			targets: [
				...first.targets,
				{ model: "claude-fable-5", accountIds: null },
			],
		});
		expect(second.revision).toBe(2);
		await expect(
			repo.save({ ...first, displayName: "stale" }),
		).rejects.toBeInstanceOf(ModelAliasConflictError);
		await expect(repo.remove(first.id, first.revision)).rejects.toBeInstanceOf(
			ModelAliasConflictError,
		);
		expect(await repo.get(first.id)).toEqual(second);
		expect(await repo.list()).toEqual([second]);
		await repo.remove(second.id, second.revision);
		expect(await repo.get(second.id)).toBeNull();
	});
	it("requires real account destinations and blocks removing referenced accounts", async () => {
		const input = {
			...alias(),
			targets: [{ model: "gpt-6-astra", accountIds: ["a"] }],
		};
		await expect(repo.save(input)).rejects.toThrow("missing account");
		db.run(
			"INSERT INTO accounts(id,name,provider,refresh_token,created_at) VALUES('a','Account A','codex','',0)",
		);
		await repo.save(input);
		expect(() => db.run("DELETE FROM accounts WHERE id='a'")).toThrow(
			"model aliases",
		);
	});
	it("protects directly published aliases even without an owned routing rule", async () => {
		const saved = await repo.save(alias());
		db.run(
			"INSERT INTO api_keys(id,name,hashed_key,prefix_last_8,created_at,is_active) VALUES('key','Client','hash','last8',0,1)",
		);
		const catalogues = {
			openai: {
				models: [
					{
						id: saved.id,
						targetModel: saved.id,
						displayName: saved.displayName,
						accountIds: null,
					},
				],
				defaultModel: saved.id,
			},
		};
		db.query(
			"INSERT INTO client_profiles(api_key_id,application,revision,catalogues,notices) VALUES('key','generic',1,?,'[]')",
		).run(JSON.stringify(catalogues));
		await expect(repo.remove(saved.id, saved.revision)).rejects.toBeInstanceOf(
			ModelAliasConflictError,
		);
		await expect(repo.remove(saved.id, saved.revision)).rejects.toThrow(
			"client catalogues",
		);
		expect(() =>
			db.query("DELETE FROM model_aliases WHERE id=?").run(saved.id),
		).toThrow("client catalogues");
		db.run("DELETE FROM client_profiles");
		expect(await repo.remove(saved.id, saved.revision)).toBe(true);
	});
	it("rejects unknown routing targets and protects aliases referenced by routing rules", async () => {
		const routing = new RoutingRepository(new BunSqlAdapter(db));
		const rule = {
			id: "rule",
			name: "Good",
			enabled: true,
			position: 0,
			match_api_key_id: null,
			match_model_kind: "any" as const,
			match_model_value: null,
			pool_kind: "inherit" as const,
			pool_provider: null,
			pool_account_ids: null,
			target_kind: "literal" as const,
			target_model: alias().id,
		};
		await expect(routing.saveRule(rule)).rejects.toThrow("missing model alias");
		const saved = await repo.save(alias());
		await routing.saveRule(rule);
		await expect(repo.remove(saved.id, saved.revision)).rejects.toBeInstanceOf(
			ModelAliasConflictError,
		);
		expect(() => db.run("DELETE FROM model_aliases")).toThrow("routing rules");
		await routing.removeRule(rule.id);
		await repo.remove(saved.id, saved.revision);
	});
});
