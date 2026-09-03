import { Logger } from "@clankermux/logger";
import type {
	CachePrefixCapture,
	ContextComposition,
	ProjectAttributionSource,
	ToolCallStat,
} from "@clankermux/types";
import { decryptPayload, encryptPayload } from "../payload-encryption";
import { BaseRepository } from "./base.repository";

const log = new Logger("RequestRepository");

/**
 * Decrypt a stored payload for a list endpoint, swallowing per-row errors
 * so a single corrupted/tampered row cannot take down the whole list.
 *
 * The error is logged so misconfiguration is still observable, and a JSON
 * placeholder is substituted that the dashboard can render as "unreadable".
 *
 * Single-row reads (`getPayload`) MUST stay strict and let the error
 * propagate — there's no fallback that makes sense for a single row.
 */
async function decryptForList(id: string, json: string): Promise<string> {
	try {
		return await decryptPayload(json);
	} catch (err) {
		log.error(`Failed to decrypt payload ${id}:`, err);
		return JSON.stringify({
			error: "Payload could not be decrypted",
			id,
		});
	}
}

export interface RequestData {
	id: string;
	method: string;
	path: string;
	accountUsed: string | null;
	statusCode: number | null;
	success: boolean;
	errorMessage: string | null;
	responseTime: number;
	failoverAttempts: number;
	apiKeyId?: string;
	apiKeyName?: string;
	project?: string | null;
	/**
	 * Which attribution tier produced `project`. REQUIRED — every caller must
	 * state it, explicitly passing `null` when the request was never eligible
	 * for attribution.
	 *
	 * `null` writes SQL NULL = "not recorded", which is distinct from the
	 * recorded value `"none"` ("eligible request, no tier fired"). Because a
	 * NULL is indistinguishable from a legacy pre-column row, an accidentally
	 * omitted field would silently deflate `measured_requests` — the only
	 * honest denominator for attribution coverage — so omission has to be a
	 * compile error rather than a quiet NULL write.
	 */
	projectAttributionSource: ProjectAttributionSource | null;
	billingType?: string;
	comboName?: string | null;
	reasoningEffort?: string | null;
	/** Model named at ingress; independent of provider-reported usage.model. */
	requestedModel?: string | null;
	/**
	 * Ingest-time context composition (the requests.context_* columns).
	 * Absent/null = "not recorded" → columns stay NULL; 0 is a valid recorded
	 * value and must be bound with `?? null` (never `|| null`).
	 */
	contextComposition?: ContextComposition | null;
	usage?: {
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		costUsd?: number;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
		tokensPerSecond?: number;
		tokensPerSecondApproximate?: boolean;
	};
	/**
	 * Ms epoch at which a persistable token vector first became known for the
	 * request — NOT when the row was written. Null/absent = never (usage waived,
	 * or a summary with no model). Never overwritten once set: both the upsert
	 * and {@link RequestRepository.updateUsage} COALESCE the stored value first,
	 * so the EARLIEST stamp survives a late patch.
	 */
	usageFinalizedAt?: number | null;
	/**
	 * Cache-measurement capture, both ingress-derived facts (absent on the
	 * usage-patch re-upsert, so both COALESCE stored-value-preserving):
	 * `sessionKey` is `<apiKeyId|anon>:<Claude Code session uuid>`;
	 * `cachePrefixHashes` is the per-breakpoint prefix digest array, stored as
	 * its JSON text.
	 */
	sessionKey?: string | null;
	cachePrefixHashes?: CachePrefixCapture | null;
	/**
	 * The provider's terminal `stop_reason`, raw, for every provider and every
	 * reason. Absent/null = the response carried none (errors, aborted streams,
	 * native Responses passthrough) and the column stays NULL.
	 */
	stopReason?: string | null;
	/**
	 * Set if and only if `stopReason` is `"refusal"`: the provider's
	 * `stop_details.category`, or the literal `"unknown"` when it named none.
	 * The marker every safety-refusal predicate keys on.
	 */
	refusalCategory?: string | null;
	/** True when the request body carried a non-empty `fallback_credit_token`. */
	fallbackCreditClaimed?: boolean;
	/** The model whose refusal this retry redeems; null when unresolved. */
	fallbackFromModel?: string | null;
}

