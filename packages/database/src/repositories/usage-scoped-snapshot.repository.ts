import type {
	ScopedUsageSnapshotRow,
	ScopedUsageSnapshotSample,
} from "@clankermux/types";
import { BaseRepository } from "./base.repository";

/**
 * Repository for the `usage_scoped_snapshots` time-series — an append-only
 * history of the PER-MODEL-FAMILY weekly windows the provider reports beside
 * the account-wide ones.
 *
 * Mirrors `UsageSnapshotRepository`: writes are idempotent on the
 * (account_id, sampled_at, family, display_name) primary key so a duplicate
 * tick is harmless, and reads return raw samples at their real sample time (no
 * bucketing — the series is consumed by analysis, not by a chart that needs
 * fixed buckets).
 *
 * `display_name` is in the key because the family mapping is lossy across
 * generations: "Claude Opus 4.8" and "Claude Opus 5" both resolve to `opus`, so
 * a narrower key would silently overwrite one of them with the other when a
 * single response scopes both.
 */
export class UsageScopedSnapshotRepository extends BaseRepository<ScopedUsageSnapshotRow> {
	/**
	 * Bulk-insert scoped snapshots. Upsert semantics on the
	 * (account_id, sampled_at, family, display_name) primary key: a duplicate
	 * tick overwrites the prior row rather than erroring.
	 */
	async insertSnapshots(rows: ScopedUsageSnapshotRow[]): Promise<void> {
		if (rows.length === 0) return;
		for (const row of rows) {
			await this.run(
				`
				INSERT INTO usage_scoped_snapshots (
					account_id, sampled_at, family, display_name, pct, reset_at
				)
				VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT (account_id, sampled_at, family, display_name) DO UPDATE SET
					pct = EXCLUDED.pct,
					reset_at = EXCLUDED.reset_at
			`,
				[
					row.accountId,
					row.sampledAt,
					row.family,
					row.displayName,
					row.pct ?? null,
					row.resetAt ?? null,
				],
			);
		}
	}

	/**
	 * Read RAW scoped snapshots for the given accounts with
	 * `sampled_at >= sinceMs`, ordered `account_id, sampled_at, family`. Empty
	 * `accountIds` short-circuits to `[]` (no query).
	 */
	async getRecentSnapshotsForAccounts(
		accountIds: string[],
		sinceMs: number,
	): Promise<ScopedUsageSnapshotSample[]> {
		if (accountIds.length === 0) return [];
		const placeholders = accountIds.map(() => "?").join(", ");
		const rows = await this.query<{
			account_id: string;
			sampled_at: number;
			family: string;
			display_name: string;
			pct: number | null;
			reset_at: number | null;
		}>(
			`SELECT account_id, sampled_at, family, display_name, pct, reset_at
			 FROM usage_scoped_snapshots
			 WHERE account_id IN (${placeholders}) AND sampled_at >= ?
			 ORDER BY account_id, sampled_at, family`,
			[...accountIds, sinceMs],
		);

		return rows.map((row) => ({
			accountId: row.account_id,
			sampledAt: Number(row.sampled_at),
			family: row.family,
			displayName: row.display_name,
			pct: row.pct == null ? null : Number(row.pct),
			resetAt: row.reset_at == null ? null : Number(row.reset_at),
		}));
	}

	/**
	 * Delete scoped snapshots strictly older than `cutoffMs`. Returns rows
	 * deleted. Shares the `usage_snapshot_retention_days` knob with
	 * `usage_snapshots` — one control for one series family.
	 */
	async deleteOlderThan(cutoffMs: number): Promise<number> {
		return this.runWithChanges(
			`DELETE FROM usage_scoped_snapshots WHERE sampled_at < ?`,
			[cutoffMs],
		);
	}
}
