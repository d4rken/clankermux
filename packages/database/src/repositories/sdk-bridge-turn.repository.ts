import type {
	SdkBridgeHistoryMode,
	SdkBridgeInnerSummary,
	SdkBridgeLegErrorPhase,
	SdkBridgeLegFinish,
	SdkBridgeLegInsert,
	SdkBridgeLegKind,
	SdkBridgeTurn,
	SdkBridgeTurnCounterDelta,
	SdkBridgeTurnDetail,
	SdkBridgeTurnFinish,
	SdkBridgeTurnInsert,
	SdkBridgeTurnLeg,
	SdkBridgeTurnStatus,
} from "@clankermux/types";
import { BaseRepository } from "./base.repository";

interface TurnRow {
	id: string;
	started_at: number;
	finished_at: number | null;
	status: string;
	http_status: number | null;
	error_type: string | null;
	error_message: string | null;
	api_key_id: string | null;
	api_key_name: string | null;
	account_id: string | null;
	model: string | null;
	client_harness: string | null;
	client_user_agent: string | null;
	project: string | null;
	conversation_key_hash: string | null;
	cc_session_id: string | null;
	history_mode: string;
	rebuild_reason: string | null;
	system_prompt_policy: string;
	stop_reason: string | null;
	leg_count: number;
	tool_round_count: number;
	inner_call_count: number;
	inner_error_count: number;
	spawn_ms: number | null;
	first_event_ms: number | null;
	duration_ms: number | null;
	sdk_num_turns: number | null;
	sdk_input_tokens: number | null;
	sdk_output_tokens: number | null;
	sdk_cache_read_input_tokens: number | null;
	sdk_cache_creation_input_tokens: number | null;
	ignored_fields: string | null;
}

interface LegRow {
	id: string;
	turn_id: string;
	kind: string;
	started_at: number;
	finished_at: number | null;
	http_status: number | null;
	error_phase: string | null;
	stop_reason: string | null;
	error_type: string | null;
	error_message: string | null;
	tool_use_ids: string | null;
}

interface InnerSummaryRow {
	request_count: number;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_input_tokens: number | null;
	cache_creation_input_tokens: number | null;
	cost_usd: number | null;
}

function toTurn(row: TurnRow): SdkBridgeTurn {
	return {
		id: row.id,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		status: row.status as SdkBridgeTurnStatus,
		httpStatus: row.http_status,
		errorType: row.error_type,
		errorMessage: row.error_message,
		apiKeyId: row.api_key_id,
		apiKeyName: row.api_key_name,
		accountId: row.account_id,
		model: row.model,
		clientHarness: row.client_harness,
		clientUserAgent: row.client_user_agent,
		project: row.project,
		conversationKeyHash: row.conversation_key_hash,
		ccSessionId: row.cc_session_id,
		historyMode: row.history_mode as SdkBridgeHistoryMode,
		rebuildReason: row.rebuild_reason,
		systemPromptPolicy: row.system_prompt_policy,
		stopReason: row.stop_reason,
		legCount: row.leg_count,
		toolRoundCount: row.tool_round_count,
		innerCallCount: row.inner_call_count,
		innerErrorCount: row.inner_error_count,
		spawnMs: row.spawn_ms,
		firstEventMs: row.first_event_ms,
		durationMs: row.duration_ms,
		sdkNumTurns: row.sdk_num_turns,
		sdkInputTokens: row.sdk_input_tokens,
		sdkOutputTokens: row.sdk_output_tokens,
		sdkCacheReadInputTokens: row.sdk_cache_read_input_tokens,
		sdkCacheCreationInputTokens: row.sdk_cache_creation_input_tokens,
		ignoredFields:
			row.ignored_fields === null
				? null
				: (JSON.parse(row.ignored_fields) as string[]),
	};
}

function toLeg(row: LegRow): SdkBridgeTurnLeg {
	return {
		id: row.id,
		turnId: row.turn_id,
		kind: row.kind as SdkBridgeLegKind,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		httpStatus: row.http_status,
		errorPhase: row.error_phase as SdkBridgeLegErrorPhase | null,
		stopReason: row.stop_reason,
		errorType: row.error_type,
		errorMessage: row.error_message,
		toolUseIds:
			row.tool_use_ids === null
				? null
				: (JSON.parse(row.tool_use_ids) as string[]),
	};
}

/**
 * Repository for `sdk_bridge_turns` and `sdk_bridge_turn_legs`. Retention is the
 * cleanup worker's (request-retention cutoff; legs cascade), so there is no
 * prune method here.
 */
