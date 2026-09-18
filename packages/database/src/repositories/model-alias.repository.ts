import { validateModelAlias } from "@clankermux/core";
import type { ModelAlias } from "@clankermux/types";
import type { BunSqlAdapter } from "../adapters/bun-sql-adapter";

type AliasRow = {
	id: string;
	display_name: string;
	targets: string;
	revision: number;
};
const decode = (row: AliasRow): ModelAlias =>
	validateModelAlias({
		id: row.id,
		displayName: row.display_name,
		targets: JSON.parse(row.targets),
		revision: row.revision,
	});

export class ModelAliasConflictError extends Error {}

export class ModelAliasRepository {
	constructor(private readonly adapter: BunSqlAdapter) {}

	async list(): Promise<ModelAlias[]> {
		return (
			await this.adapter.query<AliasRow>(
				"SELECT * FROM model_aliases ORDER BY id",
			)
		).map(decode);
	}
	async get(id: string): Promise<ModelAlias | null> {
		const row = await this.adapter.get<AliasRow>(
			"SELECT * FROM model_aliases WHERE id=?",
			[id],
		);
		return row ? decode(row) : null;
	}
	async save(input: ModelAlias): Promise<ModelAlias> {
		const alias = validateModelAlias(input);
		return this.adapter.runTransaction(() => {
			const db = this.adapter.getSQLiteDb();
			const current = db
				.query("SELECT revision FROM model_aliases WHERE id=?")
				.get(alias.id) as { revision: number } | null;
			if ((current?.revision ?? 0) !== alias.revision)
				throw new ModelAliasConflictError(
					"Model alias changed; reload before saving",
				);
			for (const target of alias.targets)
				for (const id of target.accountIds ?? [])
					if (!db.query("SELECT id FROM accounts WHERE id=?").get(id))
						throw new Error(`Model alias references missing account ${id}`);
			const revision = alias.revision + 1;
			db.query(`INSERT INTO model_aliases(id,display_name,targets,revision) VALUES(?,?,?,?)
				ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,targets=excluded.targets,revision=excluded.revision`).run(
				alias.id,
				alias.displayName,
				JSON.stringify(alias.targets),
				revision,
			);
			return { ...alias, revision };
		});
	}
	async remove(id: string, revision: number): Promise<boolean> {
		if (!Number.isSafeInteger(revision) || revision < 1)
			throw new Error("A positive alias revision is required to delete");
		return this.adapter.runTransaction(() => {
			const db = this.adapter.getSQLiteDb();
			const current = db
				.query("SELECT revision FROM model_aliases WHERE id=?")
				.get(id) as { revision: number } | null;
			if (!current) return false;
			if (current.revision !== revision)
				throw new ModelAliasConflictError(
					"Model alias changed; reload before deleting",
				);
			if (
				db
					.query(
						"SELECT id FROM routing_rules WHERE target_kind='literal' AND target_model=?",
					)
					.get(id)
			)
				throw new ModelAliasConflictError(
					"Model alias is referenced by routing rules; update those rules before deleting",
				);
			if (
				db
					.query(`SELECT 1 FROM client_profiles p, json_each(p.catalogues) c,
				json_each(json_extract(c.value,'$.models')) m
				WHERE json_extract(m.value,'$.targetModel')=?`)
					.get(id)
			)
				throw new ModelAliasConflictError(
					"Model alias is referenced by client catalogues; update those clients before deleting",
				);
			return (
				db
					.query("DELETE FROM model_aliases WHERE id=? AND revision=?")
					.run(id, revision).changes > 0
			);
		});
	}
}
