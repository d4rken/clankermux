/**
 * Carry a request id on a thrown error, so the Response built from it upstream
 * can still name the request.
 *
 * `handleProxy` stamps `x-clankermux-request-id` on every response it RETURNS,
 * but the give-up terminals record their row and then throw: the id is known
 * where the throw happens and gone where the bytes are built. Those are the
 * refusals a client is most likely to want to look up, so the id travels with
 * the error rather than being reconstructed.
 *
 * A symbol keeps it off every ordinary property walk, and the setter tolerates
 * a frozen or primitive throw value rather than replacing one failure with
 * another.
 */
const REQUEST_ID = Symbol.for("clankermux.requestId");

export function attachRequestId(error: unknown, requestId: string): void {
	if (typeof error !== "object" || error === null) return;
	try {
		Object.defineProperty(error, REQUEST_ID, {
			value: requestId,
			enumerable: false,
			configurable: true,
		});
	} catch {
		// A frozen error keeps its own shape; the response simply goes out
		// without the header, exactly as it did before.
	}
}

export function requestIdFromError(error: unknown): string | null {
	if (typeof error !== "object" || error === null) return null;
	const value = (error as Record<symbol, unknown>)[REQUEST_ID];
	return typeof value === "string" ? value : null;
}
