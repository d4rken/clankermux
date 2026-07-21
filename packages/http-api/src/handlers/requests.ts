import type { BunSqlAdapter, DatabaseOperations } from "@clankermux/database";
import { jsonResponse } from "@clankermux/http-common";
import type { RequestResponse } from "../types";
import {
	buildRequestFilterClause,
	type RequestFilters,
} from "./request-filters";

const MAX_BODY_PREVIEW_BYTES = 256 * 1024; // 256KB - match response body cap to preserve full conversation history
const MAX_REQUEST_DETAILS_LIMIT = 50;

function truncateBase64(body: unknown): {
	body: string | null;
	truncated: boolean;
} {
	if (!body || typeof body !== "string") {
		return { body: body as string | null, truncated: false };
	}

	try {
		const decoded = Buffer.from(body, "base64");
		if (decoded.length <= MAX_BODY_PREVIEW_BYTES) {
			return { body, truncated: false };
		}

		const sliced = decoded.subarray(0, MAX_BODY_PREVIEW_BYTES);
		return { body: sliced.toString("base64"), truncated: true };
	} catch {
		// If the payload is not valid base64, return null to avoid blowing up the response
		return { body: null, truncated: true };
	}
}

/**
 * Create a requests summary handler (existing functionality)
 */
export function createRequestsSummaryHandler(db: BunSqlAdapter) {
	return async (
		limit: number = 50,
		offset = 0,
		filters: RequestFilters = {},
	): Promise<Response> => {
		const { sql: whereSql, params: filterParams } =
			buildRequestFilterClause(filters);
		const requests = await db.query<{
			id: string;
			timestamp: number;
			method: string;
			path: string;
			account_used: string | null;
			account_name: string | null;
			status_code: number | null;
			success: unknown;
			error_message: string | null;
			response_time_ms: number | null;
			failover_attempts: number;
			model: string | null;
			requested_model: string | null;
			prompt_tokens: number | null;
			completion_tokens: number | null;
			total_tokens: number | null;
			input_tokens: number | null;
			cache_read_input_tokens: number | null;
			cache_creation_input_tokens: number | null;
			output_tokens: number | null;
			cost_usd: number | null;
			output_tokens_per_second: number | null;
			output_tokens_per_second_approx: number | null;
			api_key_id: string | null;
			api_key_name: string | null;
			api_key_display_name: string | null;
			project: string | null;
			billing_type: string | null;
			combo_name: string | null;
			reasoning_effort: string | null;
		}>(
			`
			SELECT r.*, a.name as account_name,
				COALESCE(k.name, r.api_key_name) as api_key_display_name
			FROM requests r
			LEFT JOIN accounts a ON r.account_used = a.id
			LEFT JOIN api_keys k ON k.id = r.api_key_id
			${whereSql}
			ORDER BY r.timestamp DESC
			LIMIT ? OFFSET ?
		`,
			[...filterParams, limit, offset],
		);

		const response: RequestResponse[] = requests.map((request) => ({
			id: request.id,
			timestamp: new Date(Number(request.timestamp)).toISOString(),
			method: request.method,
			path: request.path,
			accountUsed: request.account_name || request.account_used,
			statusCode: request.status_code,
			success: !!request.success,
			errorMessage: request.error_message,
			responseTimeMs: request.response_time_ms,
			failoverAttempts: request.failover_attempts,
			model: request.model || undefined,
			requestedModel: request.requested_model || undefined,
			promptTokens: request.prompt_tokens || undefined,
			completionTokens: request.completion_tokens || undefined,
			totalTokens: request.total_tokens || undefined,
			inputTokens: request.input_tokens || undefined,
			cacheReadInputTokens: request.cache_read_input_tokens || undefined,
			cacheCreationInputTokens:
				request.cache_creation_input_tokens || undefined,
			outputTokens: request.output_tokens || undefined,
			costUsd: request.cost_usd || undefined,
			tokensPerSecond: request.output_tokens_per_second || undefined,
			// Only meaningful alongside tokensPerSecond (stored 1 only when the
			// fallback value was recorded).
			tokensPerSecondApproximate: request.output_tokens_per_second_approx
				? true
				: undefined,
			apiKeyId: request.api_key_id || undefined,
			// Current key name (post-rename) with the record-time snapshot as the
			// fallback for hard-deleted keys.
			apiKeyName:
				request.api_key_display_name || request.api_key_name || undefined,
			project: request.project || undefined,
			billingType: request.billing_type || undefined,
			comboName: request.combo_name || undefined,
			reasoningEffort: request.reasoning_effort || undefined,
			rateLimited: request.status_code === 429,
		}));

		return jsonResponse(response);
	};
}

