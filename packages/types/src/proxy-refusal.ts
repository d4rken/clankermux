/**
 * `AppError.code` values whose message is written for the client: a 400 about
 * the request itself. Counterparts: `ModelNotServedError`,
 * `RequestUntranslatableError` in @clankermux/core.
 */
const CLIENT_FACING_REFUSAL_CODES: ReadonlySet<string> = new Set([
	"MODEL_NOT_SERVED",
	"REQUEST_UNTRANSLATABLE",
]);

/**
 * The client-facing message of a proxy refusal, or null for any other thrown
 * value, whose message must not leave the proxy.
 */
export function clientFacingProxyRefusal(err: unknown): string | null {
	if (!(err instanceof Error)) return null;
	const code = (err as { code?: unknown }).code;
	return typeof code === "string" && CLIENT_FACING_REFUSAL_CODES.has(code)
		? err.message
		: null;
}
