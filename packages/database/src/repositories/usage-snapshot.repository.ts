import type { RankedSnapshot, UsageSnapshotRow } from "@clankermux/types";
import { BaseRepository } from "./base.repository";

/**
 * Repository for the `usage_snapshots` time-series — an append-only history of
 * per-account rate-limit utilization that backs the dashboard "sawtooth" graph.
 *
 * Reads are bucketed last-value-per-bucket (see `getSnapshots`); writes are
 * idempotent on (account_id, sampled_at) so a duplicate tick is harmless.
 */
export class UsageSnapshotRepository extends BaseRepository<UsageSnapshotRow> {
	/**
	 * Bulk-insert snapshots. Upsert semantics on the (account_id, sampled_at)
	 * primary key: a duplicate tick overwrites the prior row rather than
	 * erroring. Matches the ON CONFLICT DO UPDATE style used by the request
	 * repository.
	 */
	async insertSnapshots(rows: UsageSnapshotRow[]): Promise<void> {
		if (rows.length === 0) return;
		for (const row of rows) {
			await this.run(
				`
				INSERT INTO usage_snapshots (
					account_id, provider, sampled_at,
					five_hour_pct, five_hour_reset, seven_day_pct, seven_day_reset
				)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (account_id, sampled_at) DO UPDATE SET
					provider = EXCLUDED.provider,
					five_hour_pct = EXCLUDED.five_hour_pct,
					five_hour_reset = EXCLUDED.five_hour_reset,
					seven_day_pct = EXCLUDED.seven_day_pct,
					seven_day_reset = EXCLUDED.seven_day_reset
			`,
				[
					row.accountId,
					row.provider ?? null,
					row.sampledAt,
					row.fiveHourPct ?? null,
					row.fiveHourReset ?? null,
					row.sevenDayPct ?? null,
					row.sevenDayReset ?? null,
				],
			);
		}
	}

	/**
	 * Read the last value per (account, time bucket) since `sinceMs`. Buckets are
	 * `bucketMs`-wide windows aligned to the epoch; within each bucket the row
	 * with the greatest `sampled_at` wins. Uses a window-function CTE
	 * (modern SQLite).
	 */
	async getSnapshots(opts: {
		sinceMs: number;
		bucketMs: number;
	}): Promise<RankedSnapshot[]> {
		const { sinceMs, bucketMs } = opts;
		const rows = await this.query<{
			account_id: string;
			provider: string | null;
			ts: number;
			five_hour_pct: number | null;
			seven_day_pct: number | null;
			five_hour_reset: number | null;
			seven_day_reset: number | null;
		}>(
			`
			WITH bucketed AS (
				SELECT account_id, provider,
				       (sampled_at / ?) * ? AS ts,
				       sampled_at, five_hour_pct, seven_day_pct, five_hour_reset, seven_day_reset
				FROM usage_snapshots
				WHERE sampled_at >= ?
			),
			ranked AS (
				SELECT *, ROW_NUMBER() OVER (PARTITION BY account_id, ts ORDER BY sampled_at DESC) AS rn
				FROM bucketed
			)
			SELECT account_id, provider, ts, five_hour_pct, seven_day_pct, five_hour_reset, seven_day_reset
			FROM ranked WHERE rn = 1 ORDER BY ts, account_id;
		`,
			[bucketMs, bucketMs, sinceMs],
		);

		return rows.map((row) => ({
			accountId: row.account_id,
			provider: row.provider ?? null,
			ts: Number(row.ts),
			fiveHourPct: row.five_hour_pct == null ? null : Number(row.five_hour_pct),
			sevenDayPct: row.seven_day_pct == null ? null : Number(row.seven_day_pct),
			fiveHourReset:
				row.five_hour_reset == null ? null : Number(row.five_hour_reset),
			sevenDayReset:
				row.seven_day_reset == null ? null : Number(row.seven_day_reset),
		}));
	}

	/**
	 * Read the single most recent snapshot per account, for the given accounts.
	 * Backs the dashboard's "last known usage" fallback when the live usage
	 * cache has nothing (e.g. usage polling fails after a subscription lapses).
	 */
	async getLatestSnapshots(accountIds: string[]): Promise<RankedSnapshot[]> {
		if (accountIds.length === 0) return [];
		const placeholders = accountIds.map(() => "?").join(", ");
		const rows = await this.query<{
			account_id: string;
			provider: string | null;
			sampled_at: number;
			five_hour_pct: number | null;
			seven_day_pct: number | null;
			five_hour_reset: number | null;
			seven_day_reset: number | null;
		}>(
			`
			WITH ranked AS (
				SELECT *, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY sampled_at DESC) AS rn
				FROM usage_snapshots
				WHERE account_id IN (${placeholders})
			)
			SELECT account_id, provider, sampled_at, five_hour_pct, seven_day_pct, five_hour_reset, seven_day_reset
			FROM ranked WHERE rn = 1;
		`,
			accountIds,
		);

		return rows.map((row) => ({
			accountId: row.account_id,
			provider: row.provider ?? null,
			ts: Number(row.sampled_at),
			fiveHourPct: row.five_hour_pct == null ? null : Number(row.five_hour_pct),
			sevenDayPct: row.seven_day_pct == null ? null : Number(row.seven_day_pct),
			fiveHourReset:
				row.five_hour_reset == null ? null : Number(row.five_hour_reset),
			sevenDayReset:
				row.seven_day_reset == null ? null : Number(row.seven_day_reset),
		}));
	}

	/**
	 * Delete snapshots strictly older than `cutoffMs`. Returns rows deleted.
	 * Volume is tiny (a handful of accounts × a sample tick), so a single
	 * DELETE is sufficient — no batching needed.
	 */
	async deleteOlderThan(cutoffMs: number): Promise<number> {
		return this.runWithChanges(
			`DELETE FROM usage_snapshots WHERE sampled_at < ?`,
			[cutoffMs],
		);
	}
}
