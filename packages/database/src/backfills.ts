import type { Database } from "bun:sqlite";
import { getAppVersionSync } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import {
	ATTEMPT_SDK_BRIDGE_AT_CAPACITY,
	ATTEMPT_SDK_BRIDGE_UNAVAILABLE,
	ATTEMPT_TRANSPORT_FAILED,
	CLIENT_CLOSED_REQUEST,
} from "@clankermux/types";

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
	seedAccountTierHistory(db);
	clearUnratedRequestModels(db);
	backfillServedServiceTier(db);
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
	let claimed = false;
	let updated = 0;
	const tx = db.transaction(() => {
		// Claiming the marker is the FIRST statement, inside the transaction, so
		// the check and the write are atomic against another connection. Two
		// processes opening the same database before the marker exists would both
		// pass a pre-check outside the transaction, and the loser would then hit
		// `UNIQUE constraint failed: strategies.name` on an unconditional INSERT
		// and take the whole startup down with it.
		claimed =
			db
				.prepare(
					`INSERT OR IGNORE INTO strategies (name, config, updated_at)
					 VALUES (?, ?, ?)`,
				)
				.run(AUTO_PAUSE_OVERAGE_MARKER, "{}", Date.now()).changes > 0;
		if (!claimed) return;

		updated = db
			.prepare(
				`UPDATE accounts SET auto_pause_on_overage_enabled = 1
				 WHERE auto_pause_on_overage_enabled = 0`,
			)
			.run().changes;

		const now = Date.now();
		db.prepare(
			`UPDATE strategies SET config = ?, updated_at = ? WHERE name = ?`,
		).run(
			JSON.stringify({ accountsUpdated: updated, appliedAt: now }),
			now,
			AUTO_PAUSE_OVERAGE_MARKER,
		);
	});
	tx();

	if (!claimed) return;

	log.info(
		`Backfill ${AUTO_PAUSE_OVERAGE_MARKER}: enabled overage auto-pause on ${updated} account(s)`,
	);
}

const ACCOUNT_TIER_HISTORY_SEED_MARKER = "backfill:account-tier-history-seed";

/**
 * Give `account_tier_history` a starting point: one row per existing account
 * carrying its CURRENT tier pair, `source = 'seed'`.
 *
 * Without it the series only ever gains a row when a tier CHANGES, so every
 * account that never changes tier would be absent entirely — and an absent
 * account is indistinguishable from one whose tier is unknown. The seed row's
 * `observed_at` is this pass's own clock, NOT when the tier was adopted; the
 * `seed` source says so, and nothing may read it as a transition.
 *
 * One-shot for the usual reason plus one specific to this table: re-running it
 * every boot would append a duplicate row per account per restart, turning a
 * change log into a restart log.
 */
function seedAccountTierHistory(db: Database): void {
	let claimed = false;
	let seeded = 0;
	const tx = db.transaction(() => {
		// Marker first, inside the transaction — see the rationale on
		// backfillAutoPauseOverageDefault.
		claimed =
			db
				.prepare(
					`INSERT OR IGNORE INTO strategies (name, config, updated_at)
					 VALUES (?, ?, ?)`,
				)
				.run(ACCOUNT_TIER_HISTORY_SEED_MARKER, "{}", Date.now()).changes > 0;
		if (!claimed) return;

		const now = Date.now();
		seeded = db
			.prepare(
				`INSERT INTO account_tier_history (
					account_id, observed_at, plan_tier, rate_limit_tier, source, app_version
				)
				SELECT id, ?, identity_plan_tier, identity_rate_limit_tier, 'seed', ?
				FROM accounts`,
			)
			// The ClankerMux build that took the observation; null when unknown.
			.run(now, getAppVersionSync()).changes;

		db.prepare(
			`UPDATE strategies SET config = ?, updated_at = ? WHERE name = ?`,
		).run(
			JSON.stringify({ accountsSeeded: seeded, appliedAt: now }),
			now,
			ACCOUNT_TIER_HISTORY_SEED_MARKER,
		);
	});
	tx();

	if (!claimed) return;

	log.info(
		`Backfill ${ACCOUNT_TIER_HISTORY_SEED_MARKER}: seeded tier history for ${seeded} account(s)`,
	);
}

const UNRATED_REQUEST_MODEL_MARKER = "backfill:unrated-request-model";

/**
 * Clear `requests.model` on rows without an outcome (`success` NULL: the
 * client left before any response started).
 *
 * Such rows have no usage, so they now carry no model, and the analytics
 * reads that filter on `model IS NOT NULL` rely on that to leave them out
 * without reading `success`. The release that introduced the rows wrote the
 * dispatched model into them; this pass clears those. The dispatched model
 * stays on the request's routing attempt.
 *
 * `success IS NULL` is a seek on `idx_requests_success_timestamp`, so the pass
 * touches only those rows.
 */