/**
 * Create a handler that returns the total number of requests matching a set of
 * filters. Backs the "M of N matching requests" counter in the dashboard's
 * filtered request explorer.
 *
 * Uses the same {@link buildRequestFilterClause} as the summary handler so the
 * count can never disagree with the list. Time-bounded filters (the common
 * case) ride the `idx_requests_timestamp` index. Filters without a time bound
 * scan: there is no index on `status_code`, `api_key_name`, or `account_used`,
 * so e.g. an API-key-only or status-only count is a full table scan and can take
 * seconds on a multi-GB DB. That's the caller's tradeoff for an exact total; the
 * list query stays fast (LIMIT N) and the count runs as a separate request so a
 * slow count never blocks rendering.
 */
export function createRequestsCountHandler(db: BunSqlAdapter) {
	return async (filters: RequestFilters = {}): Promise<Response> => {
		const { sql: whereSql, params } = buildRequestFilterClause(filters);
		const rows = await db.query<{ total: number }>(
			`
			SELECT COUNT(*) as total
			FROM requests r
			LEFT JOIN accounts a ON r.account_used = a.id
			${whereSql}
		`,
			params,
		);
		return jsonResponse({ total: Number(rows[0]?.total ?? 0) });
	};
}

/**
 * Create a handler that returns every distinct project name stamped on a
 * request, sorted alphabetically. Backs the Project filter dropdown in the
 * dashboard's request explorer, so historical projects stay selectable even
 * when they don't appear in the currently-loaded slice. NULL rows are excluded
 * here; the dashboard exposes them via its dedicated "No Project" sentinel.
 * Capped so a pathological high-cardinality project header can't produce an
 * unbounded response (a dropdown past a few hundred entries is unusable anyway).
 */
export function createRequestProjectsHandler(db: BunSqlAdapter) {
	return async (): Promise<Response> => {
		const rows = await db.query<{ project: string }>(
			"SELECT DISTINCT project FROM requests WHERE project IS NOT NULL ORDER BY project LIMIT 500",
		);
		return jsonResponse(rows.map((row) => row.project));
	};
}

/**
 * Create a detailed requests handler with full payload data
 */
export function createRequestsDetailHandler(dbOps: DatabaseOperations) {
	return async (limit = 100): Promise<Response> => {
		const safeLimit = Math.min(
			Math.max(Number.isFinite(limit) ? limit : 1, 1),
			MAX_REQUEST_DETAILS_LIMIT,
		);
		const rows = await dbOps.listRequestPayloadsWithAccountNames(safeLimit);
		const parsed = rows.map((r) => {
			try {
				const data = (r.json ? JSON.parse(r.json) : {}) as Record<
					string,
					unknown
				>;

				const request = data.request as
					| { body?: string | null; truncated?: boolean }
					| undefined;
				const response = data.response as
					| { body?: string | null; truncated?: boolean }
					| undefined;
				let meta = data.meta as Record<string, unknown> | undefined;
				if (!meta) {
					meta = {};
				}
				meta.limitApplied = safeLimit;
				// Ensure timestamp is always present for UI date rendering,
				// even when no payload json was stored.
				if (meta.timestamp === undefined) {
					meta.timestamp = r.timestamp;
				}

				if (request?.body) {
					const { body, truncated } = truncateBase64(request.body);
					request.body = body;
					if (truncated) {
						request.truncated = true;
						meta.requestBodyTruncated = true;
					}
				}

				if (response?.body) {
					const { body, truncated } = truncateBase64(response.body);
					response.body = body;
					if (truncated) {
						response.truncated = true;
						meta.responseBodyTruncated = true;
					}
				}

				data.request = request;
				data.response = response;

				if (r.account_name) {
					meta.accountName = r.account_name;
				}
				data.meta = meta;

				return { id: r.id, ...data };
			} catch {
				return { id: r.id, error: "Failed to parse payload" };
			}
		});

		return jsonResponse(parsed);
	};
}

/**
 * Create a handler for lazy loading individual request payloads
 * This endpoint supports the performance optimization that eliminates JSON parsing bottleneck
 */
export function createRequestPayloadHandler(dbOps: DatabaseOperations) {
	return async (requestId: string): Promise<Response> => {
		const payload = await dbOps.getRequestPayload(requestId);

		if (!payload) {
			return new Response(JSON.stringify({ error: "Request not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}

		return jsonResponse(payload);
	};
}