/** Fails to compile unless `T` is exactly `true`. */
type Assert<T extends true> = T;

/**
 * Compile-time guard: `RequestData.projectAttributionSource` must stay
 * REQUIRED. `Record<never, never>` (the empty object type) only extends
 * `Pick<T, K>` when `K` is optional, so re-adding a `?` flips the operand to
 * `false` and breaks the `extends true` constraint below. Type-only — no
 * runtime footprint.
 */
export type ProjectAttributionSourceIsRequired = Assert<
	Record<never, never> extends Pick<RequestData, "projectAttributionSource">
		? false
		: true
>;

export interface RequestRoutingData {
	requestId: string;
	strategy: string;
	decision: string;
	affinityScope?: string | null;
	affinityKeyHash?: string | null;
	selectedAccountId?: string | null;
	previousAccountId?: string | null;
	candidatesCount?: number | null;
	failoverAttempts?: number | null;
	failoverReason?: string | null;
	createdAt?: number;
}

export class RequestRepository extends BaseRepository<RequestData> {
	async save(data: RequestData): Promise<void> {
		const { usage } = data;
		const comp = data.contextComposition ?? null;
		await this.run(
			`
				INSERT INTO requests (
					id, timestamp, method, path, account_used,
					status_code, success, error_message, response_time_ms, failover_attempts,
					model, requested_model, prompt_tokens, completion_tokens, total_tokens, cost_usd,
					input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens,
					output_tokens_per_second, output_tokens_per_second_approx,
					api_key_id, api_key_name, project, project_attribution_source,
					billing_type, combo_name, reasoning_effort,
					context_system_chars, context_tools_chars, context_tool_count,
					context_messages_chars, context_message_count, context_tool_result_chars,
					context_largest_tool_chars, context_largest_tool_name,
					context_binary_chars, usage_finalized_at,
					session_key, cache_prefix_hashes,
					stop_reason, refusal_category, fallback_credit_claimed,
					fallback_from_model
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (id) DO UPDATE SET
				timestamp = EXCLUDED.timestamp,
				method = EXCLUDED.method,
				path = EXCLUDED.path,
				account_used = EXCLUDED.account_used,
				status_code = EXCLUDED.status_code,
				success = EXCLUDED.success,
				error_message = EXCLUDED.error_message,
				response_time_ms = EXCLUDED.response_time_ms,
				failover_attempts = EXCLUDED.failover_attempts,
				model = EXCLUDED.model,
				requested_model = COALESCE(EXCLUDED.requested_model, requests.requested_model),
				prompt_tokens = EXCLUDED.prompt_tokens,
				completion_tokens = EXCLUDED.completion_tokens,
				total_tokens = EXCLUDED.total_tokens,
				cost_usd = EXCLUDED.cost_usd,
				input_tokens = EXCLUDED.input_tokens,
				cache_read_input_tokens = EXCLUDED.cache_read_input_tokens,
				cache_creation_input_tokens = EXCLUDED.cache_creation_input_tokens,
				output_tokens = EXCLUDED.output_tokens,
				output_tokens_per_second = EXCLUDED.output_tokens_per_second,
				output_tokens_per_second_approx = EXCLUDED.output_tokens_per_second_approx,
				api_key_id = EXCLUDED.api_key_id,
				api_key_name = EXCLUDED.api_key_name,
				project = COALESCE(EXCLUDED.project, requests.project),
				project_attribution_source = COALESCE(EXCLUDED.project_attribution_source, requests.project_attribution_source),
				billing_type = COALESCE(EXCLUDED.billing_type, requests.billing_type),
				combo_name = COALESCE(EXCLUDED.combo_name, requests.combo_name),
				reasoning_effort = COALESCE(EXCLUDED.reasoning_effort, requests.reasoning_effort),
				context_system_chars = COALESCE(EXCLUDED.context_system_chars, requests.context_system_chars),
				context_tools_chars = COALESCE(EXCLUDED.context_tools_chars, requests.context_tools_chars),
				context_tool_count = COALESCE(EXCLUDED.context_tool_count, requests.context_tool_count),
				context_messages_chars = COALESCE(EXCLUDED.context_messages_chars, requests.context_messages_chars),
				context_message_count = COALESCE(EXCLUDED.context_message_count, requests.context_message_count),
				context_tool_result_chars = COALESCE(EXCLUDED.context_tool_result_chars, requests.context_tool_result_chars),
				context_largest_tool_chars = COALESCE(EXCLUDED.context_largest_tool_chars, requests.context_largest_tool_chars),
				context_largest_tool_name = COALESCE(EXCLUDED.context_largest_tool_name, requests.context_largest_tool_name),
				context_binary_chars = COALESCE(EXCLUDED.context_binary_chars, requests.context_binary_chars),
				-- Stored value FIRST: the earliest moment a usable usage vector
				-- existed is the fact this column records, so a re-upsert (or a
				-- later patch) must never move it forward.
				usage_finalized_at = COALESCE(requests.usage_finalized_at, EXCLUDED.usage_finalized_at),
				session_key = COALESCE(EXCLUDED.session_key, requests.session_key),
				cache_prefix_hashes = COALESCE(EXCLUDED.cache_prefix_hashes, requests.cache_prefix_hashes),
				-- All four are facts that, once known, never become unknown again:
				-- the usage-patch re-upsert carries no ingress facts and the ingress
				-- upsert carries no response facts, so each side must preserve what
				-- the other already wrote.
				stop_reason = COALESCE(EXCLUDED.stop_reason, requests.stop_reason),
				refusal_category = COALESCE(EXCLUDED.refusal_category, requests.refusal_category),
				fallback_credit_claimed = COALESCE(EXCLUDED.fallback_credit_claimed, requests.fallback_credit_claimed),
				fallback_from_model = COALESCE(EXCLUDED.fallback_from_model, requests.fallback_from_model)
		`,
			[
				data.id,
				Date.now(),
				data.method,
				data.path,
				data.accountUsed,
				data.statusCode,
				data.success,
				data.errorMessage,
				data.responseTime,
				data.failoverAttempts,
				usage?.model || null,
				data.requestedModel || null,
				usage?.promptTokens || null,
				usage?.completionTokens || null,
				usage?.totalTokens || null,
				usage?.costUsd || null,
				usage?.inputTokens || null,
				usage?.cacheReadInputTokens || null,
				usage?.cacheCreationInputTokens || null,
				usage?.outputTokens || null,
				usage?.tokensPerSecond || null,
				usage?.tokensPerSecondApproximate && usage?.tokensPerSecond ? 1 : null,
				data.apiKeyId || null,
				data.apiKeyName || null,
				data.project || null,
				data.projectAttributionSource ?? null,
				data.billingType || null,
				data.comboName || null,
				data.reasoningEffort || null,
				// `?? null`, NEVER `|| null`: 0 is a valid recorded bucket value
				// (e.g. no tools defined) and must stay distinct from NULL.
				comp?.systemChars ?? null,
				comp?.toolsChars ?? null,
				comp?.toolCount ?? null,
				comp?.messagesChars ?? null,
				comp?.messageCount ?? null,
				comp?.toolResultChars ?? null,
				comp?.largestToolResultChars ?? null,
				comp?.largestToolName ?? null,
				// Attachment bytes stripped out of the char buckets, stored as one
				// figure: images + documents.
				comp ? comp.imagePayloadChars + comp.documentPayloadChars : null,
				data.usageFinalizedAt ?? null,
				data.sessionKey ?? null,
				data.cachePrefixHashes ? JSON.stringify(data.cachePrefixHashes) : null,
				data.stopReason ?? null,
				data.refusalCategory ?? null,
				// NULL, not 0, for "no credit": the column is a marker, and a 0
				// would make the partial index and every `= 1` predicate carry rows
				// that mean nothing.
				data.fallbackCreditClaimed ? 1 : null,
				data.fallbackFromModel ?? null,
			],
		);
	}

