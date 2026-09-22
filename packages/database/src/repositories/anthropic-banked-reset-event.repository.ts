import type {
	AnthropicBankedResetEventStatus,
	AnthropicBankedResetWindow,
} from "@clankermux/types";
import { BaseRepository } from "./base.repository";

/** Database row type matching the anthropic_banked_reset_events schema. */
export interface AnthropicBankedResetEventRow {
	id: string;
	account_id: string;
	account_name: string;
	grant_id: string;
	trigger: "manual" | "auto";
	/** Why an auto attempt was claimed; NULL on manual rows. */
	cause: "expiry" | "weekly-limit" | null;
	attempt_seq: number | null;
	request_id: string;
	status: AnthropicBankedResetEventStatus;
	reason: string | null;
	/** JSON array of the windows the server reported cleared. */
	cleared: string | null;
	resets_left: number | null;
	error_message: string | null;
	/** ms epoch snapshot of the grant's use-by date. */
	grant_ends_at: number | null;
	/** ms epoch before which a pending row is not replayed. */
	next_attempt_at: number | null;
	created_at: number;
	resolved_at: number | null;
}

/** Every status except `pending` — what an attempt can resolve to. */
export type AnthropicBankedResetEventResolvedStatus = Exclude<
	AnthropicBankedResetEventStatus,
	"pending"
>;

export interface AnthropicBankedResetAutoClaim {
	id: string;
	requestId: string;
	attemptSeq: number;
	/** True when an existing pending row was reused (replay with the SAME request id). */
	reused: boolean;
}

/**
 * Outcome of recording a manual claim before its POST. `existing` is a replay
 * of a request id this account already used for the same grant; the caller
 * reconciles that row instead of starting a new claim. `grant_mismatch` means
 * the request id is bound to another grant and must not be sent.
 */
export type AnthropicBankedResetManualBegin =
	| { kind: "created"; row: AnthropicBankedResetEventRow }
	| { kind: "existing"; row: AnthropicBankedResetEventRow }
	| { kind: "grant_mismatch"; row: AnthropicBankedResetEventRow };

export interface AnthropicBankedResetResolution {
	status: AnthropicBankedResetEventResolvedStatus;
	reason?: string | null;
	cleared?: AnthropicBankedResetWindow[] | null;
	resetsLeft?: number | null;
	errorMessage?: string | null;
	now: number;
}

/** How long a claim may stay unconfirmed before it is given up as `failed`. */
export const ANTHROPIC_BANKED_RESET_PENDING_EXPIRY_MS = 60 * 60 * 1000;

/**
 * Repository for the `anthropic_banked_reset_events` ledger — every attempt to
 * claim an Anthropic banked reset, manual or automated.
 *
 * Every row is written `pending` BEFORE the POST and keeps its request id for
 * every replay, so a crash or a lost response cannot spend a second reset: the
 * server answers a replayed request id with the outcome of the first. The
 * UNIQUE (account_id, request_id) index is what reconciles a manual replay
 * onto its row. Auto rows carry a deterministic id
 * "{account_id}:{grant_id}:{attempt_seq}" and a partial UNIQUE index on
 * (account_id, grant_id, attempt_seq), which makes concurrent auto claims
 * race-safe through INSERT OR IGNORE.
 *
 * A grant holds several resets, so no outcome ends automation for it: when the
 * next attempt may start is the scheduler's decision, anchored on
 * {@link getLatestAutoApplyCooldownAnchorAt}.
 */
