/**
 * Header codec shared by the per-attempt audit channels
 * (`reasoning-adaptation.ts`, `service-tier-adaptation.ts`): a flat record of
 * short client-influenced strings, carried from a provider transform to the
 * attempt row.
 *
 * Base64 over UTF-8 bytes: the values carry client-supplied strings verbatim,
 * and a raw one can hold control characters that header validation rejects or
 * non-Latin-1 characters that a Headers round-trip mangles.
 */

/**
 * Cap on a single recorded value. These are vocabulary words; anything longer
 * is a client sending something that is not one, and it must not become an
 * unbounded header value or column. The ellipsis keeps a truncated record
 * self-evidently truncated.
 */
const MAX_FIELD_CHARS = 64;

export function auditField(value: unknown): string | null {
	if (typeof value !== "string") return null;
	return value.length <= MAX_FIELD_CHARS
		? value
		: `${value.slice(0, MAX_FIELD_CHARS)}…`;
}

/** Encode, or null when every field is null and the header should stay absent. */
export function encodeAuditRecord<K extends string>(
	keys: readonly K[],
	record: Readonly<Record<K, string | null>>,
): string | null {
	const capped = {} as Record<K, string | null>;
	let any = false;
	for (const key of keys) {
		capped[key] = auditField(record[key]);
		if (capped[key] !== null) any = true;
	}
	if (!any) return null;
	let binary = "";
	for (const byte of new TextEncoder().encode(JSON.stringify(capped)))
		binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** Inverse of {@link encodeAuditRecord}; null on anything unreadable or empty. */
export function decodeAuditRecord<K extends string>(
	keys: readonly K[],
	value: string | null | undefined,
): Record<K, string | null> | null {
	if (!value) return null;
	try {
		const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
		const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			return null;
		const source = parsed as Record<string, unknown>;
		const record = {} as Record<K, string | null>;
		let any = false;
		for (const key of keys) {
			record[key] = auditField(source[key]);
			if (record[key] !== null) any = true;
		}
		return any ? record : null;
	} catch {
		return null;
	}
}
