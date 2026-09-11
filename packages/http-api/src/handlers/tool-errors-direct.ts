import { extractToolErrorEvidence } from "@clankermux/core";
import { buildRequestFilterConditions } from "@clankermux/database";
import type {
	ToolErrorDetailsResponse,
	ToolErrorExampleResponse,
	ToolErrorGroup,
	ToolErrorScope,
} from "@clankermux/types";
import type { APIContext } from "../types";
import { parseAnalyticsRequestFilters } from "./analytics-request-filters";
import { getRangeConfig } from "./range-config";

class SelectionError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}
function integer(
	value: string | null,
	fallback: number,
	min = 0,
	max = Number.MAX_SAFE_INTEGER,
): number {
	if (value === null) return fallback;
	if (!/^\d+$/.test(value))
		throw new SelectionError("Invalid numeric parameter");
	const n = Number(value);
	if (!Number.isSafeInteger(n) || n < min || n > max)
		throw new SelectionError("Numeric parameter out of range");
	return n;
}
function selection(params: URLSearchParams) {
	const tool = params.get("tool");
	if (!tool || tool.length > 1024)
		throw new SelectionError(
			"A tool name is required (maximum 1024 characters)",
		);
	const now = Date.now();
	const toMs = integer(params.get("to"), now);
	const window = getRangeConfig(params.get("range") ?? "24h").windowMs;
	const fromMs =
		params.get("from") === "all"
			? null
			: params.has("from")
				? integer(params.get("from"), 0)
				: window === null
					? null
					: Math.max(0, toMs - window);
	if (fromMs !== null && fromMs >= toMs)
		throw new SelectionError("The start must precede the end");
	const filters = parseAnalyticsRequestFilters(params);
	const scope: ToolErrorScope = { fromMs, toMs, filters };
	const filter = buildRequestFilterConditions(filters, "r");
	const conditions = [
		"r.method = 'POST'",
		"r.path = '/v1/messages'",
		"r.timestamp <= ?",
		...filter.conditions,
	];
	const binds: (string | number | boolean)[] = [toMs, ...filter.binds];
	if (fromMs !== null) {
		conditions.push("r.timestamp > ?");
		binds.push(fromMs);
	}
	return {
		scope,
		tool,
		where: conditions.join(" AND "),
		binds,
		limit: integer(params.get("limit"), 20, 1, 50),
		offset: integer(params.get("offset"), 0, 0, 1000000),
	};
}
type Selection = ReturnType<typeof selection>;
async function resolveGroup(
	context: APIContext,
	s: Selection,
	sampleId: number,
): Promise<{ tool_name: string; error_text: string; error_hex: string }> {
	const rows = await context.db.query<{
		tool_name: string;
		error_text: string;
		error_hex: string;
	}>(
		`SELECT te.tool_name, te.error_text, hex(te.error_text) error_hex FROM request_tool_errors te JOIN requests r ON r.id=te.request_id WHERE te.id=? AND te.tool_name=? AND te.error_text IS NOT NULL AND ${s.where}`,
		[sampleId, s.tool, ...s.binds],
	);
	if (!rows[0])
		throw new SelectionError(
			"This saved message is no longer available in this selection. Refresh the error list.",
			404,
		);
	return rows[0];
}
function failure(error: unknown): Response {
	if (error instanceof SelectionError)
		return Response.json({ error: error.message }, { status: error.status });
	return Response.json(
		{ error: "Unable to load tool error evidence" },
		{ status: 500 },
	);
}

