import type { CodexWindowObservationRow } from "@clankermux/types";
import { BaseRepository } from "./base.repository";

/**
 * Repository for `codex_window_observations` — the RAW `x-codex-*` window lines
 * a response carried, one row per window slot per upstream attempt.
 *
 * Write-only by design at this stage, like the claim series: the data is being
 * accumulated before anything consumes it, and retention belongs to the cleanup
 * worker's single batched pass.
 */
export class CodexWindowObservationRepository extends BaseRepository<CodexWindowObservationRow> {
	/**
	 * Insert one attempt's window readings as a single multi-row statement.
	 *
	 * Idempotent on (observation_id, scope, family_codename, slot) via ON CONFLICT
	 * DO NOTHING — the first reading recorded for an attempt is the one aligned
	 * with its response. Deliberately NOT `INSERT OR IGNORE`, which would also
	 * swallow NOT NULL / FK violations: those are caller bugs and must fail
	 * visibly.
	 */
	async insertMany(rows: CodexWindowObservationRow[]): Promise<void> {
		if (rows.length === 0) return;
		const values = rows
			.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.join(", ");
		const params: unknown[] = [];
		for (const row of rows) {
			params.push(
				row.observationId,
				row.requestId,
				row.accountId,
				row.source,
				row.httpStatus,
				row.requestStartedAt,
				row.observedAt,
				row.scope,
				// The EMPTY STRING on root rows, never null — see the column comment
				// in migrations.ts for why the UNIQUE binding depends on it.
				row.familyCodename,
				row.slot,
				row.limitName ?? null,
				// `?? null`, never `|| null`: a reported 0% is a reading.
				row.usedPercent ?? null,
				row.windowMinutes ?? null,
				row.resetAt ?? null,
				row.activeLimit ?? null,
			);
		}
		await this.run(
			`
			INSERT INTO codex_window_observations (
				observation_id, request_id, account_id, source, http_status,
				request_started_at, observed_at, scope, family_codename, slot,
				limit_name, used_percent, window_minutes, reset_at, active_limit
			)
			VALUES ${values}
			ON CONFLICT (observation_id, scope, family_codename, slot) DO NOTHING
		`,
			params,
		);
	}
}