export class SdkBridgeTurnRepository extends BaseRepository<SdkBridgeTurn> {
	async insertTurn(turn: SdkBridgeTurnInsert): Promise<void> {
		await this.run(
			`INSERT INTO sdk_bridge_turns (
				id, started_at, status, api_key_id, api_key_name, account_id, model,
				client_harness, client_user_agent, project, conversation_key_hash,
				cc_session_id, history_mode, rebuild_reason, system_prompt_policy,
				ignored_fields,
				leg_count, tool_round_count, inner_call_count, inner_error_count
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
			[
				turn.id,
				turn.startedAt,
				turn.status ?? "running",
				turn.apiKeyId ?? null,
				turn.apiKeyName ?? null,
				turn.accountId ?? null,
				turn.model ?? null,
				turn.clientHarness ?? null,
				turn.clientUserAgent ?? null,
				turn.project ?? null,
				turn.conversationKeyHash ?? null,
				turn.ccSessionId ?? null,
				turn.historyMode,
				turn.rebuildReason ?? null,
				turn.systemPromptPolicy,
				turn.ignoredFields?.length ? JSON.stringify(turn.ignoredFields) : null,
			],
		);
	}

	/**
	 * Write the turn's terminal facts. `ccSessionId` COALESCEs so a session id
	 * learned at admission (resume) survives a finish that does not repeat it.
	 */
	async finishTurn(id: string, finish: SdkBridgeTurnFinish): Promise<void> {
		await this.run(
			`UPDATE sdk_bridge_turns SET
				finished_at = ?,
				status = ?,
				http_status = ?,
				error_type = ?,
				error_message = ?,
				stop_reason = ?,
				cc_session_id = COALESCE(?, cc_session_id),
				spawn_ms = ?,
				first_event_ms = ?,
				duration_ms = ?,
				sdk_num_turns = ?,
				sdk_input_tokens = ?,
				sdk_output_tokens = ?,
				sdk_cache_read_input_tokens = ?,
				sdk_cache_creation_input_tokens = ?
			WHERE id = ?`,
			[
				finish.finishedAt,
				finish.status,
				finish.httpStatus ?? null,
				finish.errorType ?? null,
				finish.errorMessage ?? null,
				finish.stopReason ?? null,
				finish.ccSessionId ?? null,
				finish.spawnMs ?? null,
				finish.firstEventMs ?? null,
				finish.durationMs ?? null,
				// `?? null`, never `|| null`: a reported 0 is a reading.
				finish.sdkNumTurns ?? null,
				finish.sdkInputTokens ?? null,
				finish.sdkOutputTokens ?? null,
				finish.sdkCacheReadInputTokens ?? null,
				finish.sdkCacheCreationInputTokens ?? null,
				id,
			],
		);
	}

	/** One UPDATE, so concurrent bumps from inner calls never lose an increment. */
	async bumpTurnCounters(
		id: string,
		delta: SdkBridgeTurnCounterDelta,
	): Promise<void> {
		await this.run(
			`UPDATE sdk_bridge_turns SET
				tool_round_count = tool_round_count + ?,
				inner_call_count = inner_call_count + ?,
				inner_error_count = inner_error_count + ?
			WHERE id = ?`,
			[
				delta.toolRounds ?? 0,
				delta.innerCalls ?? 0,
				delta.innerErrors ?? 0,
				id,
			],
		);
	}

	/**
	 * Insert a leg and count it on its turn in one transaction. Throws when the
	 * turn does not exist (foreign key).
	 */
	async insertLeg(leg: SdkBridgeLegInsert): Promise<void> {
		await this.adapter.runTransaction(() => {
			const db = this.adapter.getSQLiteDb();
			db.run(
				`INSERT INTO sdk_bridge_turn_legs (id, turn_id, kind, started_at)
				VALUES (?, ?, ?, ?)`,
				[leg.id, leg.turnId, leg.kind, leg.startedAt],
			);
			db.run(
				`UPDATE sdk_bridge_turns SET leg_count = leg_count + 1 WHERE id = ?`,
				[leg.turnId],
			);
		});
	}

	async finishLeg(id: string, finish: SdkBridgeLegFinish): Promise<void> {
		await this.run(
			`UPDATE sdk_bridge_turn_legs SET
				finished_at = ?,
				http_status = ?,
				error_phase = ?,
				stop_reason = ?,
				error_type = ?,
				error_message = ?,
				tool_use_ids = ?
			WHERE id = ?`,
			[
				finish.finishedAt,
				finish.httpStatus ?? null,
				finish.errorPhase ?? null,
				finish.stopReason ?? null,
				finish.errorType ?? null,
				finish.errorMessage ?? null,
				finish.toolUseIds ? JSON.stringify(finish.toolUseIds) : null,
				id,
			],
		);
	}

	/**
	 * The turn, its legs oldest first, and sums over whichever inner `requests`
	 * rows still exist. Inner rows follow request retention on their own, so an
	 * inner summary smaller than `innerCallCount` is expected, not an error.
	 */
	async getTurnWithLegs(id: string): Promise<SdkBridgeTurnDetail | null> {
		const turn = await this.get<TurnRow>(
			`SELECT * FROM sdk_bridge_turns WHERE id = ?`,
			[id],
		);
		if (!turn) return null;
		const legs = await this.query<LegRow>(
			`SELECT * FROM sdk_bridge_turn_legs WHERE turn_id = ?
			ORDER BY started_at, id`,
			[id],
		);
		const inner = await this.get<InnerSummaryRow>(
			`SELECT
				COUNT(*) AS request_count,
				SUM(input_tokens) AS input_tokens,
				SUM(output_tokens) AS output_tokens,
				SUM(cache_read_input_tokens) AS cache_read_input_tokens,
				SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
				SUM(cost_usd) AS cost_usd
			FROM requests WHERE sdk_bridge_turn_id = ?`,
			[id],
		);
		const summary: SdkBridgeInnerSummary = {
			requestCount: inner?.request_count ?? 0,
			inputTokens: inner?.input_tokens ?? 0,
			outputTokens: inner?.output_tokens ?? 0,
			cacheReadInputTokens: inner?.cache_read_input_tokens ?? 0,
			cacheCreationInputTokens: inner?.cache_creation_input_tokens ?? 0,
			costUsd: inner?.cost_usd ?? 0,
		};
		return { turn: toTurn(turn), legs: legs.map(toLeg), inner: summary };
	}
}
