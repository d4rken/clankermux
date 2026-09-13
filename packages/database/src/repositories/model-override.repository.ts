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

/**
 * The retired operator curation of `GET /v1/models`, per wire dialect.
 *
 * Rows describe DIFFERENCES from the upstream baseline (hide, rename, add), so
 * an empty table means "serve exactly what upstream says" — the state every
 * install started in.
 *
 * READ-ONLY. Catalogues are per client now and nothing writes here any more.
 * The rows are kept for one purpose: the pre-2026.9.52 client-catalogue
 * backfill replays them so an upgrading operator's curation survives into the
 * per-client profiles.
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
}
