import { parseAnchor } from "@clankermux/core/renewal";
import type { AccountPaymentRow, PaymentSource } from "@clankermux/types";
import { BaseRepository } from "./base.repository";

/**
 * Local-midnight epoch ms for a "YYYY-MM-DD" date string, using the same
 * LOCAL-calendar semantics as the core renewal lib (which produced the date).
 * Throws on dates that don't exist on the calendar (e.g. "2026-02-31").
 */
export function localMidnightMsOf(dateStr: string): number {
	const parsed = parseAnchor(dateStr);
	if (!parsed) {
		throw new Error(`Invalid calendar date: ${dateStr}`);
	}
	return new Date(parsed.year, parsed.month, parsed.day).getTime();
}

/**
 * Repository for the `account_payments` ledger — subscription renewals and
 * ad-hoc usage-credit purchases.
 *
 * Idempotency is enforced by two partial UNIQUE indexes (see migrations.ts):
 *  - (account_id, paid_date) WHERE kind='subscription' — the auto-recorder's
 *    INSERT OR IGNORE can never double-book a due date, and a soft-deleted
 *    tombstone keeps suppressing re-inserts.
 *  - (import_key) WHERE import_key IS NOT NULL — seed/backfill retries upsert
 *    instead of duplicating credit purchases.
 *
 * Rows are soft-deleted (`deleted_at`) so subscription tombstones survive;
 * all read/aggregate methods exclude deleted rows except
 * `latestSubscriptionDueDate`, which is recorder bookkeeping and deliberately
 * includes them.
 */
export class AccountPaymentRepository extends BaseRepository<AccountPaymentRow> {
	/**
	 * Auto-record a subscription renewal for `dueDate`. INSERT OR IGNORE
	 * against the partial unique index — returns whether a row was actually
	 * inserted (false when the due date is already booked, incl. tombstones).
	 */
	async recordAuto(
		accountId: string,
		accountName: string,
		dueDate: string,
		amountUsdMicros: number,
		now: number,
	): Promise<boolean> {
		const changes = await this.runWithChanges(
			`
			INSERT OR IGNORE INTO account_payments (
				id, account_id, account_name, kind, paid_date, paid_at_ms,
				amount_usd_micros, recorded_at, source, import_key, notes, deleted_at
			)
			VALUES (?, ?, ?, 'subscription', ?, ?, ?, ?, 'auto', NULL, NULL, NULL)
		`,
			[
				crypto.randomUUID(),
				accountId,
				accountName,
				dueDate,
				localMidnightMsOf(dueDate),
				amountUsdMicros,
				now,
			],
		);
		return changes > 0;
	}

	/**
	 * Manual/backfill subscription correction. Upserts on the
	 * (account_id, paid_date) subscription index: an existing row — including
	 * a soft-deleted tombstone — is updated and resurrected (deleted_at=NULL).
	 * Never INSERT OR REPLACE (that would rotate the row id and fire deletes).
	 */
	async upsertSubscription(
		accountId: string,
		accountName: string,
		paidDate: string,
		amountUsdMicros: number,
		source: PaymentSource,
		notes: string | null,
		now: number,
	): Promise<void> {
		await this.run(
			`
			INSERT INTO account_payments (
				id, account_id, account_name, kind, paid_date, paid_at_ms,
				amount_usd_micros, recorded_at, source, import_key, notes, deleted_at
			)
			VALUES (?, ?, ?, 'subscription', ?, ?, ?, ?, ?, NULL, ?, NULL)
			ON CONFLICT (account_id, paid_date) WHERE kind = 'subscription' DO UPDATE SET
				amount_usd_micros = EXCLUDED.amount_usd_micros,
				notes = EXCLUDED.notes,
				source = EXCLUDED.source,
				account_name = EXCLUDED.account_name,
				deleted_at = NULL,
				recorded_at = EXCLUDED.recorded_at
		`,
			[
				crypto.randomUUID(),
				accountId,
				accountName,
				paidDate,
				localMidnightMsOf(paidDate),
				amountUsdMicros,
				now,
				source,
				notes,
			],
		);
	}

