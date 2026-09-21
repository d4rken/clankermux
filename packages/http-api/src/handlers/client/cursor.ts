/**
 * The page cursor for `GET /client/v1/requests`.
 *
 * OPAQUE to the caller by construction: it carries the `(timestamp, id)` pair
 * the next page seeks from, and nothing a client is invited to build by hand.
 * Encoding it keeps the paging key an implementation detail — the alternative,
 * two published query parameters, freezes the sort key into the contract.
 */

/** The position a page resumes from. Exclusive: the named row is already read. */
export interface ClientRequestCursor {
	timestamp: number;
	id: string;
}

export function encodeClientRequestCursor(cursor: ClientRequestCursor): string {
	return Buffer.from(
		JSON.stringify({ t: cursor.timestamp, i: cursor.id }),
		"utf8",
	).toString("base64url");
}

/**
 * Decode a cursor, or null when it is not one this server issued.
 *
 * Null is the caller's 400. A truncated or foreign cursor must never fall back
 * to "start from the beginning": a reconciliation scan that silently restarts
 * re-delivers everything it already processed, and the client has no way to
 * tell that from a page of genuinely new rows. Refusing is recoverable;
 * restarting is not.
 *
 * `Buffer.from(…, "base64url")` ignores bytes outside the alphabet rather than
 * failing, so the structural check below — not the decode — is what rejects
 * damaged input.
 */
export function decodeClientRequestCursor(
	raw: string,
): ClientRequestCursor | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const { t, i } = parsed as { t?: unknown; i?: unknown };
	if (typeof t !== "number" || !Number.isSafeInteger(t)) return null;
	if (typeof i !== "string" || i === "") return null;
	return { timestamp: t, id: i };
}
