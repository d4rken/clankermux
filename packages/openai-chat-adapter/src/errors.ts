import { anthropicErrorStatus } from "@clankermux/types";

export class ChatError extends Error {
	constructor(
		message: string,
		readonly param: string | null = null,
		readonly status = 400,
		readonly code = "invalid_request_error",
		/** The envelope's `type`; by default derived from the status. */
		readonly type: string | null = null,
	) {
		super(message);
	}
}
export function errorEnvelope(
	message: string,
	type = "invalid_request_error",
	code = type,
	param: string | null = null,
) {
	return { error: { message, type, param, code } };
}
export function chatErrorResponse(error: ChatError): Response {
	const retryAfter =
		error instanceof UpstreamStreamError ? error.retryAfter : null;
	return Response.json(
		errorEnvelope(
			error.message,
			error.type ??
				(error.status >= 500 ? "api_error" : "invalid_request_error"),
			error.code,
			error.param,
		),
		{
			status: error.status,
			...(retryAfter ? { headers: { "retry-after": retryAfter } } : {}),
		},
	);
}
export function upstreamFailure(message: string): ChatError {
	return new ChatError(message, null, 502, "invalid_upstream_response");
}
/** Retry-After for a JSON-mode 429/529 whose event named none. */
const DEFAULT_RETRY_AFTER_SECONDS = "30";
const MAX_ERROR_LABEL = 128;
// Statuses a client may act on as its own. Anything else, a 401 or 403
// above all, was the upstream's failure, not the client's key.
const CLIENT_STATUSES = new Set([400, 413, 429, 529]);

/** An `error` event the upstream stream carried: its own type and code. */
export class UpstreamStreamError extends ChatError {
	constructor(
		message: string,
		status: number,
		code: string,
		type: string,
		readonly retryAfter: string | null,
	) {
		super(message, null, status, code, type);
	}
}

function label(value: unknown): string | null {
	return typeof value === "string" && value.trim()
		? value.trim().slice(0, MAX_ERROR_LABEL)
		: null;
}

export function upstreamStreamError(error: unknown): UpstreamStreamError {
	const e =
		error && typeof error === "object"
			? (error as Record<string, unknown>)
			: {};
	const type = label(e.type) ?? "api_error";
	const upstreamStatus = anthropicErrorStatus(type);
	const status =
		upstreamStatus && CLIENT_STATUSES.has(upstreamStatus)
			? upstreamStatus
			: 502;
	return new UpstreamStreamError(
		typeof e.message === "string"
			? e.message.slice(0, 512)
			: "Upstream stream failed",
		status,
		label(e.code) ?? type,
		type,
		status === 429 || status === 529 ? DEFAULT_RETRY_AFTER_SECONDS : null,
	);
}
export function object(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ChatError(`${path}: expected an object`, path);
	return value as Record<string, unknown>;
}
export function keys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	path = "",
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			const param = path ? `${path}.${key}` : key;
			throw new ChatError(
				`${param} is not supported`,
				param,
				400,
				"unsupported_parameter",
			);
		}
	}
}
export function string(value: unknown, path: string, empty = false): string {
	if (typeof value !== "string" || (!empty && !value.trim()))
		throw new ChatError(
			`${path}: expected ${empty ? "a string" : "a nonempty string"}`,
			path,
		);
	return value;
}
