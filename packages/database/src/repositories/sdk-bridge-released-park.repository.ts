import type {
	SdkBridgeReleasedPark,
	SdkBridgeReleasedParkInsert,
	SdkBridgeReleasedParkState,
	SdkBridgeTurnFinish,
} from "@clankermux/types";
import { BaseRepository } from "./base.repository";

interface ParkRow {
	turn_id: string;
	state: string;
	owner_api_key_id: string | null;
	conversation_key_hash: string | null;
	session_id: string;
	session_file: string;
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
		sessionFile: row.session_file,
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

/**
 * The turn is not finished (a missing row counts as open): a park never
 * becomes released or claimed for a turn that already ended.
 */
const TURN_OPEN = `NOT EXISTS (
	SELECT 1 FROM sdk_bridge_turns t WHERE t.id = ? AND t.finished_at IS NOT NULL
)`;

const FINISH_TURN = `UPDATE sdk_bridge_turns SET
	finished_at = ?, status = ?, http_status = ?, error_type = ?,
	error_message = ?, duration_ms = COALESCE(?, duration_ms)
	WHERE id = ? AND finished_at IS NULL`;

function finishParams(
	id: string,
	finish: SdkBridgeTurnFinish,
): Array<string | number | null> {
	return [
		finish.finishedAt,
		finish.status,
		finish.httpStatus ?? null,
		finish.errorType ?? null,
		finish.errorMessage ?? null,
		finish.durationMs ?? null,
		id,
	];
}

/**
 * `sdk_bridge_released_parks`: the durable half of a released park, whose
 * session file the bridge keeps. Every transition names the state it leaves,
 * so two claimants or a late cleanup cannot both win, and returns whether it
 * applied. Unlike the turn recorder's writes, failures throw: a park whose
 * state is unknown must not be resumed or deleted on a guess.
 */
export class SdkBridgeReleasedParkRepository extends BaseRepository<SdkBridgeReleasedPark> {
	async insertPreparing(park: SdkBridgeReleasedParkInsert): Promise<void> {
		await this.run(
			`INSERT INTO sdk_bridge_released_parks (
				turn_id, state, owner_api_key_id, conversation_key_hash, session_id,
				session_file, resume_at, awaited_tool_use_ids, requested_model,
				descriptor, active_ms, parked_since, expires_at, file_bytes,
				claim_owner, claimed_at, created_at
			) VALUES (?, 'preparing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
			[
				park.turnId,
				park.ownerApiKeyId,
				park.conversationKeyHash,
				park.sessionId,
				park.sessionFile,
				park.resumeAt,
				JSON.stringify(park.awaitedToolUseIds),
				park.requestedModel,
				park.descriptor,
				park.activeMs,
				park.parkedSince,
				park.expiresAt,
				park.fileBytes,
				park.createdAt,
			],
		);
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
		file: { sessionFile: string; fileBytes: number },
	): Promise<boolean> {
		return this.adapter.runTransaction(() => {
			const db = this.adapter.getSQLiteDb();
			const changed = db.run(
				`UPDATE sdk_bridge_released_parks
				SET state = 'released', session_file = ?, file_bytes = ?
				WHERE turn_id = ? AND state = 'preparing' AND ${TURN_OPEN}`,
				[file.sessionFile, file.fileBytes, turnId, turnId],
			).changes;
			if (changed !== 1) return false;
			db.run(`UPDATE sdk_bridge_turns SET status = 'released' WHERE id = ?`, [
				turnId,
			]);
			return true;
		});
	}

	/** released → claimed by `owner`; false when another claimant was first. */
	async claim(turnId: string, owner: string, at: number): Promise<boolean> {
		return this.adapter.runTransaction(() => {
			const db = this.adapter.getSQLiteDb();
			const changed = db.run(
				`UPDATE sdk_bridge_released_parks
				SET state = 'claimed', claim_owner = ?, claimed_at = ?
				WHERE turn_id = ? AND state = 'released' AND ${TURN_OPEN}`,
				[owner, at, turnId, turnId],
			).changes;
			if (changed !== 1) return false;
			db.run(`UPDATE sdk_bridge_turns SET status = 'running' WHERE id = ?`, [
				turnId,
			]);
			return true;
		});
	}

	/**
	 * claimed → released, when no model call followed the claim. A null owner
	 * takes back anyone's claim: startup recovery, whose claims are all stale.
	 */
	async unclaim(turnId: string, owner: string | null): Promise<boolean> {
		return this.adapter.runTransaction(() => {
			const db = this.adapter.getSQLiteDb();
			const changed = db.run(
				`UPDATE sdk_bridge_released_parks
				SET state = 'released', claim_owner = NULL, claimed_at = NULL
				WHERE turn_id = ? AND state = 'claimed'
					AND (? IS NULL OR claim_owner = ?)`,
				[turnId, owner, owner],
			).changes;
			if (changed !== 1) return false;
			db.run(`UPDATE sdk_bridge_turns SET status = 'released' WHERE id = ?`, [
				turnId,
			]);
			return true;
		});
	}

	/** claimed → consumed, written before the resumed query's first model call goes out. */
	async markConsumed(turnId: string, owner: string): Promise<boolean> {
		const changed = await this.runWithChanges(
			`UPDATE sdk_bridge_released_parks SET state = 'consumed'
			WHERE turn_id = ? AND state = 'claimed' AND claim_owner = ?`,
			[turnId, owner],
		);
		return changed === 1;
	}

	async delete(turnId: string): Promise<void> {
		await this.run(`DELETE FROM sdk_bridge_released_parks WHERE turn_id = ?`, [
			turnId,
		]);
	}

	/**
	 * End the turn and forget its park together: expiry, supersession,
	 * recovery. A turn that already finished keeps its outcome; its park is
	 * deleted all the same.
	 */
	async closeTurn(turnId: string, finish: SdkBridgeTurnFinish): Promise<void> {
		await this.adapter.runTransaction(() => {
			const db = this.adapter.getSQLiteDb();
			db.run(`DELETE FROM sdk_bridge_released_parks WHERE turn_id = ?`, [
				turnId,
			]);
			db.run(FINISH_TURN, finishParams(turnId, finish));
		});
	}

	/**
	 * Close turns an earlier process left open (`running` or `released`,
	 * started before `startedBefore`) that no park keeps alive: nothing can
	 * finish them now. Returns how many were closed.
	 */
	async closeOpenTurnsWithoutPark(
		startedBefore: number,
		finish: SdkBridgeTurnFinish,
	): Promise<number> {
		return this.runWithChanges(
			`UPDATE sdk_bridge_turns SET
				finished_at = ?, status = ?, http_status = ?, error_type = ?,
				error_message = ?
			WHERE finished_at IS NULL AND status IN ('running', 'released')
				AND started_at < ?
				AND NOT EXISTS (
					SELECT 1 FROM sdk_bridge_released_parks p
					WHERE p.turn_id = sdk_bridge_turns.id
				)`,
			[
				finish.finishedAt,
				finish.status,
				finish.httpStatus ?? null,
				finish.errorType ?? null,
				finish.errorMessage ?? null,
				startedBefore,
			],
		);
	}
}