	async saveRouting(data: RequestRoutingData): Promise<void> {
		await this.run(
			`
			INSERT INTO request_routing (
				request_id, strategy, decision, affinity_scope, affinity_key_hash,
				selected_account_id, previous_account_id, candidates_count,
				failover_attempts, failover_reason, created_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (request_id) DO UPDATE SET
				strategy = EXCLUDED.strategy,
				decision = EXCLUDED.decision,
				affinity_scope = COALESCE(EXCLUDED.affinity_scope, request_routing.affinity_scope),
				affinity_key_hash = COALESCE(EXCLUDED.affinity_key_hash, request_routing.affinity_key_hash),
				selected_account_id = COALESCE(EXCLUDED.selected_account_id, request_routing.selected_account_id),
				previous_account_id = COALESCE(EXCLUDED.previous_account_id, request_routing.previous_account_id),
				candidates_count = COALESCE(EXCLUDED.candidates_count, request_routing.candidates_count),
				failover_attempts = EXCLUDED.failover_attempts,
				failover_reason = COALESCE(EXCLUDED.failover_reason, request_routing.failover_reason),
				created_at = COALESCE(request_routing.created_at, EXCLUDED.created_at)
		`,
			[
				data.requestId,
				data.strategy,
				data.decision,
				data.affinityScope ?? null,
				data.affinityKeyHash ?? null,
				data.selectedAccountId ?? null,
				data.previousAccountId ?? null,
				data.candidatesCount ?? null,
				data.failoverAttempts ?? 0,
				data.failoverReason ?? null,
				data.createdAt ?? Date.now(),
			],
		);
	}

