/**
 * Raw extraction of the OpenAI-compatible rate-limit headers.
 *
 * Pure and dependency-free by design: `sanitizeHeaders` (stream.ts) deletes
 * every `x-ratelimit-*` line before the response reaches the client, so those
 * readings exist for exactly as long as the raw upstream response does. This
 * module turns them into a recordable shape; the proxy decides when to call it
 * and where the rows go. Nothing here touches a database.
 */

/** Which quantity a bucket line describes. */
export type OpenAiRateLimitBucket = "tokens" | "requests";

/**
 * One bucket's headers as they arrived.
 *
 * Absent and malformed both read as `null`, and a reported `0` stays `0`.
 * `resetRaw` is kept VERBATIM: OpenAI reports it as a duration string (`"6m0s"`,
 * `"1.2s"`) whose grammar is undocumented and has changed, and a parsed number
 * would bake this build's guess about that grammar into the series permanently.
 */
export interface RawOpenAiBucketReading {
	bucket: OpenAiRateLimitBucket;
	/** `x-ratelimit-limit-<bucket>` as a strict non-negative integer. */
	limitValue: number | null;
	/** `x-ratelimit-remaining-<bucket>` as a strict non-negative integer. */
	remaining: number | null;
	/** `x-ratelimit-reset-<bucket>` verbatim. */
	resetRaw: string | null;
}

/** Full-string non-negative integer. A prefix match is not a reading. */
const STRICT_INTEGER_RE = /^\d+$/;

/**
 * A strict integer reading, or null.
 *
 * Refuses `parseInt`'s prefix tolerance: `"60000 tokens"` and `"6e4"` are
 * malformed headers, and turning them into 60000 and 6 would put values the
 * provider never sent into the series.
 */
function parseStrictInteger(value: string | null): number | null {
	if (value === null || !STRICT_INTEGER_RE.test(value)) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

const BUCKETS: readonly OpenAiRateLimitBucket[] = ["requests", "tokens"];

/**
 * The `x-ratelimit-*` bucket readings on this response.
 *
 * A bucket is emitted when ANY of its three headers is present, even if none of
 * them parses: the presence of a malformed header is itself the observation, and
 * dropping the row would hide precisely the shapes worth seeing. A response with
 * no bucket headers at all yields `[]`, so a non-OpenAI upstream costs nothing.
 *
 * Deterministic order (`requests` then `tokens`) so two passes over one response
 * produce identical rows.
 */
export function extractRawOpenAiBuckets(
	headers: Headers,
): RawOpenAiBucketReading[] {
	const out: RawOpenAiBucketReading[] = [];
	for (const bucket of BUCKETS) {
		const limitRaw = headers.get(`x-ratelimit-limit-${bucket}`);
		const remainingRaw = headers.get(`x-ratelimit-remaining-${bucket}`);
		const resetRaw = headers.get(`x-ratelimit-reset-${bucket}`);
		if (limitRaw === null && remainingRaw === null && resetRaw === null) {
			continue;
		}
		out.push({
			bucket,
			limitValue: parseStrictInteger(limitRaw),
			remaining: parseStrictInteger(remainingRaw),
			resetRaw,
		});
	}
	return out;
}
