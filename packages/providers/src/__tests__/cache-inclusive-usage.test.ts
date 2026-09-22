/**
 * Two paths convert a cache-inclusive input count into Anthropic's additive
 * shape: the Codex/Responses normaliser here, and the OpenAI chat-completions
 * one in `@clankermux/openai-formats`. They live in different packages because
 * they answer to different wire formats, and they must not drift apart on the
 * arithmetic: a row's token columns say nothing about which translator wrote
 * them, so a client cannot compensate for a difference it can't see.
 *
 * This is the file the comment on `normalizeCacheInclusiveInput` points at.
 */

import { describe, expect, it } from "bun:test";
import { normalizeCacheInclusiveInput } from "@clankermux/openai-formats";
import { normalizeCodexInputUsage } from "../providers/codex/usage";

// total, cache read, cache creation
const CASES: Array<[number, number, number]> = [
	[1_000, 800, 100],
	[1_000, 0, 0],
	[0, 0, 0],
	// A read that claims more than the whole prompt.
	[10, 25, 0],
	// A write that claims what is left after the read, and more.
	[100, 60, 80],
	// Counters that are not counts.
	[100, Number.NaN, -5],
];

describe("cache-inclusive input normalisation agrees across translators", () => {
	for (const [total, read, creation] of CASES) {
		it(`total=${total} read=${read} creation=${creation}`, () => {
			const chat = normalizeCacheInclusiveInput(total, read, creation);
			const responses = normalizeCodexInputUsage(total, read, creation);

			expect(chat.inputTokens).toBe(responses.inputTokens);
			expect(chat.cacheReadInputTokens).toBe(
				responses.cacheReadInputTokens ?? 0,
			);
			expect(chat.cacheCreationInputTokens).toBe(
				responses.cacheCreationInputTokens ?? 0,
			);
			// Whatever the inputs, the three classes reconstruct the total.
			expect(
				chat.inputTokens +
					chat.cacheReadInputTokens +
					chat.cacheCreationInputTokens,
			).toBe(Math.max(0, Number.isFinite(total) ? total : 0));
		});
	}
});