	/**
	 * Record a usage-credit purchase. Credits are NOT deduped by date (two
	 * purchases on the same day are two rows). When `importKey` is provided,
	 * the partial unique index gives retry idempotency: a duplicate key
	 * updates the existing row (and resurrects it) instead of inserting.
	 * Returns whether a row was inserted or updated.
	 */
	async insertCredit(
		accountId: string,
		accountName: string,
		paidDate: string,
		amountUsdMicros: number,
		source: PaymentSource,
		notes: string | null,
		importKey: string | null,
		now: number,
	): Promise<boolean> {
		const conflictClause = importKey
			? `
			ON CONFLICT (import_key) WHERE import_key IS NOT NULL DO UPDATE SET
				amount_usd_micros = EXCLUDED.amount_usd_micros,
				notes = EXCLUDED.notes,
				paid_date = EXCLUDED.paid_date,
				paid_at_ms = EXCLUDED.paid_at_ms,
				deleted_at = NULL
		`
			: "";
		const changes = await this.runWithChanges(
			`
			INSERT INTO account_payments (
				id, account_id, account_name, kind, paid_date, paid_at_ms,
				amount_usd_micros, recorded_at, source, import_key, notes, deleted_at
			)
			VALUES (?, ?, ?, 'credits', ?, ?, ?, ?, ?, ?, ?, NULL)
			${conflictClause}
		`,
			[
				crypto.randomUUID(),
				accountId,
				accountName,
				paidDate,
				localMidnightMsOf(paidDate),
				amountUsdMicros,
				now,
				source,
				importKey,
				notes,
			],
		);
		return changes > 0;
	}

	/** Soft-delete a ledger row. Returns false if unknown or already deleted. */
	async softDelete(id: string): Promise<boolean> {
		const changes = await this.runWithChanges(
			`UPDATE account_payments SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
			[Date.now(), id],
		);
		return changes > 0;
	}

	/** Most recent non-deleted ledger rows, newest first. */
	async findRecent(limit: number): Promise<AccountPaymentRow[]> {
		return this.query<AccountPaymentRow>(
			`
			SELECT * FROM account_payments
			WHERE deleted_at IS NULL
			ORDER BY paid_at_ms DESC, recorded_at DESC
			LIMIT ?
		`,
			[limit],
		);
	}

	/** Non-deleted rows with paid_at_ms in [fromMs, toMs). */
	async findInRange(
		fromMs: number,
		toMs: number,
	): Promise<AccountPaymentRow[]> {
		return this.query<AccountPaymentRow>(
			`
			SELECT * FROM account_payments
			WHERE deleted_at IS NULL AND paid_at_ms >= ? AND paid_at_ms < ?
			ORDER BY paid_at_ms DESC, recorded_at DESC
		`,
			[fromMs, toMs],
		);
	}

	/** Non-deleted totals per kind for paid_at_ms in [fromMs, toMs). */
	async sumByKindInRange(
		fromMs: number,
		toMs: number,
	): Promise<{ kind: string; total_micros: number }[]> {
		return this.query<{ kind: string; total_micros: number }>(
			`
			SELECT kind, SUM(amount_usd_micros) AS total_micros
			FROM account_payments
			WHERE deleted_at IS NULL AND paid_at_ms >= ? AND paid_at_ms < ?
			GROUP BY kind
		`,
			[fromMs, toMs],
		);
	}

	/** Non-deleted totals per account for paid_at_ms in [fromMs, toMs). */
	async sumByAccountInRange(
		fromMs: number,
		toMs: number,
	): Promise<{ account_id: string; total_micros: number }[]> {
		return this.query<{ account_id: string; total_micros: number }>(
			`
			SELECT account_id, SUM(amount_usd_micros) AS total_micros
			FROM account_payments
			WHERE deleted_at IS NULL AND paid_at_ms >= ? AND paid_at_ms < ?
			GROUP BY account_id
		`,
			[fromMs, toMs],
		);
	}

	/**
	 * Latest subscription due date booked for the account, INCLUDING
	 * soft-deleted tombstones — recorder bookkeeping so a deleted entry still
	 * marks its due date as handled.
	 */
	async latestSubscriptionDueDate(accountId: string): Promise<string | null> {
		const row = await this.get<{ latest: string | null }>(
			`
			SELECT MAX(paid_date) AS latest
			FROM account_payments
			WHERE account_id = ? AND kind = 'subscription'
		`,
			[accountId],
		);
		return row?.latest ?? null;
	}
}