	/**
	 * Persist a request's per-tool call/error stats (final-message tool_result
	 * mining — see computeContextAndToolStats). Upserts request_tool_calls and
	 * replaces the request's request_tool_errors sample rows (DELETE-then-INSERT)
	 * so a withDatabaseRetry re-run after a partial write cannot duplicate
	 * samples — the counts upsert is already idempotent, plain INSERTs are not.
	 */
	async saveToolCalls(requestId: string, stats: ToolCallStat[]): Promise<void> {
		if (stats.length === 0) return;

		await this.run(`DELETE FROM request_tool_errors WHERE request_id = ?`, [
			requestId,
		]);

		for (const stat of stats) {
			await this.run(
				`
				INSERT INTO request_tool_calls (request_id, tool_name, call_count, error_count)
				VALUES (?, ?, ?, ?)
				ON CONFLICT (request_id, tool_name) DO UPDATE SET
					call_count = EXCLUDED.call_count,
					error_count = EXCLUDED.error_count
			`,
				[requestId, stat.toolName, stat.callCount, stat.errorCount],
			);
			for (const errorText of stat.errorSamples) {
				await this.run(
					`INSERT INTO request_tool_errors (request_id, tool_name, error_text) VALUES (?, ?, ?)`,
					[requestId, stat.toolName, errorText],
				);
			}
		}
	}

