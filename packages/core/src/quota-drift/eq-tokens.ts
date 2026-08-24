import type { TokenCounts } from "./types";

/**
 * Collapse the four token classes into ONE exposure number per model.
 *
 * A usage window is not charged in raw tokens: a cached read costs a fraction
 * of an input token and an output token costs several. Fitting on raw totals
 * would therefore attribute a model's real cost to whichever class happened to
 * dominate its traffic. The weights are the provider's own list-price ratios,
 * normalized so `input = 1`.
 *
 * The absolute scale is irrelevant — a constant factor is absorbed by the
 * fitted coefficient — but the RATIOS are load-bearing, and a provider
 * re-pricing them is indistinguishable from a change in capacity. That is why
 * `eq-tokens.test.ts` re-derives these constants from the bundled pricing table
 * on every run: a re-price then surfaces as a test failure rather than as
 * silent estimator drift.
 */
export interface EqTokenWeights {
	input: number;
	cacheCreate: number;
	cacheRead: number;
	output: number;
}

/**
 * Anthropic list-price ratios, normalized to input = 1. Verified against the
 * haiku-4.5 entry (input 1 / output 5 / cache_read 0.1 / cache_write 1.25);
 * every Anthropic entry in the bundled table shares them.
 */
export const ANTHROPIC_EQ_WEIGHTS: EqTokenWeights = {
	input: 1,
	cacheCreate: 1.25,
	cacheRead: 0.1,
	output: 5,
};

/**
 * OpenAI/Codex list-price ratios, normalized to input = 1. Verified against the
 * gpt-5.6-sol entry (input 5 / output 30 / cache_read 0.5 / cache_write 6.25).
 *
 * Several Codex catalogue entries deliberately omit `cache_write` — Codex uses
 * an automatic prompt cache and never reports cache-creation tokens, so the
 * cacheCreate term multiplies a column that is always zero. Harmless here, and
 * the invariant test skips a rate class an entry intentionally omits rather
 * than failing on it.
 *
 * Models whose list price does not follow these ratios are corrected by
 * {@link MODEL_EQ_WEIGHT_OVERRIDES} rather than left to the provider default.
 */
export const OPENAI_EQ_WEIGHTS: EqTokenWeights = {
	input: 1,
	cacheCreate: 1.25,
	cacheRead: 0.1,
	output: 6,
};

/**
 * Weights for models whose list price does NOT follow their provider's usual
 * ratios, keyed by NORMALIZED model key (see `normalizeModelKey`).
 *
 * A ratio error is systematic: it biases a model's fitted coefficient by a
 * fixed factor no confidence interval can correct, because every resample
 * carries the same wrong exposure. `gpt-5.3-codex-spark` is priced 1.75 in /
 * 14 out — an 8x output ratio against the 6x every other Codex-served model
 * carries — so the provider-wide weight understates its output exposure by a
 * quarter and inflates its coefficient by roughly a third on output-heavy
 * traffic. It has no recorded requests in this deployment today, which makes
 * this a trap that arms itself the first time the model is routed rather than a
 * live defect.
 *
 * `eq-tokens.test.ts` derives its expectations from this map, so an entry that
 * stops matching the bundled price table fails, and so does a NEW divergence
 * with no entry.
 */
export const MODEL_EQ_WEIGHT_OVERRIDES: Readonly<
	Record<string, EqTokenWeights>
> = {
	"gpt-5.3-codex-spark": { ...OPENAI_EQ_WEIGHTS, output: 8 },
};

/** Provider axis the weights are selected on. */
export type EqTokenProvider = "anthropic" | "openai";

export const EQ_WEIGHTS: Readonly<Record<EqTokenProvider, EqTokenWeights>> = {
	anthropic: ANTHROPIC_EQ_WEIGHTS,
	openai: OPENAI_EQ_WEIGHTS,
};

/**
 * Map an account provider string onto the weight set to price it with. `codex`
 * accounts serve OpenAI models; everything else is priced on the Anthropic
 * ratios, which is what the account-level windows this module fits belong to.
 */
export function eqTokenProviderFor(
	accountProvider: string | null | undefined,
): EqTokenProvider {
	return accountProvider === "codex" || accountProvider === "openai"
		? "openai"
		: "anthropic";
}

/**
 * Equivalent tokens for one set of token counts. Negative or non-finite counts
 * are treated as zero: a malformed row must not subtract exposure from a
 * segment, which would push a coefficient up.
 *
 * `modelKey` is the NORMALIZED model key the counts belong to. A model with its
 * own entry in {@link MODEL_EQ_WEIGHT_OVERRIDES} is priced on that entry; every
 * other model is priced on its provider's shared ratios. The argument is
 * required rather than optional because a forgotten key would silently fall
 * back to the shared ratios, which is exactly the bias the map exists to close.
 */
export function eqTokens(
	counts: Partial<TokenCounts>,
	provider: EqTokenProvider,
	modelKey: string,
): number {
	const w = MODEL_EQ_WEIGHT_OVERRIDES[modelKey] ?? EQ_WEIGHTS[provider];
	return (
		safe(counts.inputTokens) * w.input +
		safe(counts.cacheCreationInputTokens) * w.cacheCreate +
		safe(counts.cacheReadInputTokens) * w.cacheRead +
		safe(counts.outputTokens) * w.output
	);
}

function safe(value: number | null | undefined): number {
	if (value == null || !Number.isFinite(value) || value < 0) return 0;
	return value;
}
