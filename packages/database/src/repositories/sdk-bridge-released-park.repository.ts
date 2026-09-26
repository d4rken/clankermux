import type {
	SdkBridgeParkLease,
	SdkBridgeReleasedPark,
	SdkBridgeReleasedParkInsert,
	SdkBridgeReleasedParkState,
	SdkBridgeTurnFinish,
} from "@clankermux/types";
import type { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { BaseRepository } from "./base.repository";

interface ParkRow {
	turn_id: string;
	state: string;
	owner_api_key_id: string | null;
	conversation_key_hash: string | null;
	session_id: string;
	session_path: string;
	resume_at: string;
	awaited_tool_use_ids: string;
	requested_model: string;
	descriptor: string;
	active_ms: number;
	parked_since: number;
	expires_at: number;
	file_bytes: number;
	claim_owner: string | null;
	claimed_at: number | null;
	created_at: number;
}

/** A JSON list of strings; anything else reads as awaiting nothing (unusable). */
function toolUseIds(json: string): string[] {
	try {
		const parsed: unknown = JSON.parse(json);
		if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string"))
			return parsed as string[];
	} catch {}
	return [];
}

function toPark(row: ParkRow): SdkBridgeReleasedPark {
	return {
		turnId: row.turn_id,
		state: row.state as SdkBridgeReleasedParkState,
		ownerApiKeyId: row.owner_api_key_id,
		conversationKeyHash: row.conversation_key_hash,
		sessionId: row.session_id,
		sessionPath: row.session_path,
		resumeAt: row.resume_at,
		awaitedToolUseIds: toolUseIds(row.awaited_tool_use_ids),
		requestedModel: row.requested_model,
		descriptor: row.descriptor,
		activeMs: Number(row.active_ms),
		parkedSince: Number(row.parked_since),
		expiresAt: Number(row.expires_at),
		fileBytes: Number(row.file_bytes),
		claimOwner: row.claim_owner,
		claimedAt: row.claimed_at === null ? null : Number(row.claimed_at),
		createdAt: Number(row.created_at),
	};
}

/** The statement applies only while `token` holds the lease. */
const LEASED = `EXISTS (SELECT 1 FROM sdk_bridge_park_lease WHERE id = 1 AND token = ?)`;

/**
 * The turn is not finished (a missing row counts as open): a park never
 * becomes released or claimed for a turn that already ended.
 */
const TURN_OPEN = `NOT EXISTS (
	SELECT 1 FROM sdk_bridge_turns t WHERE t.id = ? AND t.finished_at IS NOT NULL
)`;

type Binding = string | number | null;

function leaseHeld(
	db: ReturnType<BunSqlAdapter["getSQLiteDb"]>,
	token: string,
): boolean {
	const row = db.query(`SELECT ${LEASED} AS held`).get(token) as {
		held: number;
	} | null;
	return row?.held === 1;
}

function finishParams(finish: SdkBridgeTurnFinish): Binding[] {
	return [
		finish.finishedAt,
		finish.status,
		finish.httpStatus ?? null,
		finish.errorType ?? null,
		finish.errorMessage ?? null,
	];
}

/**
 * `sdk_bridge_released_parks`, and the lease that decides who may write it.
 *
 * The lease (`sdk_bridge_park_lease`, one row) is the only authority over
 * parks. Every write to a park, and to a turn a park owns, names the token it
 * acts under and applies only while that token holds the lease, in the same
 * statement or transaction: a process that lost the lease (declared dead,
 * or disposed) writes nothing, whatever it still has in flight. Every
 * transition also names the state it leaves. Both kinds of refusal return
 * false (0 changes); database failures throw.
 */
export class SdkBridgeReleasedParkRepository extends BaseRepository<SdkBridgeReleasedPark> {
	/** The same repository with a short busy-retry budget: startup recovery's. */
	withBusyRetryBudget(ms: number): SdkBridgeReleasedParkRepository {
		return new SdkBridgeReleasedParkRepository(
			(this.adapter as BunSqlAdapter).withBusyRetryBudget(ms),
		);
	}

	/**
	 * Take the lease: when nobody holds it, when `lease.token` already does,
	 * or when `holderDead` says the holder's process is gone. One
	 * transaction, so two processes cannot both take it.
	 */
	async acquireLease(
		lease: SdkBridgeParkLease,
		holderDead: (held: SdkBridgeParkLease) => boolean,
	): Promise<boolean> {
		return this.adapter.runTransaction(() => {
			const db = this.adapter.getSQLiteDb();
			const held = db
				.query(
					"SELECT dir, pid, start_time, token, acquired_at FROM sdk_bridge_park_lease WHERE id = 1",
				)
				.get() as {
				dir: string;
				pid: number;
				start_time: string | null;
				token: string;
				acquired_at: number;
			} | null;
			if (
				held &&
				held.token !== lease.token &&
				!holderDead({
					dir: held.dir,
					pid: Number(held.pid),
					startTime: held.start_time,
					token: held.token,
					at: Number(held.acquired_at),
				})
			)
				return false;
			db.run(
				`INSERT INTO sdk_bridge_park_lease (id, dir, pid, start_time, token, acquired_at)
				VALUES (1, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET dir = excluded.dir, pid = excluded.pid,
					start_time = excluded.start_time, token = excluded.token,
					acquired_at = excluded.acquired_at`,
				[lease.dir, lease.pid, lease.startTime, lease.token, lease.at],
			);
			return true;
		});
	}

	async holdsLease(token: string): Promise<boolean> {
		const row = await this.get<{ token: string }>(
			"SELECT token FROM sdk_bridge_park_lease WHERE id = 1",
		);
		return row?.token === token;
	}

	async releaseLease(token: string): Promise<void> {
		await this.run(
			"DELETE FROM sdk_bridge_park_lease WHERE id = 1 AND token = ?",
			[token],
		);
	}

	/** A `preparing` record, written only under the lease. */
	async insertPreparing(
		park: SdkBridgeReleasedParkInsert,
		token: string,
	): Promise<boolean> {
		const changed = await this.runWithChanges(
			`INSERT INTO sdk_bridge_released_parks (
				turn_id, state, owner_api_key_id, conversation_key_hash, session_id,
				session_path, resume_at, awaited_tool_use_ids, requested_model,
				descriptor, active_ms, parked_since, expires_at, file_bytes,
				claim_owner, claimed_at, created_at
			) SELECT ?, 'preparing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?
			WHERE ${LEASED}`,
			[
				park.turnId,
				park.ownerApiKeyId,
				park.conversationKeyHash,
				park.sessionId,
				park.sessionPath,
				park.resumeAt,
				JSON.stringify(park.awaitedToolUseIds),
				park.requestedModel,
				park.descriptor,
				park.activeMs,
				park.parkedSince,
				park.expiresAt,
				park.fileBytes,
				park.createdAt,
				token,
			],
		);
		return changed === 1;
	}

	async find(turnId: string): Promise<SdkBridgeReleasedPark | null> {
		const row = await this.get<ParkRow>(
			`SELECT * FROM sdk_bridge_released_parks WHERE turn_id = ?`,
			[turnId],
		);
		return row ? toPark(row) : null;
	}

	async list(): Promise<SdkBridgeReleasedPark[]> {
		const rows = await this.query<ParkRow>(
			`SELECT * FROM sdk_bridge_released_parks ORDER BY created_at, turn_id`,
		);
		return rows.map(toPark);
	}

	/** preparing → released, once the file is published; the turn row reads `released`. */
	async markReleased(
		turnId: string,
		file: { sessionPath: string; fileBytes: number },
		token: string,
	): Promise<boolean> {
		return this.adapter.runTransaction(() => {
			const db = this.adapter.getSQLiteDb();
			const changed = db.run(
				`UPDATE sdk_bridge_released_parks
				SET state = 'released', session_path = ?, file_bytes = ?
				WHERE turn_id = ? AND state = 'preparing' AND ${TURN_OPEN} AND ${LEASED}`,
				[file.sessionPath, file.fileBytes, turnId, turnId, token],
			).changes;
			if (changed !== 1) return false;
			db.run(`UPDATE sdk_bridge_turns SET status = 'released' WHERE id = ?`, [
				turnId,
			]);
			return true;
		});
	}

	/**
	 * released → claimed under `token`, which also becomes the claim owner;
	 * the turn row reads `running` and names the claiming process as its
	 * owner. False when another claimant was first or the lease is not ours.
	 */
	async claim(
		turnId: string,
		token: string,
		at: number,
		owner: { pid: number; startTime: string | null },
	): Promise<boolean> {
		return this.adapter.runTransaction(() => {
			const db = this.adapter.getSQLiteDb();
			const changed = db.run(
				`UPDATE sdk_bridge_released_parks
				SET state = 'claimed', claim_owner = ?, claimed_at = ?
				WHERE turn_id = ? AND state = 'released' AND ${TURN_OPEN} AND ${LEASED}`,
				[token, at, turnId, turnId, token],
			).changes;
			if (changed !== 1) return false;
			db.run(
				`UPDATE sdk_bridge_turns SET status = 'running', owner_pid = ?,
					owner_start_time = ? WHERE id = ?`,
				[owner.pid, owner.startTime, turnId],
			);
			return true;
		});
	}

	/**
	 * claimed → released, when no model call followed the claim. Only this
	 * token's claim, unless `anyClaimant` (recovery, whose claims found at
	 * startup are all stale).
	 */
	async unclaim(
		turnId: string,
		token: string,
		opts: { anyClaimant?: boolean } = {},
	): Promise<boolean> {
		return this.adapter.runTransaction(() => {
			const db = this.adapter.getSQLiteDb();
			const changed = db.run(
				`UPDATE sdk_bridge_released_parks
				SET state = 'released', claim_owner = NULL, claimed_at = NULL
				WHERE turn_id = ? AND state = 'claimed'
					AND (? = 1 OR claim_owner = ?) AND ${LEASED}`,
				[turnId, opts.anyClaimant ? 1 : 0, token, token],
			).changes;
			if (changed !== 1) return false;
			db.run(
				`UPDATE sdk_bridge_turns SET status = 'released'
				WHERE id = ? AND finished_at IS NULL`,
				[turnId],
			);
			return true;
		});
	}

	/** claimed → consumed, written before the resumed query's first model call goes out. */
	async markConsumed(turnId: string, token: string): Promise<boolean> {
		const changed = await this.runWithChanges(
			`UPDATE sdk_bridge_released_parks SET state = 'consumed'
			WHERE turn_id = ? AND state = 'claimed' AND claim_owner = ? AND ${LEASED}`,
			[turnId, token, token],
		);
		return changed === 1;
	}

	async delete(turnId: string, token: string): Promise<boolean> {
		const changed = await this.runWithChanges(
			`DELETE FROM sdk_bridge_released_parks WHERE turn_id = ? AND ${LEASED}`,
			[turnId, token],
		);
		return changed === 1;
	}

	/**
	 * End the turn and forget its park together: expiry, supersession,
	 * recovery. A turn that already finished keeps its outcome; its park is
	 * deleted all the same. False, writing nothing, without the lease.
	 */
	async closeTurn(
		turnId: string,
		finish: SdkBridgeTurnFinish,
		token: string,
	): Promise<boolean> {
		return this.adapter.runTransaction(() => {
			const db = this.adapter.getSQLiteDb();
			if (!leaseHeld(db, token)) return false;
			db.run(`DELETE FROM sdk_bridge_released_parks WHERE turn_id = ?`, [
				turnId,
			]);
			db.run(
				`UPDATE sdk_bridge_turns SET
					finished_at = ?, status = ?, http_status = ?, error_type = ?,
					error_message = ?, duration_ms = COALESCE(?, duration_ms)
				WHERE id = ? AND finished_at IS NULL`,
				[...finishParams(finish), finish.durationMs ?? null, turnId],
			);
			return true;
		});
	}

	/**
	 * Close turns left open (`running` or `released`, started before
	 * `startedBefore`) that no park keeps alive and whose owning process is
	 * gone (`ownerDead`; a row with no recorded owner predates the column and
	 * counts as gone). Under the lease only. Returns how many were closed.
	 */
	async closeOpenTurnsWithoutPark(
		startedBefore: number,
		finish: SdkBridgeTurnFinish,
		token: string,
		ownerDead: (owner: { pid: number; startTime: string | null }) => boolean,
	): Promise<number> {
		return this.adapter.runTransaction(() => {
			const db = this.adapter.getSQLiteDb();
			if (!leaseHeld(db, token)) return 0;
			const open = db
				.query(
					`SELECT id, owner_pid, owner_start_time FROM sdk_bridge_turns
					WHERE finished_at IS NULL AND status IN ('running', 'released')
						AND started_at < ?
						AND NOT EXISTS (
							SELECT 1 FROM sdk_bridge_released_parks p
							WHERE p.turn_id = sdk_bridge_turns.id
						)`,
				)
				.all(startedBefore) as Array<{
				id: string;
				owner_pid: number | null;
				owner_start_time: string | null;
			}>;
			let closed = 0;
			for (const row of open) {
				if (
					row.owner_pid !== null &&
					!ownerDead({
						pid: Number(row.owner_pid),
						startTime: row.owner_start_time,
					})
				)
					continue;
				closed += db.run(
					`UPDATE sdk_bridge_turns SET
						finished_at = ?, status = ?, http_status = ?, error_type = ?,
						error_message = ?
					WHERE id = ? AND finished_at IS NULL`,
					[...finishParams(finish), row.id],
				).changes;
			}
			return closed;
		});
	}
}
