/**
 * Which requests had NO usage block from upstream at all.
 *
 * The Anthropic shape requires `usage.input_tokens` and `usage.output_tokens`,
 * and a client SDK accumulates straight through them, so a translator handed a
 * provider response that reported nothing still has to emit the fields. Those
 * values are placeholders. The usage collector reads the same translated stream
 * the client does, so from the bytes alone it cannot tell a fabricated 0 from a
 * provider that measured zero, and the row publishes a stored 0 as a positive
 * claim that none of that class was consumed.
 *
 * Keyed on the RESPONSE rather than the provider: qwen, kilo and
 * openai-compatible normally do report usage, so which of their responses
 * carried a block is a per-request fact and nothing about the provider answers
 * it.
 *
 * The id comes from `x-clankermux-request-id`, which the proxy injects onto the
 * upstream response before `processResponse` runs precisely so a provider can
 * read it without the original request.
 */

/**
 * Bounded so a mark whose request never finalizes cannot accumulate. Each entry
 * is one short string, and the cap is far above any plausible concurrency; the
 * oldest is evicted rather than the newest refused, because a stale mark is
 * worth less than a current one.
 */
const MAX_MARKS = 4096;

const reportedNoUsage = new Set<string>();

export function markUpstreamReportedNoUsage(requestId: string | null): void {
	if (!requestId) return;
	if (reportedNoUsage.size >= MAX_MARKS) {
		const oldest = reportedNoUsage.values().next();
		if (!oldest.done) reportedNoUsage.delete(oldest.value);
	}
	reportedNoUsage.add(requestId);
}

/**
 * Read and clear. One request asks once, at finalization, and a mark left
 * behind by a request that never got there is what the cap above bounds.
 */
export function consumeUpstreamReportedNoUsage(
	requestId: string | undefined,
): boolean {
	if (!requestId) return false;
	return reportedNoUsage.delete(requestId);
}

/** Test seam: drop every mark. */
export function resetUpstreamUsagePresence(): void {
	reportedNoUsage.clear();
}
