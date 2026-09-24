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
	return Response.json(
		errorEnvelope(
			error.message,
			error.type ??
				(error.status >= 500 ? "api_error" : "invalid_request_error"),
			error.code,
			error.param,
		),
		{ status: error.status },
	);
}
export function upstreamFailure(message: string): ChatError {
	return new ChatError(message, null, 502, "invalid_upstream_response");
}
/** An `error` event the upstream stream carried: its own type and code. */
export function upstreamStreamError(error: unknown): ChatError {
	const e =
		error && typeof error === "object"
			? (error as Record<string, unknown>)
			: {};
	const type =
		typeof e.type === "string" && e.type.trim() ? e.type.trim() : "api_error";
	const code =
		typeof e.code === "string" && e.code.trim() ? e.code.trim() : type;
	// An upstream server error is a bad gateway here; 529 keeps its meaning.
	const status = anthropicErrorStatus(type);
	return new ChatError(
		typeof e.message === "string"
			? e.message.slice(0, 512)
			: "Upstream stream failed",
		null,
		status && (status < 500 || status === 529) ? status : 502,
		code,
		type,
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