function clearUnratedRequestModels(db: Database): void {
	let claimed = false;
	let cleared = 0;
	const tx = db.transaction(() => {
		// Marker first, inside the transaction: see the rationale on
		// backfillAutoPauseOverageDefault.
		claimed =
			db
				.prepare(
					`INSERT OR IGNORE INTO strategies (name, config, updated_at)
					 VALUES (?, ?, ?)`,
				)
				.run(UNRATED_REQUEST_MODEL_MARKER, "{}", Date.now()).changes > 0;
		if (!claimed) return;

		cleared = db
			.prepare(
				"UPDATE requests SET model = NULL WHERE success IS NULL AND model IS NOT NULL",
			)
			.run().changes;

		const now = Date.now();
		db.prepare(
			`UPDATE strategies SET config = ?, updated_at = ? WHERE name = ?`,
		).run(
			JSON.stringify({ requestsCleared: cleared, appliedAt: now }),
			now,
			UNRATED_REQUEST_MODEL_MARKER,
		);
	});
	tx();

	if (!claimed) return;

	log.info(
		`Backfill ${UNRATED_REQUEST_MODEL_MARKER}: cleared the model on ${cleared} request(s) without an outcome`,
	);
}

const SERVED_SERVICE_TIER_MARKER = "backfill:served-service-tier";

/**
 * Fill `requests.service_tier` on rows recorded after attempts started
 * carrying a tier but before the request column existed, from the request's
 * latest upstream attempt that may have run (rowid breaks a millisecond tie).
 * Bridge refusals ran nothing and are skipped. When the deciding attempt is
 * ambiguous (the fetch failed, or the client-closed stamp), the request is
 * left NULL rather than guessed. Requests with no tiered attempt are not
 * touched: their NULL already reads as standard.
 *
 *   priority 200                         -> 'priority'
 *   priority 401, then none 200          -> 'standard'
 *   priority 200, then bridge refusal    -> 'priority'
 *   priority 200, then transport failed  -> NULL
 */
function backfillServedServiceTier(db: Database): void {
	let claimed = false;
	let filled = 0;
	const tx = db.transaction(() => {
		// Marker first, inside the transaction: see the rationale on
		// backfillAutoPauseOverageDefault.
		claimed =
			db
				.prepare(
					`INSERT OR IGNORE INTO strategies (name, config, updated_at)
					 VALUES (?, ?, ?)`,
				)
				.run(SERVED_SERVICE_TIER_MARKER, "{}", Date.now()).changes > 0;
		if (!claimed) return;

		filled = db
			.prepare(
				`WITH ranked AS (
					SELECT ra.request_id, ra.service_tier_sent, ra.status, ra.error,
						ROW_NUMBER() OVER (
							PARTITION BY ra.request_id
							ORDER BY ra.started_at DESC, ra.rowid DESC
						) AS rn
					FROM routing_attempts ra
					WHERE ra.kind = 'upstream_send'
					  AND ra.request_id IN (
						SELECT request_id FROM routing_attempts
						WHERE service_tier_sent IS NOT NULL AND kind = 'upstream_send'
					  )
					  AND substr(COALESCE(ra.error, ''), 1, length(?1)) <> ?1
					  AND substr(COALESCE(ra.error, ''), 1, length(?2)) <> ?2
				),
				decided AS (
					SELECT request_id,
						CASE WHEN service_tier_sent = 'priority' THEN 'priority' ELSE 'standard' END AS tier
					FROM ranked
					WHERE rn = 1
					  AND COALESCE(error, '') <> ?3
					  AND NOT (COALESCE(status, 0) = 499 AND COALESCE(error, '') = ?4)
				)
				UPDATE requests
				SET service_tier = (SELECT tier FROM decided WHERE decided.request_id = requests.id)
				WHERE service_tier IS NULL
				  AND id IN (SELECT request_id FROM decided)`,
			)
			.run(
				ATTEMPT_SDK_BRIDGE_AT_CAPACITY,
				ATTEMPT_SDK_BRIDGE_UNAVAILABLE,
				ATTEMPT_TRANSPORT_FAILED,
				CLIENT_CLOSED_REQUEST,
			).changes;

		const now = Date.now();
		db.prepare(
			`UPDATE strategies SET config = ?, updated_at = ? WHERE name = ?`,
		).run(
			JSON.stringify({ requestsFilled: filled, appliedAt: now }),
			now,
			SERVED_SERVICE_TIER_MARKER,
		);
	});
	tx();

	if (!claimed) return;

	log.info(
		`Backfill ${SERVED_SERVICE_TIER_MARKER}: set the served tier on ${filled} request(s)`,
	);
}