	/**
	 * Patch a persisted row's usage columns (the recorder's late-summary seam).
	 *
	 * `usageFinalizedAt` is COALESCE'd with the STORED value first, not last: the
	 * column records the earliest moment a usable usage vector existed, so a late
	 * patch may fill it in but must never move it forward. Same rule as the
	 * upsert in {@link RequestRepository.save}.
	 */
	async updateUsage(
		requestId: string,
		usage: RequestData["usage"],
		usageFinalizedAt?: number | null,
		response?: { stopReason?: string | null; refusalCategory?: string | null },
	): Promise<void> {
		// The usage columns and the response-shape columns are independent
		// patches: a summary can carry a stop reason while the token vector was
		// waived, so a missing `usage` skips the usage half rather than the whole
		// statement.
		if (usage) {
			await this.run(
				`
			UPDATE requests
			SET
				usage_finalized_at = COALESCE(usage_finalized_at, ?),
				model = COALESCE(?, model),
				prompt_tokens = COALESCE(?, prompt_tokens),
				completion_tokens = COALESCE(?, completion_tokens),
				total_tokens = COALESCE(?, total_tokens),
				cost_usd = COALESCE(?, cost_usd),
				input_tokens = COALESCE(?, input_tokens),
				cache_read_input_tokens = COALESCE(?, cache_read_input_tokens),
				cache_creation_input_tokens = COALESCE(?, cache_creation_input_tokens),
				output_tokens = COALESCE(?, output_tokens),
				output_tokens_per_second = COALESCE(?, output_tokens_per_second),
				output_tokens_per_second_approx = COALESCE(?, output_tokens_per_second_approx)
			WHERE id = ?
		`,
				[
					usageFinalizedAt ?? null,
					usage.model || null,
					usage.promptTokens || null,
					usage.completionTokens || null,
					usage.totalTokens || null,
					usage.costUsd || null,
					usage.inputTokens || null,
					usage.cacheReadInputTokens || null,
					usage.cacheCreationInputTokens || null,
					usage.outputTokens || null,
					usage.tokensPerSecond || null,
					usage.tokensPerSecondApproximate && usage.tokensPerSecond ? 1 : null,
					requestId,
				],
			);
		}

		if (
			response &&
			(response.stopReason != null || response.refusalCategory != null)
		) {
			await this.run(
				`
			UPDATE requests
			SET
				stop_reason = COALESCE(?, stop_reason),
				refusal_category = COALESCE(?, refusal_category)
			WHERE id = ?
		`,
				[
					response.stopReason ?? null,
					response.refusalCategory ?? null,
					requestId,
				],
			);
		}
	}

	// Payload management
	//
	// This repository has NO request_payloads write path: every payload row is
	// inserted by the off-thread payload-write worker (see
	// payload-write-worker.ts), which owns its own SQLite connection. The main
	// thread only produces the STORED FORM of the payload here — encryption is
	// Web Crypto and therefore async, and the worker needs no key.
	async encryptPayloadForStorage(json: string): Promise<string> {
		return encryptPayload(json);
	}

	async getPayload(id: string): Promise<unknown | null> {
		const row = await this.get<{ json: string }>(
			`SELECT json FROM request_payloads WHERE id = ?`,
			[id],
		);

		if (!row) return null;

		// Decryption errors must propagate — they indicate tampering, a wrong key,
		// or a missing key for an encrypted row. Silently returning null would
		// hide real misconfiguration. Only JSON parse errors are tolerated, since
		// historical rows may contain malformed payloads.
		const decoded = await decryptPayload(row.json);
		try {
			return JSON.parse(decoded);
		} catch {
			return null;
		}
	}

	async listPayloads(limit = 50): Promise<Array<{ id: string; json: string }>> {
		const rows = await this.query<{ id: string; json: string }>(
			`
			SELECT rp.id, rp.json
			FROM request_payloads rp
			JOIN requests r ON rp.id = r.id
			ORDER BY r.timestamp DESC
			LIMIT ?
		`,
			[limit],
		);
		return Promise.all(
			rows.map(async (row) => ({
				id: row.id,
				json: await decryptForList(row.id, row.json),
			})),
		);
	}

