/**
 * `x-clankermux-correlation-tag` — an opaque identifier the CLIENT picks so it
 * can find its own request again afterwards.
 *
 * The value is stored VERBATIM or not at all. `gateway-hint-headers.ts` is the
 * structural sibling (opaque client header to stored column) but it repairs
 * what it is given, and repairing is wrong here: the tag is the exact key a
 * client looks itself up by, so quietly turning `run<TAB>42` into `run42`
 * yields a tag that looks valid, is not the one the client holds, and matches
 * some other request on the way back. `normalizeProjectCandidate` in
 * project-extraction.ts refuses rather than slices for the same reason.
 */

/**
 * The ingest header. Named inside the `x-clankermux-` prefix on purpose:
 * `stripInternalControlHeaders` in handlers/request-handler.ts sweeps that
 * whole prefix off the final outbound headers, so this never reaches a
 * provider without anyone maintaining a delete list.
 */
export const CORRELATION_TAG_HEADER = "x-clankermux-correlation-tag";

/** Inclusive upper bound. All accepted bytes are ASCII, so bytes === chars. */
export const CORRELATION_TAG_MAX_BYTES = 128;

/**
 * 1 to 128 bytes, every byte printable US-ASCII (0x20-0x7E). Excludes TAB
 * (0x09) and DEL (0x7F), which are the two an "it's basically text" check
 * tends to let through.
 */
const CORRELATION_TAG_RE = /^[\x20-\x7E]{1,128}$/;

/**
 * Accept a client-supplied correlation tag, or refuse it.
 *
 * VALIDATES, never transforms: the return value is the input unchanged or
 * `null`. No trimming (HTTP already strips optional whitespace around a field
 * value before it reaches us), no truncation, no control-character stripping.
 * An empty value is absent.
 *
 * Shared with the client API's query parameter so the set of tags that reach
 * the column is exactly the set that can be searched for.
 */
export function validateCorrelationTag(
	raw: string | null | undefined,
): string | null {
	if (typeof raw !== "string") return null;
	return CORRELATION_TAG_RE.test(raw) ? raw : null;
}

/**
 * Read the tag off a captured request-header record, or `null`.
 *
 * Never throws and never fails the request: a rejected tag costs the row its
 * `correlation_tag` and nothing else. A metadata header must not kill a paid
 * model call.
 *
 * Names are compared case-insensitively. `Headers` lowercases on the way in, so
 * in production the lookup is exact; the scan covers records assembled by hand.
 */
export function extractCorrelationTag(
	headers: Record<string, string>,
): string | null {
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() !== CORRELATION_TAG_HEADER) continue;
		return validateCorrelationTag(value);
	}
	return null;
}
