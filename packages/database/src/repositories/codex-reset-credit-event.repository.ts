import type { CodexResetCreditEventStatus } from "@clankermux/types";
import { BaseRepository } from "./base.repository";

/** Database row type matching the codex_reset_credit_events schema. */
export interface CodexResetCreditEventRow {
	id: string;
	account_id: string;
	account_name: string;
	credit_id: string | null;
	trigger: string;
	attempt_seq: number | null;
	idempotency_key: string;
	status: string;
	windows_reset: number | null;
	error_message: string | null;
	/** Unix SECONDS snapshot of the credit's expiry; null = never expires. */
	credit_expires_at: number | null;
	created_at: number;
	resolved_at: number | null;
}

/** Every status except `pending` — what an attempt can resolve to. */
export type CodexResetCreditEventResolvedStatus = Exclude<
	CodexResetCreditEventStatus,
	"pending"
>;

export interface CodexResetCreditAutoClaim {
	id: string;
	idempotencyKey: string;
	attemptSeq: number;
	/** True when an existing pending row was reused (retry with the SAME key). */
	reused: boolean;
}

/**
 * Repository for the `codex_reset_credit_events` ledger — every attempt to
 * consume a Codex usage-limit reset credit, manual or automated.
 *
 * Auto rows are claim-then-resolve: `claimAutoAttempt` durably reserves a
 * deterministic id "{account_id}:{credit_id}:{attempt_seq}" plus idempotency
 * key BEFORE the network call, so a crash mid-consume retries with the same
 * key instead of double-spending. The partial UNIQUE index on
 * (account_id, credit_id, attempt_seq) WHERE trigger='auto' makes concurrent
 * claims race-safe via INSERT OR IGNORE. Manual rows are one-shot resolved
 * inserts (`recordManual`) with a random UUID.
 *
 * Terminality: `reset`/`alreadyRedeemed`/`noCredit` end automation for a
 * credit. `failed` is ALSO terminal for auto rows — it marks a deliberate
 * dispatch-level hard failure that must not silently retry forever (transport
 * throws keep the row `pending`, so `failed` auto rows are rare/deliberate).
 * Only `nothingToReset` re-arms: the credit is still unspent, so a later
 * rate-limit may claim the next attempt_seq with a NEW key.
 */
export class CodexResetCreditEventRepository extends BaseRepository<CodexResetCreditEventRow> {
	/**
	 * Claim (or reuse) the next auto consume attempt for a credit. Returns
	 * null when the latest attempt is terminal — automation is done with this
	 * credit.
	 */
	async claimAutoAttempt(input: {
		accountId: string;
		accountName: string;
		creditId: string;
		creditExpiresAt: number | null;
		now: number;
	}): Promise<CodexResetCreditAutoClaim | null> {
		const latest = await this.latestAutoRow(input.accountId, input.creditId);

		if (latest) {
			if (latest.status === "pending") {
				return {
					id: latest.id,
					idempotencyKey: latest.idempotency_key,
					attemptSeq: latest.attempt_seq ?? 0,
					reused: true,
				};
			}
			if (latest.status !== "nothingToReset") {
				// reset/alreadyRedeemed/noCredit/failed — terminal for automation.
				return null;
			}
		}

		const attemptSeq = (latest?.attempt_seq ?? 0) + 1;
		const id = `${input.accountId}:${input.creditId}:${attemptSeq}`;
		const idempotencyKey = `codex-reset-auto:${id}`;
		const changes = await this.runWithChanges(
			`
			INSERT OR IGNORE INTO codex_reset_credit_events (
				id, account_id, account_name, credit_id, trigger, attempt_seq,
				idempotency_key, status, windows_reset, error_message,
				credit_expires_at, created_at, resolved_at
			)
			VALUES (?, ?, ?, ?, 'auto', ?, ?, 'pending', NULL, NULL, ?, ?, NULL)
		`,
			[
				id,
				input.accountId,
				input.accountName,
				input.creditId,
				attemptSeq,
				idempotencyKey,
				input.creditExpiresAt,
				input.now,
			],
		);
		if (changes > 0) {
			return { id, idempotencyKey, attemptSeq, reused: false };
		}

		// A concurrent claim won the INSERT race — reuse the winner's row.
		const winner = await this.latestAutoRow(input.accountId, input.creditId);
		if (!winner) return null;
		return {
			id: winner.id,
			idempotencyKey: winner.idempotency_key,
			attemptSeq: winner.attempt_seq ?? 0,
			reused: true,
		};
	}

	/** Resolve a pending attempt. No-op for unknown or already-resolved rows. */
	async resolveAttempt(
		id: string,
		status: CodexResetCreditEventResolvedStatus,
		windowsReset: number | null,
		errorMessage: string | null,
		now: number,
	): Promise<void> {
		await this.run(
			`
			UPDATE codex_reset_credit_events
			SET status = ?, windows_reset = ?, error_message = ?, resolved_at = ?
			WHERE id = ? AND status = 'pending'
		`,
			[status, windowsReset, errorMessage, now, id],
		);
	}

	/** One-shot resolved manual event (dashboard button press). */
	async recordManual(input: {
		accountId: string;
		accountName: string;
		creditId: string | null;
		idempotencyKey: string;
		status: CodexResetCreditEventResolvedStatus;
		windowsReset: number | null;
		errorMessage: string | null;
		now: number;
	}): Promise<void> {
		await this.run(
			`
			INSERT INTO codex_reset_credit_events (
				id, account_id, account_name, credit_id, trigger, attempt_seq,
				idempotency_key, status, windows_reset, error_message,
				credit_expires_at, created_at, resolved_at
			)
			VALUES (?, ?, ?, ?, 'manual', NULL, ?, ?, ?, ?, NULL, ?, ?)
		`,
			[
				crypto.randomUUID(),
				input.accountId,
				input.accountName,
				input.creditId,
				input.idempotencyKey,
				input.status,
				input.windowsReset,
				input.errorMessage,
				input.now,
				input.now,
			],
		);
	}

	/**
	 * Credit ids whose latest auto outcome is terminal — the scheduler skips
	 * these without re-claiming.
	 */
	async getTerminallyResolvedCreditIds(
		accountId: string,
	): Promise<Set<string>> {
		const rows = await this.query<{ credit_id: string }>(
			`
			SELECT DISTINCT credit_id FROM codex_reset_credit_events
			WHERE trigger = 'auto' AND account_id = ? AND credit_id IS NOT NULL
				AND status IN ('reset','alreadyRedeemed','noCredit','failed')
		`,
			[accountId],
		);
		return new Set(rows.map((row) => row.credit_id));
	}

	/** Most recent ledger rows for an account, newest first. */
	async findRecentForAccount(
		accountId: string,
		limit: number,
	): Promise<CodexResetCreditEventRow[]> {
		return this.query<CodexResetCreditEventRow>(
			`
			SELECT * FROM codex_reset_credit_events
			WHERE account_id = ?
			ORDER BY created_at DESC
			LIMIT ?
		`,
			[accountId, limit],
		);
	}

	private async latestAutoRow(
		accountId: string,
		creditId: string,
	): Promise<CodexResetCreditEventRow | null> {
		return this.get<CodexResetCreditEventRow>(
			`
			SELECT * FROM codex_reset_credit_events
			WHERE trigger = 'auto' AND account_id = ? AND credit_id = ?
			ORDER BY attempt_seq DESC
			LIMIT 1
		`,
			[accountId, creditId],
		);
	}
}
