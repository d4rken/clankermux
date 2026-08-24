import type { UnifiedClaimObservationRow } from "@clankermux/types";
import { BaseRepository } from "./base.repository";

/**
 * Repository for the `unified_claim_observations` time-series — the per-claim
 * rate-limit readings a response carried, aligned to the request that received
 * them rather than to a sampler tick.
 *
 * Write-only by design at this stage: the series is being accumulated before
 * anything consumes it, and retention is owned by the cleanup worker (one
 * batched, slot-releasing pass over every retention-governed table), so there
 * is deliberately no prune method here.
 */
export class UnifiedClaimObservationRepository extends BaseRepository<UnifiedClaimObservationRow> {
	/**
	 * Insert one response's claim readings as a single multi-row statement.
	 *
	 * Idempotent on the (request_id, claim) primary key via ON CONFLICT DO
	 * NOTHING — the first reading recorded for a request is the one aligned with
	 * its response, so a duplicate write is dropped rather than allowed to
	 * overwrite it. Deliberately NOT `INSERT OR IGNORE`, which would additionally
	 * swallow NOT NULL / CHECK / FK violations: those are caller bugs and must
	 * fail visibly.
	 */
	async insertMany(rows: UnifiedClaimObservationRow[]): Promise<void> {
		if (rows.length === 0) return;
		const values = rows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
		const params: unknown[] = [];
		for (const row of rows) {
			params.push(
				row.requestId,
				row.accountId,
				row.source,
				row.requestStartedAt,
				row.observedAt,
				row.httpStatus,
				row.claim,
				row.status,
				row.utilization ?? null,
				row.resetAt ?? null,
			);
		}
		await this.run(
			`
			INSERT INTO unified_claim_observations (
				request_id, account_id, source, request_started_at, observed_at,
				http_status, claim, status, utilization, reset_at
			)
			VALUES ${values}
			ON CONFLICT (request_id, claim) DO NOTHING
		`,
			params,
		);
	}
}
