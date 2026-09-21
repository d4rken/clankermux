/**
 * OpenAI chat-completions reports a CACHE-INCLUSIVE prompt count: `prompt_tokens`
 * is the whole prompt, and `prompt_tokens_details` breaks out the parts of it
 * that were served from, or written to, the cache. Anthropic's shape is
 * ADDITIVE: `input_tokens` holds only what neither cache class covers, so the
 * four classes sum to the billable total.
 *
 * Everything downstream of these translators assumes the additive shape. Passing
 * the inclusive total through as `input_tokens` while also reporting the cache
 * classes counts the cached prefix twice, in the stored token columns, in the
 * cost, and in the cache-hit rate.
 */

export interface DisjointInputUsage {
	/** Anthropic's additive input: neither cache-read nor cache-written. */
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
}

/**
 * Split a cache-inclusive prompt count into the three additive classes.
 *
 * ```
 * (1000, 800, 100) -> { input: 100, read: 800, creation: 100 }
 * (1000,   0,   0) -> { input: 1000, read: 0, creation: 0 }
 * (  10,  25,   0) -> { input: 0, read: 10, creation: 0 }   // clamped
 * ```
 *
 * Reads are clamped to the total and writes to what remains, so upstream
 * counters that disagree with their own total cannot drive the additive input
 * negative. `packages/providers/src/__tests__/cache-inclusive-usage.test.ts`
 * pins this against the Codex path's normaliser, which applies the same rule.
 */
export function normalizeCacheInclusiveInput(
	totalInputTokens: number,
	cacheReadInputTokens: number,
	cacheCreationInputTokens: number,
): DisjointInputUsage {
	const count = (value: number): number =>
		Number.isFinite(value) && value > 0 ? value : 0;
	const total = count(totalInputTokens);
	const read = Math.min(count(cacheReadInputTokens), total);
	const creation = Math.min(count(cacheCreationInputTokens), total - read);
	return {
		inputTokens: total - read - creation,
		cacheReadInputTokens: read,
		cacheCreationInputTokens: creation,
	};
}

/**
 * The two cache counters carried in `prompt_tokens_details`. `cached_tokens` is
 * OpenAI's own field; `cache_creation_input_tokens` is a Qwen/DashScope
 * extension. Both are parts of `prompt_tokens`, never additions to it.
 */
export function readPromptTokensDetails(
	details: Record<string, unknown> | undefined,
): { cacheReadInputTokens: number; cacheCreationInputTokens: number } {
	const number = (value: unknown): number =>
		typeof value === "number" && Number.isFinite(value) && value > 0
			? value
			: 0;
	return {
		cacheReadInputTokens: number(details?.cached_tokens),
		cacheCreationInputTokens: number(details?.cache_creation_input_tokens),
	};
}
