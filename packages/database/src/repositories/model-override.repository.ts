import { BaseRepository } from "./base.repository";

/** The wire dialects a model catalogue can be curated for. */
export type ModelOverrideDialect = "anthropic" | "openai";

/** One stored curation row, exactly as the table holds it. */
export interface ModelOverrideRow {
	dialect: ModelOverrideDialect;
	model_id: string;
	/** 1 removes a baseline entry from the served catalogue. */
	hidden: number;
	/** 1 adds an entry the baseline does not have. */
	custom: number;
	/** Overrides the shown name; null leaves the baseline's own name. */
	display_name: string | null;
	created_at: number;
	updated_at: number;
}

export interface ModelOverrideUpsert {
	dialect: ModelOverrideDialect;
	modelId: string;
	hidden: boolean;
	custom: boolean;
	displayName: string | null;
	now: number;
}

/**
 * The operator's curation of `GET /v1/models`, per wire dialect.
 *
 * Rows describe DIFFERENCES from the upstream baseline (hide, rename, add), so
 * an empty table means "serve exactly what upstream says" — the state every
 * install starts in and the one the wire route optimises for.
 */
export class ModelOverrideRepository extends BaseRepository<ModelOverrideRow> {
	/**
	 * Every row for one dialect, oldest first.
	 *
	 * The order is the insertion order of the custom entries, which is the order
	 * they are appended to the served catalogue in. `model_id` breaks ties so two
	 * rows written in the same millisecond still list deterministically.
	 */
	async listByDialect(
		dialect: ModelOverrideDialect,
	): Promise<ModelOverrideRow[]> {
		return this.query<ModelOverrideRow>(
			`SELECT dialect, model_id, hidden, custom, display_name, created_at, updated_at
			   FROM model_overrides
			  WHERE dialect = ?
			  ORDER BY created_at ASC, model_id ASC`,
			[dialect],
		);
	}

	/**
	 * Write one row, replacing the mutable fields of an existing one.
	 *
	 * `created_at` is deliberately NOT updated on conflict: it orders the custom
	 * entries in the served catalogue and in the dashboard list, so renaming an
	 * entry would otherwise jump it to the end of the list being edited.
	 */
	async upsert(input: ModelOverrideUpsert): Promise<void> {
		await this.run(
			`INSERT INTO model_overrides
			   (dialect, model_id, hidden, custom, display_name, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (dialect, model_id) DO UPDATE SET
			   hidden = excluded.hidden,
			   custom = excluded.custom,
			   display_name = excluded.display_name,
			   updated_at = excluded.updated_at`,
			[
				input.dialect,
				input.modelId,
				input.hidden ? 1 : 0,
				input.custom ? 1 : 0,
				input.displayName,
				input.now,
				input.now,
			],
		);
	}

	/** Drop one row. Returns false when there was nothing to drop. */
	async remove(
		dialect: ModelOverrideDialect,
		modelId: string,
	): Promise<boolean> {
		const changes = await this.runWithChanges(
			`DELETE FROM model_overrides WHERE dialect = ? AND model_id = ?`,
			[dialect, modelId],
		);
		return changes > 0;
	}
}
