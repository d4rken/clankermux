import type { InternalDispatchSpendRow } from "@clankermux/types";
import { BaseRepository } from "./base.repository";

/**
 * Repository for `internal_dispatch_spend` — the per-dispatch token vectors of
 * the proxy's own upstream traffic (cache-keepalive replays, auto-refresh
 * probes), which `shouldRecordRequest` keeps out of `requests`.
 *
 * Write-only by design at this stage, like the claim-observation series: the
 * data is being accumulated before anything consumes it, and retention belongs
 * to the cleanup worker's single batched pass, so there is deliberately no
 * prune method here.
 */
export class InternalDispatchSpendRepository extends BaseRepository<InternalDispatchSpendRow> {
	/**
	 * Insert one dispatch's spend row.
	 *
	 * Idempotent on the `id` primary key via ON CONFLICT DO NOTHING — the first
	 * row recorded for a dispatch is the one aligned with its response, so a
	 * duplicate write is dropped rather than allowed to overwrite it.
	 * Deliberately NOT `INSERT OR IGNORE`, which would additionally swallow NOT
	 * NULL / FK violations: those are caller bugs and must fail visibly.
	 */
	async insert(row: InternalDispatchSpendRow): Promise<void> {
		await this.run(
			`
			INSERT INTO internal_dispatch_spend (
				id, account_id, source, model, http_status, started_at, completed_at,
				input_tokens, output_tokens, cache_read_input_tokens,
				cache_creation_input_tokens
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO NOTHING
		`,
			[
				row.id,
				row.accountId,
				row.source,
				row.model ?? null,
				row.httpStatus,
				row.startedAt,
				row.completedAt ?? null,
				// `?? null`, never `|| null`: a reported 0 is a reading and must stay
				// distinct from "no usage on the response".
				row.inputTokens ?? null,
				row.outputTokens ?? null,
				row.cacheReadInputTokens ?? null,
				row.cacheCreationInputTokens ?? null,
			],
		);
	}
}
