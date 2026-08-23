import type { Database } from "bun:sqlite";
import { Logger } from "@clankermux/logger";

const log = new Logger("DatabaseBackfills");

/**
 * One-shot data backfills, run once after runMigrations() on every startup.
 *
 * Deliberately NOT part of runMigrations(): migrations are schema-only
 * (additive ALTER TABLE ADD COLUMN, no data rewriting), and a backfill is data.
 * Keeping them apart is what lets the migration tests treat runMigrations() as
 * a pure schema function.
 *
 * Every backfill here MUST be one-shot rather than level-triggered, and must
 * record that it ran. A pass that re-derives state on every start silently
 * overwrites whatever the operator has since changed by hand.
 *
 * The marker rows live in `strategies` — a name/config/updated_at store already
 * used for persisted operational metadata — under `backfill:` names. Each pass
 * writes its marker in the SAME transaction as its UPDATE, so a crash cannot
 * leave a half-applied backfill that never runs again.
 */
export function runOneShotBackfills(db: Database): void {
	backfillAutoPauseOverageDefault(db);
}

const AUTO_PAUSE_OVERAGE_MARKER = "backfill:auto-pause-overage-default";

/**
 * Lift `accounts.auto_pause_on_overage_enabled` from 0 to 1 for accounts
 * created before the default flipped.
 *
 * The column is DEFAULT 1 in the current CREATE TABLE and DEFAULT 0 on every
 * database created before c20d32c3 (2026-06-23), including the migration floor
 * and this deployment's own database. `ALTER TABLE ADD COLUMN` cannot change an
 * existing column's default, so those databases keep DEFAULT 0 forever — which
 * is why the account-creation paths name the column explicitly, and why the
 * rows they created before that fix need this one-shot pass.
 *
 * One-shot is essential: overage auto-pause is a per-account toggle the
 * operator can turn off in the dashboard, so an unconditional
 * `UPDATE … WHERE auto_pause_on_overage_enabled = 0` on every start would
 * re-enable it behind their back, every restart, forever.
 */
function backfillAutoPauseOverageDefault(db: Database): void {
	const alreadyApplied =
		db
			.prepare(`SELECT name FROM strategies WHERE name = ?`)
			.get(AUTO_PAUSE_OVERAGE_MARKER) != null;
	if (alreadyApplied) return;

	let updated = 0;
	const tx = db.transaction(() => {
		updated = db
			.prepare(
				`UPDATE accounts SET auto_pause_on_overage_enabled = 1
				 WHERE auto_pause_on_overage_enabled = 0`,
			)
			.run().changes;

		const now = Date.now();
		db.prepare(
			`INSERT INTO strategies (name, config, updated_at) VALUES (?, ?, ?)`,
		).run(
			AUTO_PAUSE_OVERAGE_MARKER,
			JSON.stringify({ accountsUpdated: updated, appliedAt: now }),
			now,
		);
	});
	tx();

	log.info(
		`Backfill ${AUTO_PAUSE_OVERAGE_MARKER}: enabled overage auto-pause on ${updated} account(s)`,
	);
}
