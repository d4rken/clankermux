import {
	ANTHROPIC_BANKED_RESET_REPLAY_WINDOW_MS,
	type AnthropicBankedResetEventStatus,
	type AnthropicBankedResetWindow,
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
	/**
	 * ms epoch before which no new auto attempt may start on the account, set
	 * on a `not_limited`, `cooldown` or `ineligible` resolution.
	 */
	rearm_at: number | null;
	/**
	 * ms epoch until which a spent reset still owes the account's overage
	 * pause a verdict: set when the post-claim usage read was unavailable,
	 * cleared once a later reading decides it, or when this passes.
	 */
	recovery_pending_until: number | null;
	/** The account's pause_epoch when the claim was sent: the pause owed. */
	recovery_pause_epoch: number | null;
	/** That pause's pause_changed_at (ms); null when unrecorded. */
	recovery_pause_changed_at: number | null;
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
 * `pending_other` means another claim on the account (`row`, manual or auto)
 * is still unconfirmed: a new request id could spend a second reset if that
 * one landed, so only a retry under its own request id may be sent.
 */
export type AnthropicBankedResetManualBegin =
	| { kind: "created"; row: AnthropicBankedResetEventRow }
	| { kind: "existing"; row: AnthropicBankedResetEventRow }
	| { kind: "grant_mismatch"; row: AnthropicBankedResetEventRow }
	| { kind: "pending_other"; row: AnthropicBankedResetEventRow };

export interface AnthropicBankedResetResolution {
	status: AnthropicBankedResetEventResolvedStatus;
	reason?: string | null;
	cleared?: AnthropicBankedResetWindow[] | null;
	resetsLeft?: number | null;
	errorMessage?: string | null;
	/** The server's `cooldown_until`, ms epoch. */
	cooldownUntil?: number | null;
	/**
	 * An overage-pause verdict this resolution owes, recorded in the same write
	 * so no crash can separate the spent reset from the obligation.
	 */
	recovery?: {
		until: number;
		pauseEpoch: number;
		pauseChangedAt: number | null;
	} | null;
	now: number;
}

/**
 * How long after a `not_limited`, `cooldown` or `ineligible` answer no new
 * auto attempt starts on the account (longer when the server's
 * `cooldown_until` is later).
 */
export const ANTHROPIC_BANKED_RESET_REARM_MS = 60 * 60 * 1000;

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
 * While any claim on an account is pending, no new request id is recorded
 * for it, manual or auto: that claim may already have spent a reset, and only
 * a replay under its own request id can find out. A row is replayed only
 * within {@link ANTHROPIC_BANKED_RESET_REPLAY_WINDOW_MS} of `created_at`,
 * which is written before its first POST; {@link expireStalePending} then
 * gives it up.
 *
 * A grant holds several resets, so no outcome ends automation for it: when the
 * next attempt may start is the scheduler's decision, from
 * {@link getRearmAt} and {@link getLatestAutoApplyCooldownAnchorAt}.
 */
export class AnthropicBankedResetEventRepository extends BaseRepository<AnthropicBankedResetEventRow> {
	/**
	 * Claim (or reuse) the next auto attempt for a grant. The grant's own
	 * still-pending attempt is returned as-is, whatever its cause. Returns null
	 * while any other claim on the account is pending, manual or auto.
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
			WHERE NOT EXISTS (
				SELECT 1 FROM anthropic_banked_reset_events
				WHERE account_id = ? AND status = 'pending'
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
				input.accountId,
			],
		);
		if (changes > 0) return { id, requestId, attemptSeq, reused: false };

		// A concurrent claim won, or another pending claim on the account
		// blocked it. Reuse only a still-pending row for THIS grant.
		const winner = await this.latestAutoRow(input.accountId, input.grantId);
		return winner?.status === "pending" ? toAutoClaim(winner) : null;
	}

	/**
	 * Record a manual claim before its POST, reconciling a replayed request id.
	 * The insert and the check for another pending claim are one statement, so
	 * two new claims racing on one account cannot both be recorded.
	 */
	async beginManualAttempt(input: {
		accountId: string;
		accountName: string;
		grantId: string;
		requestId: string;
		grantEndsAt: number | null;
		now: number;
	}): Promise<AnthropicBankedResetManualBegin> {
		// The blocking row can resolve between the insert and the lookup, which
		// leaves neither; the second pass then records the claim.
		for (let attempt = 0; attempt < 2; attempt++) {
			const changes = await this.runWithChanges(
				`
				INSERT OR IGNORE INTO anthropic_banked_reset_events (
					id, account_id, account_name, grant_id, trigger, cause,
					attempt_seq, request_id, status, grant_ends_at, created_at
				)
				SELECT ?, ?, ?, ?, 'manual', NULL, NULL, ?, 'pending', ?, ?
				WHERE NOT EXISTS (
					SELECT 1 FROM anthropic_banked_reset_events
					WHERE account_id = ? AND status = 'pending' AND request_id <> ?
				)
			`,
				[
					crypto.randomUUID(),
					input.accountId,
					input.accountName,
					input.grantId,
					input.requestId,
					input.grantEndsAt,
					input.now,
					input.accountId,
					input.requestId,
				],
			);
			const row = await this.findByRequestId(input.accountId, input.requestId);
			if (row) {
				if (changes > 0) return { kind: "created", row };
				return row.grant_id === input.grantId
					? { kind: "existing", row }
					: { kind: "grant_mismatch", row };
			}
			const blocking = await this.get<AnthropicBankedResetEventRow>(
				`SELECT * FROM anthropic_banked_reset_events
				 WHERE account_id = ? AND status = 'pending' AND request_id <> ?
				 ORDER BY trigger = 'manual' DESC, created_at DESC, id DESC
				 LIMIT 1`,
				[input.accountId, input.requestId],
			);
			if (blocking) return { kind: "pending_other", row: blocking };
		}
		throw new Error(
			`Banked-reset ledger row for request ${input.requestId} was not recorded`,
		);
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

	/**
	 * Resolve a pending attempt, or record the answer to one given up as
	 * `unconfirmed` while its POST was still in flight: the server's answer
	 * outranks the give-up. False for an unknown or otherwise resolved row.
	 */
	async resolveAttempt(
		id: string,
		resolution: AnthropicBankedResetResolution,
	): Promise<boolean> {
		const changes = await this.runWithChanges(
			`
			UPDATE anthropic_banked_reset_events
			SET status = ?, reason = ?, cleared = ?, resets_left = ?,
				error_message = ?, next_attempt_at = NULL, resolved_at = ?,
				rearm_at = ?, recovery_pending_until = ?, recovery_pause_epoch = ?,
				recovery_pause_changed_at = ?
			WHERE id = ?
				AND (status = 'pending' OR (status = 'failed' AND reason = 'unconfirmed'))
		`,
			[
				resolution.status,
				resolution.reason ?? null,
				resolution.cleared ? JSON.stringify(resolution.cleared) : null,
				resolution.resetsLeft ?? null,
				resolution.errorMessage ?? null,
				resolution.now,
				REARMING_STATUSES.has(resolution.status)
					? Math.max(
							resolution.now + ANTHROPIC_BANKED_RESET_REARM_MS,
							resolution.cooldownUntil ?? 0,
						)
					: null,
				resolution.recovery?.until ?? null,
				resolution.recovery?.pauseEpoch ?? null,
				resolution.recovery?.pauseChangedAt ?? null,
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
	 * Give up on attempts whose replay window has closed, resolving them
	 * `failed` with reason `unconfirmed`. Returns how many were given up.
	 */
	async expireStalePending(now: number): Promise<number> {
		return this.runWithChanges(
			`
			UPDATE anthropic_banked_reset_events
			SET status = 'failed',
				reason = 'unconfirmed',
				error_message = ? || COALESCE(' (last: ' || error_message || ')', ''),
				next_attempt_at = NULL,
				resolved_at = ?
			WHERE status = 'pending' AND created_at <= ?
		`,
			[
				`Unconfirmed ${ANTHROPIC_BANKED_RESET_REPLAY_WINDOW_MS / 60_000} minutes after the attempt started; its request id is no longer replayed`,
				now,
				now - ANTHROPIC_BANKED_RESET_REPLAY_WINDOW_MS,
			],
		);
	}

	/**
	 * Before when no new auto attempt may start on the account: the latest
	 * re-arm deadline over its `not_limited`, `cooldown` and `ineligible`
	 * resolutions, manual and auto. Null when there is none.
	 */
	async getRearmAt(accountId: string): Promise<number | null> {
		const row = await this.get<{ latest: number | null }>(
			`SELECT MAX(rearm_at) AS latest FROM anthropic_banked_reset_events
			 WHERE account_id = ?`,
			[accountId],
		);
		return row?.latest ?? null;
	}

	/**
	 * When the last auto attempt that restored the account's windows resolved:
	 * MAX resolved_at over auto rows that spent a reset (`reset`) or found it
	 * already spent (`already_used`). Anchors the weekly trigger's cooldown so a
	 * usage reading that lags the reset cannot spend another. Null when there
	 * is none.
	 */
	async getLatestAutoApplyCooldownAnchorAt(
		accountId: string,
	): Promise<number | null> {
		const row = await this.get<{ latest: number | null }>(
			`
			SELECT MAX(resolved_at) AS latest FROM anthropic_banked_reset_events
			WHERE account_id = ? AND trigger = 'auto'
				AND status IN ('reset','already_used')
		`,
			[accountId],
		);
		return row?.latest ?? null;
	}

	/** Rows still owing a verdict, every account, oldest first. */
	async findRecoveryPending(): Promise<AnthropicBankedResetEventRow[]> {
		return this.query<AnthropicBankedResetEventRow>(
			`SELECT * FROM anthropic_banked_reset_events
			 WHERE recovery_pending_until IS NOT NULL
			 ORDER BY created_at ASC, id ASC`,
			[],
		);
	}

	async clearRecoveryPending(id: string): Promise<boolean> {
		const changes = await this.runWithChanges(
			`UPDATE anthropic_banked_reset_events SET recovery_pending_until = NULL
			 WHERE id = ? AND recovery_pending_until IS NOT NULL`,
			[id],
		);
		return changes > 0;
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

const REARMING_STATUSES: ReadonlySet<AnthropicBankedResetEventResolvedStatus> =
	new Set(["not_limited", "cooldown", "ineligible"]);

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