	async listPayloadsWithAccountNames(limit = 50): Promise<
		Array<{
			id: string;
			json: string | null;
			timestamp: number;
			account_name: string | null;
		}>
	> {
		const rows = await this.query<{
			id: string;
			json: string | null;
			timestamp: number;
			account_name: string | null;
		}>(
			`
			SELECT r.id, r.timestamp, rp.json, a.name as account_name
			FROM requests r
			LEFT JOIN request_payloads rp ON rp.id = r.id
			LEFT JOIN accounts a ON r.account_used = a.id
			ORDER BY r.timestamp DESC
			LIMIT ?
		`,
			[limit],
		);
		return Promise.all(
			rows.map(async (row) => ({
				id: row.id,
				timestamp: row.timestamp,
				json: row.json ? await decryptForList(row.id, row.json) : null,
				account_name: row.account_name,
			})),
		);
	}

	// Analytics queries
	async getRecentRequests(limit = 100): Promise<
		Array<{
			id: string;
			timestamp: number;
			method: string;
			path: string;
			account_used: string | null;
			status_code: number | null;
			success: boolean;
			response_time_ms: number | null;
		}>
	> {
		const rows = await this.query<{
			id: string;
			timestamp: number;
			method: string;
			path: string;
			account_used: string | null;
			status_code: number | null;
			success: 0 | 1;
			response_time_ms: number | null;
		}>(
			`
			SELECT id, timestamp, method, path, account_used, status_code, success, response_time_ms
			FROM requests
			ORDER BY timestamp DESC
			LIMIT ?
		`,
			[limit],
		);
		return rows.map((row) => ({
			...row,
			success: !!row.success,
		}));
	}

	async getRequestStats(since?: number): Promise<{
		totalRequests: number;
		successfulRequests: number;
		failedRequests: number;
		avgResponseTime: number | null;
	}> {
		const whereClause = since ? "WHERE timestamp > ?" : "";
		const params = since ? [since] : [];

		const result = await this.get<{
			total_requests: number;
			successful_requests: number;
			failed_requests: number;
			avg_response_time: number | null;
		}>(
			`
			SELECT
				COUNT(*) as total_requests,
				SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) as successful_requests,
				SUM(CASE WHEN success = FALSE THEN 1 ELSE 0 END) as failed_requests,
				AVG(response_time_ms) as avg_response_time
			FROM requests
			${whereClause}
		`,
			params,
		);

		return {
			totalRequests: result?.total_requests || 0,
			successfulRequests: result?.successful_requests || 0,
			failedRequests: result?.failed_requests || 0,
			avgResponseTime: result?.avg_response_time || null,
		};
	}

	/**
	 * Aggregate statistics with optional time range
	 * Consolidates duplicate SQL queries from stats handlers
	 */
	async aggregateStats(rangeMs?: number): Promise<{
		totalRequests: number;
		successfulRequests: number;
		avgResponseTime: number | null;
		totalTokens: number;
		totalCostUsd: number;
		inputTokens: number;
		outputTokens: number;
		cacheReadInputTokens: number;
		cacheCreationInputTokens: number;
		avgTokensPerSecond: number | null;
	}> {
		const whereClause = rangeMs ? "WHERE timestamp > ?" : "";
		const params = rangeMs ? [Date.now() - rangeMs] : [];

		const result = await this.get<{
			total_requests: number;
			successful_requests: number;
			avg_response_time: number | null;
			total_tokens: number | null;
			total_cost_usd: number | null;
			input_tokens: number | null;
			output_tokens: number | null;
			cache_read_input_tokens: number | null;
			cache_creation_input_tokens: number | null;
			avg_tokens_per_second: number | null;
		}>(
			`
			SELECT
				COUNT(*) as total_requests,
				SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) as successful_requests,
				AVG(response_time_ms) as avg_response_time,
				SUM(total_tokens) as total_tokens,
				SUM(cost_usd) as total_cost_usd,
				SUM(input_tokens) as input_tokens,
				SUM(output_tokens) as output_tokens,
				SUM(cache_read_input_tokens) as cache_read_input_tokens,
				SUM(cache_creation_input_tokens) as cache_creation_input_tokens,
				AVG(output_tokens_per_second) as avg_tokens_per_second
			FROM requests
			${whereClause}
		`,
			params,
		);

		return {
			totalRequests: result?.total_requests || 0,
			successfulRequests: result?.successful_requests || 0,
			avgResponseTime: result?.avg_response_time || null,
			totalTokens: result?.total_tokens || 0,
			totalCostUsd: result?.total_cost_usd || 0,
			inputTokens: result?.input_tokens || 0,
			outputTokens: result?.output_tokens || 0,
			cacheReadInputTokens: result?.cache_read_input_tokens || 0,
			cacheCreationInputTokens: result?.cache_creation_input_tokens || 0,
			avgTokensPerSecond: result?.avg_tokens_per_second || null,
		};
	}

