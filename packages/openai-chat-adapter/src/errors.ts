export class ChatError extends Error {
	constructor(
		message: string,
		readonly param: string | null = null,
		readonly status = 400,
		readonly code = "invalid_request_error",
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
			error.status >= 500 ? "api_error" : "invalid_request_error",
			error.code,
			error.param,
		),
		{ status: error.status },
	);
}
export function upstreamFailure(message: string): ChatError {
	return new ChatError(message, null, 502, "invalid_upstream_response");
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