export class AnthropicBankedResetEventRepository extends BaseRepository<AnthropicBankedResetEventRow> {
	/**
	 * Claim (or reuse) the next auto attempt for a grant. A still-pending
	 * attempt is returned as-is, cause included. Returns null when a
	 * weekly-limit claim is blocked by another pending auto attempt on the
	 * account; expiry claims are not blocked, so a stuck weekly attempt cannot
	 * let a grant lapse.
	 */
	async claimAutoAttempt(input: {
		accountId: string;
		accountName: string;
		grantId: string;
		grantEndsAt: number | null;
		cause: "expiry" | "weekly-limit";
		now: number;
	}): Promise<AnthropicBankedResetAutoClaim | null> {
		const latest = await this.latestAutoRow(input.accountId, input.grantId);
		if (latest?.status === "pending") return toAutoClaim(latest);

		const attemptSeq = (latest?.attempt_seq ?? 0) + 1;
		const id = `${input.accountId}:${input.grantId}:${attemptSeq}`;
		// Random, not derived from the id: the server deduplicates on it, and a
		// re-added account restarts attempt_seq at 1.
		const requestId = crypto.randomUUID();
		const changes = await this.runWithChanges(
			`
			INSERT OR IGNORE INTO anthropic_banked_reset_events (
				id, account_id, account_name, grant_id, trigger, cause, attempt_seq,
				request_id, status, grant_ends_at, created_at
			)
			SELECT ?, ?, ?, ?, 'auto', ?, ?, ?, 'pending', ?, ?
			WHERE ? = 'expiry' OR NOT EXISTS (
				SELECT 1 FROM anthropic_banked_reset_events
				WHERE account_id = ? AND trigger = 'auto' AND status = 'pending'
			)
		`,
			[
				id,
				input.accountId,
				input.accountName,
				input.grantId,
				input.cause,
				attemptSeq,
				requestId,
				input.grantEndsAt,
				input.now,
				input.cause,
				input.accountId,
			],
		);
		if (changes > 0) return { id, requestId, attemptSeq, reused: false };

		// A concurrent claim won, or a pending attempt elsewhere on the account
		// blocked this weekly claim. Reuse only a still-pending row for THIS grant.
		const winner = await this.latestAutoRow(input.accountId, input.grantId);
		return winner?.status === "pending" ? toAutoClaim(winner) : null;
	}

	/** Record a manual claim before its POST, reconciling a replayed request id. */
	async beginManualAttempt(input: {
		accountId: string;
		accountName: string;
		grantId: string;
		requestId: string;
		grantEndsAt: number | null;
		now: number;
	}): Promise<AnthropicBankedResetManualBegin> {
		const changes = await this.runWithChanges(
			`
			INSERT OR IGNORE INTO anthropic_banked_reset_events (
				id, account_id, account_name, grant_id, trigger, cause, attempt_seq,
				request_id, status, grant_ends_at, created_at
			)
			VALUES (?, ?, ?, ?, 'manual', NULL, NULL, ?, 'pending', ?, ?)
		`,
			[
				crypto.randomUUID(),
				input.accountId,
				input.accountName,
				input.grantId,
				input.requestId,
				input.grantEndsAt,
				input.now,
			],
		);
		const row = await this.findByRequestId(input.accountId, input.requestId);
		if (!row) {
			throw new Error(
				`Banked-reset ledger row for request ${input.requestId} vanished after insert`,
			);
		}
		if (changes > 0) return { kind: "created", row };
		return row.grant_id === input.grantId
			? { kind: "existing", row }
			: { kind: "grant_mismatch", row };
	}

	async findByRequestId(
		accountId: string,
		requestId: string,
	): Promise<AnthropicBankedResetEventRow | null> {
		return this.get<AnthropicBankedResetEventRow>(
			`SELECT * FROM anthropic_banked_reset_events
			 WHERE account_id = ? AND request_id = ?`,
			[accountId, requestId],
		);
	}

	/** Unresolved attempts for an account, oldest first. */
	async findPendingForAccount(
		accountId: string,
		trigger?: "manual" | "auto",
	): Promise<AnthropicBankedResetEventRow[]> {
		return this.query<AnthropicBankedResetEventRow>(
			`SELECT * FROM anthropic_banked_reset_events
			 WHERE account_id = ? AND status = 'pending'
				AND (? IS NULL OR trigger = ?)
			 ORDER BY created_at ASC, id ASC`,
			[accountId, trigger ?? null, trigger ?? null],
		);
	}

