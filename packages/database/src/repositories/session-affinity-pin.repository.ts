import type { AffinityPin } from "@clankermux/types";
import { BaseRepository } from "./base.repository";

type PinRow = { key_hash: string; account_id: string; last_used_at: number };

/** Repository for `session_affinity_pins`, the persisted strategy pins. */
export class SessionAffinityPinRepository extends BaseRepository<AffinityPin> {
	/**
	 * Replace every stored pin with `pins` in one transaction. A pin whose
	 * account has been deleted since the strategy recorded it is skipped, since
	 * its foreign-key violation would otherwise abort the whole snapshot.
	 */
	async replaceAll(pins: readonly AffinityPin[]): Promise<void> {
		await this.adapter.runTransaction(() => {
			const db = this.adapter.getSQLiteDb();
			db.run("DELETE FROM session_affinity_pins");
			const insert = db.query(
				`INSERT INTO session_affinity_pins (key_hash, account_id, last_used_at)
				SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ?2)`,
			);
			for (const pin of pins) {
				insert.run(pin.keyHash, pin.accountId, pin.lastUsedAt);
			}
		});
	}

	/** Pins used at or after `sinceMs`, least recently used first. */
	async getSince(sinceMs: number): Promise<AffinityPin[]> {
		const rows = await this.query<PinRow>(
			`SELECT key_hash, account_id, last_used_at FROM session_affinity_pins
			WHERE last_used_at >= ? ORDER BY last_used_at, key_hash`,
			[sinceMs],
		);
		return rows.map((row) => ({
			keyHash: row.key_hash,
			accountId: row.account_id,
			lastUsedAt: row.last_used_at,
		}));
	}
}
