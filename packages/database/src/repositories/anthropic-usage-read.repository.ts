import { BaseRepository } from "./base.repository";

export interface AnthropicUsageReadRow {
	accountId: string;
	/** When the last `/api/oauth/usage` request for the account was sent. */
	lastReadAt: number | null;
	/** The last successful usage response body, as JSON. */
	reading: string | null;
	readingObservedAt: number | null;
}

type Row = {
	account_id: string;
	last_read_at: number | null;
	reading: string | null;
	reading_observed_at: number | null;
};

/**
 * Repository for `anthropic_usage_reads`: each account's last usage read and
 * last usage reading, so a restart keeps both. Writes skip an account that no
 * longer exists and never replace a value with an older one.
 */
export class AnthropicUsageReadRepository extends BaseRepository<AnthropicUsageReadRow> {
	async recordReadAt(accountId: string, at: number): Promise<void> {
		await this.run(
			`INSERT INTO anthropic_usage_reads (account_id, last_read_at)
			SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ?1)
			ON CONFLICT(account_id) DO UPDATE SET last_read_at = excluded.last_read_at
			WHERE last_read_at IS NULL OR excluded.last_read_at > last_read_at`,
			[accountId, at],
		);
	}

	async recordReading(
		accountId: string,
		reading: string,
		observedAt: number,
	): Promise<void> {
		await this.run(
			`INSERT INTO anthropic_usage_reads (account_id, reading, reading_observed_at)
			SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ?1)
			ON CONFLICT(account_id) DO UPDATE SET
				reading = excluded.reading,
				reading_observed_at = excluded.reading_observed_at
			WHERE reading_observed_at IS NULL
				OR excluded.reading_observed_at > reading_observed_at`,
			[accountId, reading, observedAt],
		);
	}

	async getAll(): Promise<AnthropicUsageReadRow[]> {
		const rows = await this.query<Row>(
			`SELECT account_id, last_read_at, reading, reading_observed_at
			FROM anthropic_usage_reads ORDER BY account_id`,
		);
		return rows.map((row) => ({
			accountId: row.account_id,
			lastReadAt: row.last_read_at,
			reading: row.reading,
			readingObservedAt: row.reading_observed_at,
		}));
	}
}
