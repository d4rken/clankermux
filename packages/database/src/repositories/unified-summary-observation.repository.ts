import type { UnifiedSummaryObservationRow } from "@clankermux/types";
import { BaseRepository } from "./base.repository";

/**
 * Repository for `unified_summary_observations` — the SUMMARY-level unified
 * rate-limit block a response carried, aligned to the request that received it.
 *
 * Sibling of {@link UnifiedClaimObservationRepository}: one row per response
 * rather than one per claim line, and written even when the response carried no
 * claim lines at all (a per-IP burst 429 carries a bare `retry-after`).
 *
 * Write-only by design at this stage; retention is owned by the cleanup
 * worker's batched pass, so there is deliberately no prune method here.
 */
export class UnifiedSummaryObservationRepository extends BaseRepository<UnifiedSummaryObservationRow> {
	/**
	 * Insert one response's summary reading.
	 *
	 * Idempotent on the `request_id` primary key via ON CONFLICT DO NOTHING —
	 * the first reading recorded for a request is the one aligned with its
	 * response. Deliberately NOT `INSERT OR IGNORE`, which would also swallow
	 * NOT NULL / FK violations.
	 */
	async insert(row: UnifiedSummaryObservationRow): Promise<void> {
		await this.run(
			`
			INSERT INTO unified_summary_observations (
				request_id, account_id, source, http_status, request_started_at,
				observed_at, status, reset_at, remaining, representative_claim,
				fallback, fallback_percentage, overage_status,
				overage_disabled_reason, retry_after
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (request_id) DO NOTHING
		`,
			[
				row.requestId,
				row.accountId,
				row.source,
				row.httpStatus,
				row.requestStartedAt,
				row.observedAt,
				row.status ?? null,
				row.resetAt ?? null,
				row.remaining ?? null,
				row.representativeClaim ?? null,
				row.fallback ?? null,
				// `?? null`, never `|| null`: a reported 0 is a reading.
				row.fallbackPercentage ?? null,
				row.overageStatus ?? null,
				row.overageDisabledReason ?? null,
				row.retryAfter ?? null,
			],
		);
	}
}