	/**
	 * Get recent error messages
	 */
	async getRecentErrors(limit = 10): Promise<string[]> {
		const errors = await this.query<{ error_message: string }>(
			`
			SELECT error_message
			FROM requests
			WHERE success = FALSE AND error_message IS NOT NULL
			ORDER BY timestamp DESC
			LIMIT ?
		`,
			[limit],
		);
		return errors.map((e: { error_message: string }) => e.error_message);
	}

	async getRequestsByAccount(since?: number): Promise<
		Array<{
			accountId: string;
			accountName: string | null;
			requestCount: number;
			successRate: number;
		}>
	> {
		const whereClause = since ? "WHERE r.timestamp > ?" : "";
		const params = since ? [since] : [];

		const rows = await this.query<{
			account_id: string;
			account_name: string | null;
			request_count: number;
			success_rate: number;
		}>(
			`
			SELECT
				r.account_used as account_id,
				a.name as account_name,
				COUNT(*) as request_count,
				SUM(CASE WHEN r.success = TRUE THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate
			FROM requests r
			LEFT JOIN accounts a ON r.account_used = a.id
			${whereClause}
			GROUP BY r.account_used
			ORDER BY request_count DESC
		`,
			params,
		);
		return rows.map((row) => ({
			accountId: row.account_id,
			accountName: row.account_name,
			requestCount: row.request_count,
			successRate: row.success_rate,
		}));
	}

	/**
	 * Failed requests in range, grouped by raw message + status + time bucket.
	 *
	 * Classification into a {@link StopCause} happens in TypeScript, not here:
	 * `error_message` mixes proxy terminals with free-form upstream text, and
	 * encoding that vocabulary as SQL CASE arms would put the rule in a second
	 * place that the public widget read could disagree with.
	 *
	 * `success = 0` is spelled with the literal rather than `FALSE` so it matches
	 * the `idx_requests_failed_timestamp` partial-index predicate character for
	 * character — a mismatch there silently costs the index and turns this into
	 * a full range scan of every request in the window.
	 *
	 * Grouping deliberately omits the model: adding it multiplies the row count
	 * by the model cardinality on top of the bucket cardinality. The per-cause
	 * top model comes from {@link getStopModelBreakdown}, which has no bucket
	 * dimension and stays small.
	 */
	async getStopsByBucket(opts: { sinceMs: number; bucketMs: number }): Promise<
		Array<{
			errorMessage: string | null;
			statusCode: number | null;
			bucketMs: number;
			count: number;
			firstSeenMs: number;
			lastSeenMs: number;
		}>
	> {
		const rows = await this.query<{
			error_message: string | null;
			status_code: number | null;
			bucket: number;
			c: number;
			first_ms: number;
			last_ms: number;
		}>(
			`
			SELECT
				error_message,
				status_code,
				(timestamp / ?) * ? AS bucket,
				COUNT(*) AS c,
				MIN(timestamp) AS first_ms,
				MAX(timestamp) AS last_ms
			FROM requests
			WHERE success = 0 AND timestamp >= ?
			GROUP BY error_message, status_code, bucket
		`,
			[opts.bucketMs, opts.bucketMs, opts.sinceMs],
		);
		return rows.map((row) => ({
			errorMessage: row.error_message,
			statusCode: row.status_code,
			bucketMs: row.bucket,
			count: row.c,
			firstSeenMs: row.first_ms,
			lastSeenMs: row.last_ms,
		}));
	}

