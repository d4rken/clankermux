import type { OpenAiBucketObservationRow } from "@clankermux/types";
import { BaseRepository } from "./base.repository";

/**
 * Repository for `openai_bucket_observations` — the OpenAI-compatible
 * `x-ratelimit-*` bucket readings, one row per bucket per upstream attempt.
 *
 * Write-only by design at this stage; retention belongs to the cleanup worker.
 */
export class OpenAiBucketObservationRepository extends BaseRepository<OpenAiBucketObservationRow> {
	/**
	 * Insert one attempt's bucket readings as a single multi-row statement.
	 *
	 * Idempotent on (observation_id, bucket) via ON CONFLICT DO NOTHING.
	 * Deliberately NOT `INSERT OR IGNORE`, which would also swallow NOT NULL / FK
	 * violations.
	 */
	async insertMany(rows: OpenAiBucketObservationRow[]): Promise<void> {
		if (rows.length === 0) return;
		const values = rows
			.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.join(", ");
		const params: unknown[] = [];
		for (const row of rows) {
			params.push(
				row.observationId,
				row.requestId,
				row.accountId,
				row.source,
				row.bucket,
				row.requestStartedAt,
				row.observedAt,
				row.httpStatus,
				row.endpoint ?? null,
				// `?? null`, never `|| null`: a remaining of 0 is the most important
				// reading this table can carry.
				row.limitValue ?? null,
				row.remaining ?? null,
				row.resetRaw ?? null,
			);
		}
		await this.run(
			`
			INSERT INTO openai_bucket_observations (
				observation_id, request_id, account_id, source, bucket,
				request_started_at, observed_at, http_status, endpoint, limit_value,
				remaining, reset_raw
			)
			VALUES ${values}
			ON CONFLICT (observation_id, bucket) DO NOTHING
		`,
			params,
		);
	}
}
