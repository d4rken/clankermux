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
 *
 * PREMISE: the translation that marks and the finalization that reads run in
 * the SAME process. This is module scope, so nothing is shared across a worker
 * boundary; split them and every mark is written to one Set and read from
 * another, the suppression silently stops, and the published contract would go
 * on claiming the zeros are gone. That is worse than the defect it replaced.
 *
 * What holds it today is structural rather than incidental. Both run inside one
 * `proxyWithAccount` call: `processResponse` hands `forwardToClient` a Response
 * whose body is a live in-memory stream, which is not a thing that crosses a
 * worker boundary. The proxy package spawns no workers at all; every `new
 * Worker` in this repo is database maintenance or dashboard analytics, and
 * none of them translates a provider response or collects usage.
 *
 * The temptation is specific and has been acted on before: usage finalization
 * USED to run in a post-processor worker and was deliberately brought back onto
 * the main thread. `packages/proxy/src/__tests__/response-handler-worker-protocol.test.ts`
 * pins that retirement. If it is ever undone, this registry has to move with it
 * or be replaced by something the two sides genuinely share.
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
