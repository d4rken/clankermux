import { BaseRepository } from "./base.repository";

export interface StrategyData {
	name: string;
	config: Record<string, unknown>;
	updatedAt: number;
}

export class StrategyRepository extends BaseRepository<StrategyData> {
	async getStrategy(name: string): Promise<StrategyData | null> {
		const row = await super.get<{
			name: string;
			config: string;
			updated_at: number;
		}>(`SELECT name, config, updated_at FROM strategies WHERE name = ?`, [
			name,
		]);

		if (!row) return null;

		return {
			name: row.name,
			config: JSON.parse(row.config),
			updatedAt: row.updated_at,
		};
	}

	async set(name: string, config: Record<string, unknown>): Promise<void> {
		const now = Date.now();
		const configJson = JSON.stringify(config);

		await this.run(
			`INSERT INTO strategies (name, config, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at`,
			[name, configJson, now],
		);
	}

	/**
	 * Claim a one-shot marker row, returning true only for the caller that
	 * actually inserted it.
	 *
	 * `INSERT OR IGNORE` makes the check and the write ONE statement, which is
	 * what a claim needs: two processes opening the same database would both pass
	 * a separate pre-check, and the loser would then take startup down with
	 * `UNIQUE constraint failed: strategies.name`.
	 *
	 * This is the async sibling of the in-transaction claim `runOneShotBackfills`
	 * uses. A pass whose work is network-bound (a profile fetch per account)
	 * cannot run inside that transaction, so it claims here first and then works:
	 * a crash mid-pass leaves the marker claimed, which costs the remaining
	 * accounts their pass but can never turn it into a pass that repeats forever.
	 */
	async claimMarker(name: string): Promise<boolean> {
		const changes = await this.runWithChanges(
			`INSERT OR IGNORE INTO strategies (name, config, updated_at)
			 VALUES (?, ?, ?)`,
			[name, "{}", Date.now()],
		);
		return changes > 0;
	}

	async list(): Promise<StrategyData[]> {
		const rows = await this.query<{
			name: string;
			config: string;
			updated_at: number;
		}>(`SELECT name, config, updated_at FROM strategies ORDER BY name`);

		return rows.map((row) => ({
			name: row.name,
			config: JSON.parse(row.config),
			updatedAt: row.updated_at,
		}));
	}

	async delete(name: string): Promise<boolean> {
		const changes = await this.runWithChanges(
			`DELETE FROM strategies WHERE name = ?`,
			[name],
		);
		return changes > 0;
	}
}
