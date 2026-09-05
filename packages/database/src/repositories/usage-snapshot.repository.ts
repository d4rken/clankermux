import type {
	RankedSnapshot,
	UsageSnapshotRow,
	UsageSnapshotSample,
} from "@clankermux/types";
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
					five_hour_pct, five_hour_reset, seven_day_pct, seven_day_reset,
					observed_at, plan_tier, rate_limit_tier
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (account_id, sampled_at) DO UPDATE SET
					provider = EXCLUDED.provider,
					five_hour_pct = EXCLUDED.five_hour_pct,
					five_hour_reset = EXCLUDED.five_hour_reset,
					seven_day_pct = EXCLUDED.seven_day_pct,
					seven_day_reset = EXCLUDED.seven_day_reset,
					observed_at = EXCLUDED.observed_at,
					plan_tier = EXCLUDED.plan_tier,
					rate_limit_tier = EXCLUDED.rate_limit_tier
			`,
				[
					row.accountId,
					row.provider ?? null,
					row.sampledAt,
					row.fiveHourPct ?? null,
					row.fiveHourReset ?? null,
					row.sevenDayPct ?? null,
					row.sevenDayReset ?? null,
					row.observedAt ?? null,
					row.planTier ?? null,
					row.rateLimitTier ?? null,
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
	 * Per-account PEAK (MAX) utilization since `sinceMs` — the true high-water mark
	 * over the window, computed in SQL so it captures spikes that reset before a
	 * bucket's final sample (which a last-value-per-bucket read would miss). Used by
	 * the cache-effectiveness report. Accounts with no samples in the window are
	 * absent from the result.
	 */
	async getPeaksSince(sinceMs: number): Promise<
		Array<{
			accountId: string;
			peakFiveHourPct: number;
			peakSevenDayPct: number;
		}>
	> {
		const rows = await this.query<{
			account_id: string;
			peak_five_hour: number | null;
			peak_seven_day: number | null;
		}>(
			`SELECT account_id,
			        MAX(five_hour_pct) AS peak_five_hour,
			        MAX(seven_day_pct) AS peak_seven_day
			 FROM usage_snapshots
			 WHERE sampled_at >= ?
			 GROUP BY account_id`,
			[sinceMs],
		);
		return rows.map((row) => ({
			accountId: row.account_id,
			peakFiveHourPct:
				row.peak_five_hour == null ? 0 : Number(row.peak_five_hour),
			peakSevenDayPct:
				row.peak_seven_day == null ? 0 : Number(row.peak_seven_day),
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
	 * Read the single most recent snapshot per account with
	 * `sampled_at < beforeMs` — the row that was in force when a chart range
	 * BEGINS. Without it an account whose last sample fell just before the range
	 * start is absent from the whole range, even though its value (and the
	 * window it belongs to) still held there.
	 *
	 * `ts` carries the row's real `sampled_at`, not a bucket start: the caller
	 * needs the true sample time to expire the carried value at the right
	 * moment, and this row is by definition outside the bucket grid.
	 *
	 * `lookbackMs` bounds the scan to `[beforeMs - lookbackMs, beforeMs)` and is
	 * lossless when it is at least one nominal window: a reading sampled longer
	 * than that before the cutoff has expired by then (at its own reset, or at
	 * `sampled_at + nominal` when it carries none), so it cannot be in force at
	 * the range start and there is no point ranking it. Unbounded, this ranks
	 * every row in retention — 0.5s on a 180k-row table, per open panel, per
	 * minute — and gets slower as history grows.
	 */
	async getLatestSnapshotsBefore(
		beforeMs: number,
		lookbackMs: number,
	): Promise<RankedSnapshot[]> {
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
				WHERE sampled_at < ? AND sampled_at >= ?
			)
			SELECT account_id, provider, sampled_at, five_hour_pct, seven_day_pct, five_hour_reset, seven_day_reset
			FROM ranked WHERE rn = 1 ORDER BY account_id;
		`,
			[beforeMs, beforeMs - lookbackMs],
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
	 * Read RAW (un-bucketed) snapshot rows for the given accounts with
	 * `sampled_at >= sinceMs`, ordered `account_id, sampled_at`. Unlike
	 * `getSnapshots`, this returns every stored sample at its real sample time
	 * (no last-value-per-bucket collapsing), so a prediction service can build
	 * per-window time series. The (account_id, sampled_at) primary key makes the
	 * `IN (...) AND sampled_at >= ?` range scan efficient. Empty `accountIds`
	 * short-circuits to `[]` (no query).
	 */
	async getRecentSnapshotsForAccounts(
		accountIds: string[],
		sinceMs: number,
	): Promise<UsageSnapshotSample[]> {
		if (accountIds.length === 0) return [];
		const placeholders = accountIds.map(() => "?").join(", ");
		const rows = await this.query<{
			account_id: string;
			provider: string | null;
			sampled_at: number;
			five_hour_pct: number | null;
			five_hour_reset: number | null;
			seven_day_pct: number | null;
			seven_day_reset: number | null;
			observed_at: number | null;
			plan_tier: string | null;
			rate_limit_tier: string | null;
		}>(
			`SELECT account_id, provider, sampled_at,
			        five_hour_pct, five_hour_reset, seven_day_pct, seven_day_reset,
			        observed_at, plan_tier, rate_limit_tier
			 FROM usage_snapshots
			 WHERE account_id IN (${placeholders}) AND sampled_at >= ?
			 ORDER BY account_id, sampled_at`,
			[...accountIds, sinceMs],
		);

		return rows.map((row) => ({
			accountId: row.account_id,
			provider: row.provider ?? null,
			sampledAt: Number(row.sampled_at),
			fiveHourPct: row.five_hour_pct == null ? null : Number(row.five_hour_pct),
			fiveHourReset:
				row.five_hour_reset == null ? null : Number(row.five_hour_reset),
			sevenDayPct: row.seven_day_pct == null ? null : Number(row.seven_day_pct),
			sevenDayReset:
				row.seven_day_reset == null ? null : Number(row.seven_day_reset),
			observedAt: row.observed_at == null ? null : Number(row.observed_at),
			planTier: row.plan_tier ?? null,
			rateLimitTier: row.rate_limit_tier ?? null,
		}));
	}

	/**
	 * Per `(account, reported weekly reset)` group since `sinceMs`, with the
	 * peak utilization reached under that reset and the percentages at the
	 * edges of the group.
	 *
	 * Backs the pool-sizing computation, which turns these groups into windows.
	 * The reset value is grouped RAW here, jitter and all: deciding which
	 * reported values are the same window is a rule with evidence behind it and
	 * belongs in one place in TypeScript, not encoded twice as SQL rounding.
	 *
	 * `first_pct` / `last_pct` are the percentages at the edges of the
	 * `(account, reset)` partition, computed by window functions in the same
	 * pass as the grouping. Correlated scalar subqueries would express the same
	 * values, but they re-scan the account's samples once per group and there
	 * is no covering index: on the live history that is thousands of Codex
	 * idle-creep groups and minutes of work, far past the worker timeout.
	 *
	 * The partition deliberately ignores the tier columns, so both halves of a
	 * group split by an identity-capture boundary report the edges of the WHOLE
	 * window rather than of their own half. `MIN` over a value that is constant
	 * within the partition merely carries it through the outer grouping.
	 *
	 * Tier columns join the GROUP BY so a window that spans the moment identity
	 * capture started reports both the null and the captured pair rather than
	 * one arbitrary row's value. The caller collapses them; it must never sum
	 * their percentages.
	 *
	 * Rows with no reported reset are excluded: they carry no window to attach
	 * consumption to, and the caller treats their absence as a blind spot.
	 */
	async getResetPeakRows(sinceMs: number): Promise<
		Array<{
			accountId: string;
			resetAt: number;
			peakPct: number | null;
			sampleCount: number;
			firstSampledAt: number;
			lastSampledAt: number;
			firstPct: number | null;
			lastPct: number | null;
			planTier: string | null;
			rateLimitTier: string | null;
		}>
	> {
		const rows = await this.query<{
			account_id: string;
			reset_at: number;
			peak_pct: number | null;
			sample_count: number;
			first_sampled_at: number;
			last_sampled_at: number;
			first_pct: number | null;
			last_pct: number | null;
			plan_tier: string | null;
			rate_limit_tier: string | null;
		}>(
			`WITH scanned AS (
				SELECT account_id, seven_day_reset, seven_day_pct, sampled_at,
				       plan_tier, rate_limit_tier,
				       FIRST_VALUE(seven_day_pct) OVER w AS first_pct,
				       LAST_VALUE(seven_day_pct) OVER w AS last_pct
				FROM usage_snapshots
				WHERE sampled_at >= ? AND seven_day_reset IS NOT NULL
				WINDOW w AS (PARTITION BY account_id, seven_day_reset
				             ORDER BY sampled_at
				             ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
			)
			SELECT account_id,
			       seven_day_reset AS reset_at,
			       plan_tier,
			       rate_limit_tier,
			       MAX(seven_day_pct) AS peak_pct,
			       COUNT(*) AS sample_count,
			       MIN(sampled_at) AS first_sampled_at,
			       MAX(sampled_at) AS last_sampled_at,
			       MIN(first_pct) AS first_pct,
			       MIN(last_pct) AS last_pct
			 FROM scanned
			 GROUP BY account_id, seven_day_reset, plan_tier, rate_limit_tier`,
			[sinceMs],
		);
		return rows.map((row) => ({
			accountId: row.account_id,
			resetAt: Number(row.reset_at),
			peakPct: row.peak_pct == null ? null : Number(row.peak_pct),
			sampleCount: Number(row.sample_count),
			firstSampledAt: Number(row.first_sampled_at),
			lastSampledAt: Number(row.last_sampled_at),
			firstPct: row.first_pct == null ? null : Number(row.first_pct),
			lastPct: row.last_pct == null ? null : Number(row.last_pct),
			planTier: row.plan_tier ?? null,
			rateLimitTier: row.rate_limit_tier ?? null,
		}));
	}

	/**
	 * Per `(account, calendar day)`, the first and last sample time at which the
	 * account REPORTED THE WEEKLY WINDOW — was its weekly consumption being
	 * watched at all in a given span?
	 *
	 * Samples carrying no weekly window are excluded, for the same reason the
	 * reset-peak read excludes them: they attach consumption to nothing, so
	 * counting them as observation would turn an account whose weekly usage is
	 * unknown into an account measured at zero. A placeholder sample (0 % under
	 * a reset that never arrived) does report the window and still counts.
	 *
	 * Day buckets only bound the row count; the values returned are EXACT
	 * sample times, because the question the caller asks is whether the
	 * evidence overlaps a cycle span whose edges are not day-aligned.
	 */
	async getDailyPresence(sinceMs: number): Promise<
		Array<{
			accountId: string;
			firstSampledAt: number;
			lastSampledAt: number;
		}>
	> {
		const rows = await this.query<{
			account_id: string;
			first_sampled_at: number;
			last_sampled_at: number;
		}>(
			`SELECT account_id,
			        MIN(sampled_at) AS first_sampled_at,
			        MAX(sampled_at) AS last_sampled_at
			 FROM usage_snapshots
			 WHERE sampled_at >= ?
			   AND seven_day_reset IS NOT NULL
			   AND seven_day_pct IS NOT NULL
			 GROUP BY account_id, (sampled_at / 86400000)`,
			[sinceMs],
		);
		return rows.map((row) => ({
			accountId: row.account_id,
			firstSampledAt: Number(row.first_sampled_at),
			lastSampledAt: Number(row.last_sampled_at),
		}));
	}

	/**
	 * How many accounts of each provider were at 100% of their 5-hour window
	 * per sampler TICK.
	 *
	 * The sampler writes every account of a tick with one shared `sampled_at`,
	 * so grouping on it measures simultaneity rather than a rate: two accounts
	 * spent an hour apart are two ticks of one, not a burst of two.
	 */
	async getFiveHourSpentTicks(sinceMs: number): Promise<
		Array<{
			sampledAt: number;
			provider: string | null;
			spent: number;
		}>
	> {
		const rows = await this.query<{
			sampled_at: number;
			provider: string | null;
			spent: number;
		}>(
			`SELECT sampled_at, provider, COUNT(*) AS spent
			 FROM usage_snapshots
			 WHERE sampled_at >= ? AND five_hour_pct >= 100
			 GROUP BY sampled_at, provider`,
			[sinceMs],
		);
		return rows.map((row) => ({
			sampledAt: Number(row.sampled_at),
			provider: row.provider ?? null,
			spent: Number(row.spent),
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
