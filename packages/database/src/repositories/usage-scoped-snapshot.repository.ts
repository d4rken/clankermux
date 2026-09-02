import type {
	RankedScopedSnapshot,
	ScopedUsageSnapshotRow,
	ScopedUsageSnapshotSample,
} from "@clankermux/types";
import { BaseRepository } from "./base.repository";

/**
 * Tie-break order within one (account, family) partition.
 *
 * Latest sample first. Within a single tick a family can carry two rows (two
 * display names folding onto one family), and the one that BINDS is the
 * highest percent, then the earliest reset — the same rule the live view uses
 * to pick an account's binding scoped limit, so the recorded line and the
 * dashed forecast describe the same window. Display name last so the pick is
 * deterministic even for two structurally identical rows; the `pct IS NULL` /
 * `reset_at IS NULL` guards keep a reported value ahead of an absent one
 * (SQLite sorts NULL first on a plain DESC).
 */
const SCOPED_BINDING_ORDER = `sampled_at DESC, (pct IS NULL), pct DESC, (reset_at IS NULL), reset_at ASC, display_name ASC`;

function mapRankedScopedRow(row: {
	account_id: string;
	ts: number;
	sampled_at: number;
	family: string;
	display_name: string;
	pct: number | null;
	reset_at: number | null;
}): RankedScopedSnapshot {
	return {
		accountId: row.account_id,
		ts: Number(row.ts),
		sampledAt: Number(row.sampled_at),
		family: row.family,
		displayName: row.display_name,
		pct: row.pct == null ? null : Number(row.pct),
		resetAt: row.reset_at == null ? null : Number(row.reset_at),
	};
}

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
	 * Read the winning value per (account, family, time bucket) since
	 * `sinceMs` — the scoped analogue of
	 * `UsageSnapshotRepository.getSnapshots`, with the family axis added to the
	 * partition. Buckets are `bucketMs`-wide windows aligned to the epoch.
	 *
	 * No family predicate: the caller shapes EVERY recorded family in one pass,
	 * so the existing `sampled_at` index covers the scan and no new index is
	 * needed.
	 *
	 * `sampledAt` carries the winning row's real sample time beside the bucket
	 * start, so a caller comparing recency across accounts in one bucket (the
	 * family display name) is not left ranking identical bucket timestamps.
	 */
	async getBucketedSnapshots(opts: {
		sinceMs: number;
		bucketMs: number;
	}): Promise<RankedScopedSnapshot[]> {
		const { sinceMs, bucketMs } = opts;
		const rows = await this.query<{
			account_id: string;
			ts: number;
			sampled_at: number;
			family: string;
			display_name: string;
			pct: number | null;
			reset_at: number | null;
		}>(
			`
			WITH bucketed AS (
				SELECT account_id, family, display_name, pct, reset_at, sampled_at,
				       (sampled_at / ?) * ? AS ts
				FROM usage_scoped_snapshots
				WHERE sampled_at >= ?
			),
			ranked AS (
				SELECT *, ROW_NUMBER() OVER (
					PARTITION BY account_id, family, ts
					ORDER BY ${SCOPED_BINDING_ORDER}
				) AS rn
				FROM bucketed
			)
			SELECT account_id, ts, sampled_at, family, display_name, pct, reset_at
			FROM ranked WHERE rn = 1 ORDER BY ts, family, account_id;
		`,
			[bucketMs, bucketMs, sinceMs],
		);

		return rows.map(mapRankedScopedRow);
	}

	/**
	 * Read the single most recent row per (account, family) with
	 * `sampled_at < beforeMs` — the value that was in force when a chart range
	 * BEGINS, so an account last sampled just before the range start is not
	 * missing from the whole range.
	 *
	 * `ts` carries the row's real `sampled_at`, not a bucket start: this row
	 * lies outside the grid by construction, and the caller expires the carried
	 * value from its true sample time.
	 */
	async getLatestSnapshotsBefore(
		beforeMs: number,
	): Promise<RankedScopedSnapshot[]> {
		const rows = await this.query<{
			account_id: string;
			ts: number;
			sampled_at: number;
			family: string;
			display_name: string;
			pct: number | null;
			reset_at: number | null;
		}>(
			`
			WITH ranked AS (
				SELECT *, ROW_NUMBER() OVER (
					PARTITION BY account_id, family
					ORDER BY ${SCOPED_BINDING_ORDER}
				) AS rn
				FROM usage_scoped_snapshots
				WHERE sampled_at < ?
			)
			SELECT account_id, sampled_at AS ts, sampled_at, family, display_name, pct, reset_at
			FROM ranked WHERE rn = 1 ORDER BY family, account_id;
		`,
			[beforeMs],
		);

		return rows.map(mapRankedScopedRow);
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