	/**
	 * Failed requests in range by raw message + status + requested model.
	 *
	 * Feeds the per-cause "top requested model" line, which is what makes a
	 * historical row readable after the fact: a cause whose blocks are almost
	 * all one model is usually not the story its label tells, and rows written
	 * before the proxy learned to tell those apart keep their old label forever.
	 *
	 * `requested_model` is the INGRESS model (what the client asked for), which
	 * is the one worth naming; `model` is the fallback for rows recorded before
	 * that column existed.
	 */
	async getStopModelBreakdown(opts: { sinceMs: number }): Promise<
		Array<{
			errorMessage: string | null;
			statusCode: number | null;
			model: string | null;
			count: number;
		}>
	> {
		const rows = await this.query<{
			error_message: string | null;
			status_code: number | null;
			m: string | null;
			c: number;
		}>(
			`
			SELECT
				error_message,
				status_code,
				COALESCE(requested_model, model) AS m,
				COUNT(*) AS c
			FROM requests
			WHERE success = 0 AND timestamp >= ?
			GROUP BY error_message, status_code, m
		`,
			[opts.sinceMs],
		);
		return rows.map((row) => ({
			errorMessage: row.error_message,
			statusCode: row.status_code,
			model: row.m,
			count: row.c,
		}));
	}

	/** Total requests in range — the denominator a blocked count needs to be a rate. */
	async countRequestsSince(sinceMs: number): Promise<number> {
		const row = await this.get<{ c: number }>(
			`SELECT COUNT(*) AS c FROM requests WHERE timestamp >= ?`,
			[sinceMs],
		);
		return row?.c ?? 0;
	}

	/**
	 * How many accounts were eligible to serve each request, as a histogram.
	 *
	 * This is the redundancy signal no forecast can see. A pool that never drops
	 * below two eligible accounts has margin that no projection can take away;
	 * one that spends most of its time at one candidate is a single failure away
	 * from a stop however much quota it reports.
	 *
	 * Rows with a NULL `candidates_count` are excluded rather than folded into
	 * zero — "not recorded" and "nothing was eligible" are opposite readings,
	 * and zero is the one that means an outage.
	 */
	async getCandidateCountDistribution(
		sinceMs: number,
	): Promise<Array<{ candidatesCount: number; requests: number }>> {
		const rows = await this.query<{ candidates_count: number; c: number }>(
			`
			SELECT candidates_count, COUNT(*) AS c
			FROM request_routing
			WHERE created_at >= ? AND candidates_count IS NOT NULL
			GROUP BY candidates_count
			ORDER BY candidates_count ASC
		`,
			[sinceMs],
		);
		return rows.map((row) => ({
			candidatesCount: row.candidates_count,
			requests: row.c,
		}));
	}

	// Retention DELETEs (requests / payloads by age, orphaned payloads) now run
	// off the main thread in the incremental-vacuum worker's "cleanup" kind —
	// see runCleanup() in incremental-vacuum-worker.ts, driven by
	// DatabaseOperations.cleanupOldRequests(). The former deleteOlderThan /
	// deleteOrphanedPayloads / deletePayloadsOlderThan methods lived here and ran
	// synchronously on the main connection, which froze the event loop for
	// seconds when purging large payload blobs; they were removed with that fix.
}
