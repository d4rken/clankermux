/**
 * Shared, defensive JWT payload decoder used by provider identity extraction.
 *
 * Only the payload (second dot-delimited segment) is base64url-decoded and
 * JSON-parsed — the signature is never verified. These tokens come from our own
 * OAuth flows and we read only non-authoritative identity claims from them, so
 * we deliberately trust the transport rather than the token.
 *
 * Returns the decoded claims object, or `null` on ANY failure (missing segment,
 * bad base64, malformed JSON, or a non-object payload). Never throws.
 */
export function decodeJwtPayloadSafe(
	token: string,
): Record<string, unknown> | null {
	try {
		const payload = token.split(".")[1];
		if (!payload) return null;
		const decoded: unknown = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf8"),
		);
		return decoded != null &&
			typeof decoded === "object" &&
			!Array.isArray(decoded)
			? (decoded as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}