	/** Resolve a pending attempt. False for an unknown or already-resolved row. */
	async resolveAttempt(
		id: string,
		resolution: AnthropicBankedResetResolution,
	): Promise<boolean> {
		const changes = await this.runWithChanges(
			`
			UPDATE anthropic_banked_reset_events
			SET status = ?, reason = ?, cleared = ?, resets_left = ?,
				error_message = ?, next_attempt_at = NULL, resolved_at = ?
			WHERE id = ? AND status = 'pending'
		`,
			[
				resolution.status,
				resolution.reason ?? null,
				resolution.cleared ? JSON.stringify(resolution.cleared) : null,
				resolution.resetsLeft ?? null,
				resolution.errorMessage ?? null,
				resolution.now,
				id,
			],
		);
		return changes > 0;
	}

	/**
	 * Defer the replay of a still-pending attempt, recording why the last one
	 * went unanswered. False when the row is no longer pending.
	 */
	async setNextAttemptAt(
		id: string,
		nextAttemptAt: number,
		errorMessage: string | null,
	): Promise<boolean> {
		const changes = await this.runWithChanges(
			`
			UPDATE anthropic_banked_reset_events
			SET next_attempt_at = ?, error_message = ?
			WHERE id = ? AND status = 'pending'
		`,
			[nextAttemptAt, errorMessage, id],
		);
		return changes > 0;
	}

	/**
	 * Give up on attempts unconfirmed for {@link ANTHROPIC_BANKED_RESET_PENDING_EXPIRY_MS}
	 * or longer, resolving them `failed`. Returns how many were expired.
	 */
	async expireStalePending(now: number): Promise<number> {
		return this.runWithChanges(
			`
			UPDATE anthropic_banked_reset_events
			SET status = 'failed',
				error_message = COALESCE(error_message, 'Claim unconfirmed for an hour'),
				next_attempt_at = NULL,
				resolved_at = ?
			WHERE status = 'pending' AND created_at <= ?
		`,
			[now, now - ANTHROPIC_BANKED_RESET_PENDING_EXPIRY_MS],
		);
	}

	/**
	 * When the last cooldown-anchoring auto attempt resolved for an account:
	 * MAX resolved_at over auto rows that spent a reset (`reset`), found it
	 * already spent (`already_used`) or were told there was no limit to clear
	 * (`not_limited`). The last one anchors so a window stuck at its limit
	 * cannot re-claim every scheduler tick. Null when there is none.
	 */
	async getLatestAutoApplyCooldownAnchorAt(
		accountId: string,
	): Promise<number | null> {
		const row = await this.get<{ latest: number | null }>(
			`
			SELECT MAX(resolved_at) AS latest FROM anthropic_banked_reset_events
			WHERE account_id = ? AND trigger = 'auto'
				AND status IN ('reset','already_used','not_limited')
		`,
			[accountId],
		);
		return row?.latest ?? null;
	}

	async nextAttemptSeq(accountId: string, grantId: string): Promise<number> {
		return (
			((await this.latestAutoRow(accountId, grantId))?.attempt_seq ?? 0) + 1
		);
	}

	/** Most recent ledger rows for an account, newest first. */
	async findRecentForAccount(
		accountId: string,
		limit: number,
	): Promise<AnthropicBankedResetEventRow[]> {
		return this.query<AnthropicBankedResetEventRow>(
			`
			SELECT * FROM anthropic_banked_reset_events
			WHERE account_id = ?
			ORDER BY created_at DESC, id DESC
			LIMIT ?
		`,
			[accountId, limit],
		);
	}

	private async latestAutoRow(
		accountId: string,
		grantId: string,
	): Promise<AnthropicBankedResetEventRow | null> {
		return this.get<AnthropicBankedResetEventRow>(
			`
			SELECT * FROM anthropic_banked_reset_events
			WHERE trigger = 'auto' AND account_id = ? AND grant_id = ?
			ORDER BY attempt_seq DESC
			LIMIT 1
		`,
			[accountId, grantId],
		);
	}
}

function toAutoClaim(
	row: AnthropicBankedResetEventRow,
): AnthropicBankedResetAutoClaim {
	return {
		id: row.id,
		requestId: row.request_id,
		attemptSeq: row.attempt_seq ?? 0,
		reused: true,
	};
}
