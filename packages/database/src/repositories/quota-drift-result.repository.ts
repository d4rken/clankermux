import { BaseRepository } from "./base.repository";

/** One stored precompute pass. */
export interface QuotaDriftResultRow {
	/** When the pass completed, ms since epoch. */
	computedAt: number;
	/** The serialized `QuotaDriftResponse` payload, verbatim. */
	payload: string;
}

/**
 * Repository for `quota_drift_results` — the precomputed quota-drift payload.
 *
 * A CACHE, not a record: the payload is a pure function of `usage_snapshots`
 * and `requests`, so losing every row costs one scheduler tick. Nothing queries
 * INTO the blob; the endpoint hands the newest one to the dashboard verbatim,
 * which is why there is a `getLatest` and no filtered read.
 *
 * Pruning is NOT this repository's job — the off-thread cleanup pass keeps the
 * newest few rows. Writers therefore only ever insert.
 */
export class QuotaDriftResultRepository extends BaseRepository<QuotaDriftResultRow> {
	/**
	 * Store one completed pass. Upserts on `computed_at` so two passes that
	 * somehow land on the same millisecond replace rather than error — the
	 * payload is derived data, so the later one is simply the answer.
	 */
	async insertResult(row: QuotaDriftResultRow): Promise<void> {
		await this.run(
			`INSERT INTO quota_drift_results (computed_at, payload)
			 VALUES (?, ?)
			 ON CONFLICT (computed_at) DO UPDATE SET payload = EXCLUDED.payload`,
			[row.computedAt, row.payload],
		);
	}

	/** The newest stored pass, or null when none has completed yet. */
	async getLatest(): Promise<QuotaDriftResultRow | null> {
		const row = await this.get<{ computed_at: number; payload: string }>(
			`SELECT computed_at, payload FROM quota_drift_results
			 ORDER BY computed_at DESC LIMIT 1`,
		);
		if (!row) return null;
		return { computedAt: Number(row.computed_at), payload: row.payload };
	}
}
