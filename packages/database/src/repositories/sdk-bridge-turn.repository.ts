import type {
	SdkBridgeHistoryMode,
	SdkBridgeInnerRequest,
	SdkBridgeInnerSummary,
	SdkBridgeLegErrorPhase,
	SdkBridgeLegFinish,
	SdkBridgeLegInsert,
	SdkBridgeLegKind,
	SdkBridgeRebuildReason,
	SdkBridgeSystemPromptDetail,
	SdkBridgeTurn,
	SdkBridgeTurnCounterDelta,
	SdkBridgeTurnDetail,
	SdkBridgeTurnFinish,
	SdkBridgeTurnInsert,
	SdkBridgeTurnKind,
	SdkBridgeTurnLeg,
	SdkBridgeTurnStatus,
} from "@clankermux/types";
import { BaseRepository } from "./base.repository";

interface TurnRow {
	id: string;
	kind: string;
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
	system_prompt_detail: string | null;
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

interface InnerRequestRow {
	id: string;
	timestamp: number;
	account_used: string | null;
	account_name: string | null;
	model: string | null;
	status_code: number | null;
	success: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_input_tokens: number | null;
	cache_creation_input_tokens: number | null;
	cost_usd: number | null;
}

interface InnerSummaryRow {
	request_count: number;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_input_tokens: number | null;
	cache_creation_input_tokens: number | null;
	cost_usd: number | null;
}

/** One group of {@link SdkBridgeTurnRepository.countHealthGroups}. */
export interface SdkBridgeHealthGroupRow {
	kind: string;
	status: string;
	historyMode: string;
	rebuildReason: string | null;
	clientHarness: string | null;
	accountId: string | null;
	/** Null when the account was deleted since. */
	accountName: string | null;
	count: number;
}

export interface SdkBridgeHealthErrorRow {
	status: string;
	errorType: string | null;
	httpStatus: number | null;
	count: number;
}

/** Nearest-rank percentiles and the sum; null percentiles with no samples. */
export interface SdkBridgeHealthPercentileRow {
	samples: number;
	p50: number | null;
	p95: number | null;
	total: number;
}

export type SdkBridgeHealthMetric =
	| "spawn_ms"
	| "first_event_ms"
	| "duration_ms"
	| "tool_round_count";

export interface SdkBridgeHealthInnerRow {
	/** The turn's harness. */
	clientHarness: string | null;
	/** The account that served the inner call (`requests.account_used`). */
	servedAccountId: string | null;
	/** Null when the account was deleted since. */
	servedAccountName: string | null;
	requestCount: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	costUsd: number;
}

export interface SdkBridgeHealthFailureRow {
	id: string;
	kind: string;
	status: string;
	startedAt: number;
	httpStatus: number | null;
	errorType: string | null;
	errorMessage: string | null;
	clientHarness: string | null;
	model: string | null;
}

function placeholders(values: readonly unknown[]): string {
	return values.map(() => "?").join(", ");
}

function toTurn(row: TurnRow): SdkBridgeTurn {
	return {
		id: row.id,
		kind: row.kind as SdkBridgeTurnKind,
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
		rebuildReason: row.rebuild_reason as SdkBridgeRebuildReason | null,
		systemPromptPolicy: row.system_prompt_policy,
		systemPromptDetail:
			row.system_prompt_detail === null
				? null
				: (JSON.parse(row.system_prompt_detail) as SdkBridgeSystemPromptDetail),
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
 * A write to a park-owned turn carries the park lease token (`fence`) and
 * applies only while that token holds the lease, in the same statement; a
 * write with no token (an ordinary turn) is never fenced.
 */
const FENCED = `(? IS NULL OR EXISTS (
	SELECT 1 FROM sdk_bridge_park_lease WHERE id = 1 AND token = ?
))`;

function fenceParams(
	fence: string | undefined,
): [string | null, string | null] {
	return [fence ?? null, fence ?? null];
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
				id, kind, started_at, status, api_key_id, api_key_name, account_id,
				model, client_harness, client_user_agent, project,
				conversation_key_hash, cc_session_id, history_mode, rebuild_reason,
				system_prompt_policy, system_prompt_detail, ignored_fields,
				owner_pid, owner_start_time,
				leg_count, tool_round_count, inner_call_count, inner_error_count
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
			[
				turn.id,
				turn.kind ?? "turn",
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
				turn.systemPromptDetail
					? JSON.stringify(turn.systemPromptDetail)
					: null,
				turn.ignoredFields?.length ? JSON.stringify(turn.ignoredFields) : null,
				turn.ownerPid ?? null,
				turn.ownerStartTime ?? null,
			],
		);
	}

	/**
	 * Write the turn's terminal facts, once: a finished turn keeps the ones it
	 * has. `ccSessionId` COALESCEs so a session id learned at admission
	 * (resume) survives a finish that does not repeat it. True when this
	 * write finished the turn.
	 */
	async finishTurn(
		id: string,
		finish: SdkBridgeTurnFinish,
		fence?: string,
	): Promise<boolean> {
		const changed = await this.runWithChanges(
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
			WHERE id = ? AND finished_at IS NULL AND ${FENCED}`,
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
				...fenceParams(fence),
			],
		);
		return changed === 1;
	}

	/** One UPDATE, so concurrent bumps from inner calls never lose an increment. */
	async bumpTurnCounters(
		id: string,
		delta: SdkBridgeTurnCounterDelta,
		fence?: string,
	): Promise<void> {
		await this.run(
			`UPDATE sdk_bridge_turns SET
				tool_round_count = tool_round_count + ?,
				inner_call_count = inner_call_count + ?,
				inner_error_count = inner_error_count + ?
			WHERE id = ? AND ${FENCED}`,
			[
				delta.toolRounds ?? 0,
				delta.innerCalls ?? 0,
				delta.innerErrors ?? 0,
				id,
				...fenceParams(fence),
			],
		);
	}

	/**
	 * Insert a leg and count it on its turn in one transaction. Throws when the
	 * turn does not exist (foreign key); false, inserting nothing, when fenced
	 * out.
	 */
	async insertLeg(leg: SdkBridgeLegInsert, fence?: string): Promise<boolean> {
		return this.adapter.runTransaction(() => {
			const db = this.adapter.getSQLiteDb();
			if (fence !== undefined) {
				const held = db
					.query(`SELECT ${FENCED} AS held`)
					.get(...(fenceParams(fence) as [string, string])) as {
					held: number;
				} | null;
				if (held?.held !== 1) return false;
			}
			db.run(
				`INSERT INTO sdk_bridge_turn_legs (id, turn_id, kind, started_at)
				VALUES (?, ?, ?, ?)`,
				[leg.id, leg.turnId, leg.kind, leg.startedAt],
			);
			db.run(
				`UPDATE sdk_bridge_turns SET leg_count = leg_count + 1 WHERE id = ?`,
				[leg.turnId],
			);
			return true;
		});
	}

	async finishLeg(
		id: string,
		finish: SdkBridgeLegFinish,
		fence?: string,
	): Promise<void> {
		await this.run(
			`UPDATE sdk_bridge_turn_legs SET
				finished_at = ?,
				http_status = ?,
				error_phase = ?,
				stop_reason = ?,
				error_type = ?,
				error_message = ?,
				tool_use_ids = ?
			WHERE id = ? AND ${FENCED}`,
			[
				finish.finishedAt,
				finish.httpStatus ?? null,
				finish.errorPhase ?? null,
				finish.stopReason ?? null,
				finish.errorType ?? null,
				finish.errorMessage ?? null,
				finish.toolUseIds ? JSON.stringify(finish.toolUseIds) : null,
				id,
				...fenceParams(fence),
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

	/** The turn a leg belongs to. A leg id is the client's request id. */
	async findTurnIdByLeg(legId: string): Promise<string | null> {
		const row = await this.get<{ turn_id: string }>(
			`SELECT turn_id FROM sdk_bridge_turn_legs WHERE id = ?`,
			[legId],
		);
		return row?.turn_id ?? null;
	}

	/** The turn's inner `requests` rows that still exist, oldest first. */
	async listInnerRequests(
		turnId: string,
		limit: number,
	): Promise<SdkBridgeInnerRequest[]> {
		const rows = await this.query<InnerRequestRow>(
			`SELECT r.id, r.timestamp, r.account_used, a.name AS account_name,
				r.model, r.status_code, r.success, r.input_tokens, r.output_tokens,
				r.cache_read_input_tokens, r.cache_creation_input_tokens, r.cost_usd
			FROM requests r
			LEFT JOIN accounts a ON a.id = r.account_used
			WHERE r.sdk_bridge_turn_id = ?
			ORDER BY r.timestamp, r.id
			LIMIT ?`,
			[turnId, limit],
		);
		return rows.map((row) => ({
			id: row.id,
			timestamp: Number(row.timestamp),
			accountId: row.account_used,
			accountName: row.account_name,
			model: row.model,
			statusCode: row.status_code,
			success: !!row.success,
			inputTokens: row.input_tokens,
			outputTokens: row.output_tokens,
			cacheReadInputTokens: row.cache_read_input_tokens,
			cacheCreationInputTokens: row.cache_creation_input_tokens,
			costUsd: row.cost_usd,
		}));
	}

	// Health reads for the analytics card. Each is bounded by
	// `started_at >= sinceMs` through idx_sdk_bridge_turns_started.

	async countHealthGroups(sinceMs: number): Promise<SdkBridgeHealthGroupRow[]> {
		const rows = await this.query<{
			kind: string;
			status: string;
			history_mode: string;
			rebuild_reason: string | null;
			client_harness: string | null;
			account_id: string | null;
			account_name: string | null;
			count: number;
		}>(
			`SELECT t.kind, t.status, t.history_mode, t.rebuild_reason,
				t.client_harness, t.account_id, MAX(a.name) AS account_name,
				COUNT(*) AS count
			FROM sdk_bridge_turns t
			LEFT JOIN accounts a ON a.id = t.account_id
			WHERE t.started_at >= ?
			GROUP BY t.kind, t.status, t.history_mode, t.rebuild_reason,
				t.client_harness, t.account_id`,
			[sinceMs],
		);
		return rows.map((row) => ({
			kind: row.kind,
			status: row.status,
			historyMode: row.history_mode,
			rebuildReason: row.rebuild_reason,
			clientHarness: row.client_harness,
			accountId: row.account_id,
			accountName: row.account_name,
			count: row.count,
		}));
	}

	/** Biggest group first. */
	async countHealthErrors(
		sinceMs: number,
		statuses: readonly SdkBridgeTurnStatus[],
	): Promise<SdkBridgeHealthErrorRow[]> {
		if (statuses.length === 0) return [];
		const rows = await this.query<{
			status: string;
			error_type: string | null;
			http_status: number | null;
			count: number;
		}>(
			`SELECT status, error_type, http_status, COUNT(*) AS count
			FROM sdk_bridge_turns
			WHERE started_at >= ? AND status IN (${placeholders(statuses)})
			GROUP BY status, error_type, http_status
			ORDER BY count DESC, status, error_type, http_status`,
			[sinceMs, ...statuses],
		);
		return rows.map((row) => ({
			status: row.status,
			errorType: row.error_type,
			httpStatus: row.http_status,
			count: row.count,
		}));
	}

	/**
	 * Nearest rank: the smallest value whose rank reaches p × n, so the median
	 * of an even count is the lower one. Nulls are not samples.
	 */
	async healthPercentiles(
		sinceMs: number,
		metric: SdkBridgeHealthMetric,
		scope: {
			kind?: SdkBridgeTurnKind;
			statuses?: readonly SdkBridgeTurnStatus[];
		} = {},
	): Promise<SdkBridgeHealthPercentileRow> {
		const where = [`started_at >= ?`, `${metric} IS NOT NULL`];
		const params: unknown[] = [sinceMs];
		if (scope.kind) {
			where.push("kind = ?");
			params.push(scope.kind);
		}
		if (scope.statuses) {
			if (scope.statuses.length === 0)
				return { samples: 0, p50: null, p95: null, total: 0 };
			where.push(`status IN (${placeholders(scope.statuses)})`);
			params.push(...scope.statuses);
		}
		const row = await this.get<{
			samples: number;
			p50: number | null;
			p95: number | null;
			total: number | null;
		}>(
			`WITH ranked AS (
				SELECT ${metric} AS x,
					ROW_NUMBER() OVER (ORDER BY ${metric}) AS rn,
					COUNT(*) OVER () AS n
				FROM sdk_bridge_turns
				WHERE ${where.join(" AND ")}
			)
			SELECT COUNT(*) AS samples,
				MIN(CASE WHEN rn * 100 >= n * 50 THEN x END) AS p50,
				MIN(CASE WHEN rn * 100 >= n * 95 THEN x END) AS p95,
				SUM(x) AS total
			FROM ranked`,
			params,
		);
		return {
			samples: row?.samples ?? 0,
			p50: row?.p50 ?? null,
			p95: row?.p95 ?? null,
			total: row?.total ?? 0,
		};
	}

	/**
	 * Inner `requests` rows of the range's turns, by the turn's harness and
	 * the account that served each call. CROSS JOIN pins the turns as the outer loop, so each is probed through
	 * the partial turn-id index instead of the planner walking every inner row
	 * ever retained.
	 */
	async sumHealthInnerUsage(
		sinceMs: number,
	): Promise<SdkBridgeHealthInnerRow[]> {
		const rows = await this.query<{
			client_harness: string | null;
			account_used: string | null;
			account_name: string | null;
			request_count: number;
			input_tokens: number | null;
			output_tokens: number | null;
			cache_read_input_tokens: number | null;
			cache_creation_input_tokens: number | null;
			cost_usd: number | null;
		}>(
			`SELECT t.client_harness, r.account_used, MAX(a.name) AS account_name,
				COUNT(*) AS request_count,
				SUM(r.input_tokens) AS input_tokens,
				SUM(r.output_tokens) AS output_tokens,
				SUM(r.cache_read_input_tokens) AS cache_read_input_tokens,
				SUM(r.cache_creation_input_tokens) AS cache_creation_input_tokens,
				SUM(r.cost_usd) AS cost_usd
			FROM sdk_bridge_turns t
			CROSS JOIN requests r ON r.sdk_bridge_turn_id = t.id
			LEFT JOIN accounts a ON a.id = r.account_used
			WHERE t.started_at >= ?
			GROUP BY t.client_harness, r.account_used
			ORDER BY t.client_harness, r.account_used`,
			[sinceMs],
		);
		return rows.map((row) => ({
			clientHarness: row.client_harness,
			servedAccountId: row.account_used,
			servedAccountName: row.account_name,
			requestCount: row.request_count,
			inputTokens: row.input_tokens ?? 0,
			outputTokens: row.output_tokens ?? 0,
			cacheReadInputTokens: row.cache_read_input_tokens ?? 0,
			cacheCreationInputTokens: row.cache_creation_input_tokens ?? 0,
			costUsd: row.cost_usd ?? 0,
		}));
	}

	/** Newest first. */
	async listHealthFailures(
		sinceMs: number,
		statuses: readonly SdkBridgeTurnStatus[],
		limit: number,
	): Promise<SdkBridgeHealthFailureRow[]> {
		if (statuses.length === 0) return [];
		const rows = await this.query<{
			id: string;
			kind: string;
			status: string;
			started_at: number;
			http_status: number | null;
			error_type: string | null;
			error_message: string | null;
			client_harness: string | null;
			model: string | null;
		}>(
			`SELECT id, kind, status, started_at, http_status, error_type,
				error_message, client_harness, model
			FROM sdk_bridge_turns
			WHERE started_at >= ? AND status IN (${placeholders(statuses)})
			ORDER BY started_at DESC, id DESC
			LIMIT ?`,
			[sinceMs, ...statuses, limit],
		);
		return rows.map((row) => ({
			id: row.id,
			kind: row.kind,
			status: row.status,
			startedAt: Number(row.started_at),
			httpStatus: row.http_status,
			errorType: row.error_type,
			errorMessage: row.error_message,
			clientHarness: row.client_harness,
			model: row.model,
		}));
	}
}