export function createToolErrorsHandler(context: APIContext) {
	return async (params: URLSearchParams): Promise<Response> => {
		try {
			const s = selection(params);
			const db = context.db;
			const totals = (
				await db.query<{ calls: number; errors: number }>(
					`SELECT COALESCE(SUM(tc.call_count),0) calls, COALESCE(SUM(tc.error_count),0) errors FROM request_tool_calls tc JOIN requests r ON r.id=tc.request_id WHERE tc.tool_name=? AND ${s.where}`,
					[s.tool, ...s.binds],
				)
			)[0];
			const captured = (
				await db.query<{ captured: number; groups: number }>(
					`SELECT COUNT(*) captured, COUNT(DISTINCT te.error_text) groups FROM request_tool_errors te JOIN requests r ON r.id=te.request_id WHERE te.tool_name=? AND te.error_text IS NOT NULL AND ${s.where}`,
					[s.tool, ...s.binds],
				)
			)[0];
			const response: ToolErrorDetailsResponse = {
				scope: s.scope,
				toolName: s.tool,
				totalCalls: totals?.calls ?? 0,
				totalErrors: totals?.errors ?? 0,
				capturedTexts: captured?.captured ?? 0,
				distinctGroups: captured?.groups ?? 0,
				groups: [],
				offset: s.offset,
				hasMore: false,
				detail: null,
			};
			if (!params.has("sampleId")) {
				const rows = await db.query<ToolErrorGroup>(
					`SELECT MIN(te.id) sampleId, te.error_text errorText, COUNT(*) occurrences FROM request_tool_errors te JOIN requests r ON r.id=te.request_id WHERE te.tool_name=? AND te.error_text IS NOT NULL AND ${s.where} GROUP BY te.error_text ORDER BY occurrences DESC, te.error_text ASC LIMIT ? OFFSET ?`,
					[s.tool, ...s.binds, s.limit + 1, s.offset],
				);
				response.groups = rows.slice(0, s.limit);
				response.hasMore = rows.length > s.limit;
			} else {
				const sampleId = integer(params.get("sampleId"), 0, 1);
				const group = await resolveGroup(context, s, sampleId);
				const where = `te.tool_name=? AND te.error_text=(SELECT error_text FROM request_tool_errors WHERE id=?) AND ${s.where}`;
				const binds = [s.tool, sampleId, ...s.binds];
				const stats = (
					await db.query<{
						occurrences: number;
						distinctRequests: number;
						distinctProjects: number;
						requestsWithoutProject: number;
						knownSessions: number;
						requestsWithoutSession: number;
						firstObserved: number;
						lastObserved: number;
					}>(
						`SELECT COUNT(*) occurrences,COUNT(DISTINCT r.id) distinctRequests, COUNT(DISTINCT r.project) distinctProjects, COUNT(DISTINCT CASE WHEN r.project IS NULL THEN r.id END) requestsWithoutProject, COUNT(DISTINCT r.session_key) knownSessions,COUNT(DISTINCT CASE WHEN r.session_key IS NULL THEN r.id END) requestsWithoutSession,MIN(r.timestamp) firstObserved,MAX(r.timestamp) lastObserved FROM request_tool_errors te JOIN requests r ON r.id=te.request_id WHERE ${where}`,
						binds,
					)
				)[0];
				if (!stats?.distinctRequests)
					throw new SelectionError(
						"This error group is no longer available. Refresh the error list.",
						404,
					);
				const projects = await db.query<{
					project: string | null;
					requests: number;
				}>(
					`SELECT r.project,COUNT(DISTINCT r.id) requests FROM request_tool_errors te JOIN requests r ON r.id=te.request_id WHERE ${where} GROUP BY r.project ORDER BY requests DESC,r.project ASC LIMIT 20`,
					binds,
				);
				const requests = await db.query<{
					requestId: string;
					timestamp: number;
					project: string | null;
					model: string | null;
					payloadAvailable: number;
				}>(
					`SELECT DISTINCT r.id requestId,r.timestamp,r.project,r.model,EXISTS(SELECT 1 FROM request_payloads p WHERE p.id=r.id) payloadAvailable FROM request_tool_errors te JOIN requests r ON r.id=te.request_id WHERE ${where} ORDER BY r.timestamp DESC,r.id ASC LIMIT ? OFFSET ?`,
					[...binds, s.limit + 1, s.offset],
				);
				response.detail = {
					...stats,
					group: {
						sampleId,
						errorText: group.error_text,
						occurrences: stats.occurrences,
					},
					projects,
					projectsOmitted: Math.max(
						0,
						stats.distinctProjects +
							(stats.requestsWithoutProject > 0 ? 1 : 0) -
							projects.length,
					),
					requests: requests
						.slice(0, s.limit)
						.map((r) => ({ ...r, payloadAvailable: !!r.payloadAvailable })),
					offset: s.offset,
					hasMore: requests.length > s.limit,
				};
			}
			return Response.json(response);
		} catch (error) {
			return failure(error);
		}
	};
}

export function createToolErrorExampleHandler(context: APIContext) {
	return async (params: URLSearchParams): Promise<Response> => {
		try {
			const s = selection(params);
			const sampleId = integer(params.get("sampleId"), 0, 1);
			const group = await resolveGroup(context, s, sampleId);
			const requestId = params.get("requestId");
			if (!requestId || requestId.length > 1024)
				throw new SelectionError("A request ID is required");
			const rows = await context.db.query<{ id: string }>(
				`SELECT r.id FROM requests r WHERE r.id=? AND ${s.where} AND EXISTS(SELECT 1 FROM request_tool_errors te WHERE te.request_id=r.id AND te.tool_name=? AND te.error_text=(SELECT error_text FROM request_tool_errors WHERE id=?))`,
				[requestId, ...s.binds, s.tool, sampleId],
			);
			if (!rows.length)
				throw new SelectionError(
					"Request not found in this error selection",
					404,
				);
			const unavailable: ToolErrorExampleResponse = {
				requestId,
				state: "unavailable",
				totalMatches: 0,
				matches: [],
				omittedMatches: 0,
			};
			const payload = (await context.dbOps.getRequestPayload(requestId)) as {
				request?: { body?: unknown };
			} | null;
			if (!payload?.request?.body) return Response.json(unavailable);
			if (typeof payload.request.body !== "string")
				return Response.json({ ...unavailable, state: "malformed" });
			// Historical payloads can predate the recorder's current capture limit.
			if (payload.request.body.length > 6 * 1024 * 1024)
				return Response.json({ ...unavailable, state: "too-large" });
			let body: unknown;
			try {
				body = JSON.parse(
					Buffer.from(payload.request.body, "base64").toString("utf8"),
				);
			} catch {
				return Response.json({ ...unavailable, state: "malformed" });
			}
			return Response.json({
				requestId,
				...extractToolErrorEvidence(
					body,
					s.tool,
					group.error_text,
					group.error_hex,
				),
			} satisfies ToolErrorExampleResponse);
		} catch (error) {
			return failure(error);
		}
	};
}
