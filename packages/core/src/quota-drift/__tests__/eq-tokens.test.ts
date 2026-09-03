import { describe, expect, it } from "bun:test";
import { __pricingTestHooks } from "../../pricing";
import {
	ANTHROPIC_EQ_WEIGHTS,
	type EqTokenWeights,
	eqTokenProviderFor,
	eqTokens,
	MODEL_EQ_WEIGHT_OVERRIDES,
	OPENAI_EQ_WEIGHTS,
} from "../eq-tokens";
import { normalizeModelKey } from "../model-key";

interface ModelCost {
	input: number;
	output: number;
	cache_read?: number;
	cache_write?: number;
}

function entriesFor(provider: string): Array<[string, ModelCost]> {
	const bundled = __pricingTestHooks.bundledPricing() as Record<
		string,
		{ models?: Record<string, { cost?: ModelCost }> }
	>;
	const models = bundled[provider]?.models ?? {};
	return Object.entries(models)
		.filter(([, def]) => def.cost != null)
		.map(([id, def]) => [id, def.cost as ModelCost]);
}

/**
 * The eq-token weights collapse four token classes into one exposure number
 * using the provider's own list-price ratios. Those ratios are load-bearing: a
 * provider re-pricing a class is indistinguishable from a change in capacity,
 * so it has to fail a test rather than shift the estimator silently.
 *
 * A rate class an entry intentionally omits is SKIPPED, not failed. Codex uses
 * an automatic prompt cache and never reports cache-creation tokens, so several
 * entries deliberately carry no `cache_write`; the corresponding term then
 * multiplies a column that is always zero.
 */
const RATIO_TOLERANCE = 1e-9;

/** Which weight field a bundled price-table rate class is compared against. */
const WEIGHT_FIELD: Readonly<
	Record<"output" | "cache_read" | "cache_write", keyof EqTokenWeights>
> = {
	output: "output",
	cache_read: "cacheRead",
	cache_write: "cacheCreate",
};

/**
 * A model whose list price does NOT follow its provider's usual ratios is
 * expected to be PRICED on its own override, not merely documented.
 *
 * The expectation is read straight out of `MODEL_EQ_WEIGHT_OVERRIDES`, so three
 * things fail here: a new divergent model with no override, an override that no
 * longer matches the price table, and a provider re-price. Removing an override
 * once a provider re-aligns a price is the intended maintenance.
 *
 * `gpt-5.3-codex-spark` is priced 1.75 in / 14 out, an 8x output ratio against
 * the 6x every other Codex-served model carries. A ratio error is systematic:
 * no confidence interval can correct it, because every bootstrap resample
 * carries the same wrong exposure.
 */
function assertRatios(provider: string, weights: EqTokenWeights): void {
	const entries = entriesFor(provider);
	expect(entries.length).toBeGreaterThan(0);

	// Collected rather than asserted one at a time, so a re-price names the model
	// and the class it moved instead of failing on an anonymous number.
	const mismatches: string[] = [];
	const check = (
		id: string,
		kind: "output" | "cache_read" | "cache_write",
		actual: number,
		providerWeight: number,
	) => {
		const override = MODEL_EQ_WEIGHT_OVERRIDES[normalizeModelKey(id)];
		const want = override ? override[WEIGHT_FIELD[kind]] : providerWeight;
		if (Math.abs(actual - want) > RATIO_TOLERANCE) {
			mismatches.push(`${id}: ${kind} ratio ${actual}, expected ${want}`);
		}
	};

	for (const [id, cost] of entries) {
		expect(cost.input).toBeGreaterThan(0);
		check(id, "output", cost.output / cost.input, weights.output);
		if (cost.cache_read != null) {
			check(id, "cache_read", cost.cache_read / cost.input, weights.cacheRead);
		}
		if (cost.cache_write != null) {
			check(
				id,
				"cache_write",
				cost.cache_write / cost.input,
				weights.cacheCreate,
			);
		}
	}

	expect(mismatches).toEqual([]);
}

describe("EQ_WEIGHTS invariants against the bundled price table", () => {
	it("matches every currently-priced Anthropic model's ratios", () => {
		assertRatios("anthropic", ANTHROPIC_EQ_WEIGHTS);
	});

	it("matches every currently-priced OpenAI/Codex model's ratios", () => {
		assertRatios("openai", OPENAI_EQ_WEIGHTS);
	});

	it("prices a model that diverges from its provider's ratios on its own weights", () => {
		// The override is not an escape hatch: the exact value is asserted, so
		// this model moving again fails just as loudly as a new divergence.
		const spark = entriesFor("openai").find(
			([id]) => id === "gpt-5.3-codex-spark",
		);
		expect(spark).toBeDefined();
		const [, cost] = spark as [string, ModelCost];
		expect(cost.output / cost.input).toBeCloseTo(8, 9);
		// It is priced above the shared weight, so the shared weight would
		// understate its exposure and inflate its fitted coefficient.
		expect(cost.output / cost.input).toBeGreaterThan(OPENAI_EQ_WEIGHTS.output);

		const override = MODEL_EQ_WEIGHT_OVERRIDES["gpt-5.3-codex-spark"];
		expect(override).toBeDefined();
		expect(override.output).toBeCloseTo(cost.output / cost.input, 9);
		// Only the diverging class differs; the rest stay on the provider ratios.
		expect(override.input).toBe(OPENAI_EQ_WEIGHTS.input);
		expect(override.cacheRead).toBe(OPENAI_EQ_WEIGHTS.cacheRead);
		expect(override.cacheCreate).toBe(OPENAI_EQ_WEIGHTS.cacheCreate);
	});

	it("prices GPT-6 Astra's 5x output ratio on its own weights", () => {
		// $10 in / $50 out: BELOW the shared 6x, so the provider weight would
		// overstate output exposure and deflate the fitted coefficient.
		const astra = entriesFor("openai").find(([id]) => id === "gpt-6-astra");
		expect(astra).toBeDefined();
		const [, cost] = astra as [string, ModelCost];
		expect(cost.output / cost.input).toBeCloseTo(5, 9);
		expect(cost.output / cost.input).toBeLessThan(OPENAI_EQ_WEIGHTS.output);

		const override = MODEL_EQ_WEIGHT_OVERRIDES["gpt-6-astra"];
		expect(override).toBeDefined();
		expect(override.output).toBeCloseTo(cost.output / cost.input, 9);
		expect(override.input).toBe(OPENAI_EQ_WEIGHTS.input);
		expect(override.cacheRead).toBe(OPENAI_EQ_WEIGHTS.cacheRead);
		expect(override.cacheCreate).toBe(OPENAI_EQ_WEIGHTS.cacheCreate);
	});

	it("prices Fable/Mythos 5.1's cheaper cache reads on their own weights", () => {
		// The 5.1 generation reads cache at $0.25/M against $10/M input — 0.025x
		// where every other Anthropic model reads at 0.1x. Claude Code traffic is
		// cache-read-dominated, so the shared weight would overstate exposure
		// fourfold on the dominant token class.
		for (const id of ["claude-fable-5-1", "claude-mythos-5-1"]) {
			const entry = entriesFor("anthropic").find(([entryId]) => entryId === id);
			expect(entry).toBeDefined();
			const [, cost] = entry as [string, ModelCost];
			expect((cost.cache_read as number) / cost.input).toBeCloseTo(0.025, 9);

			const override = MODEL_EQ_WEIGHT_OVERRIDES[id];
			expect(override).toBeDefined();
			expect(override.cacheRead).toBeCloseTo(0.025, 9);
			// Only the diverging class differs; the rest stay on the provider ratios.
			expect(override.input).toBe(ANTHROPIC_EQ_WEIGHTS.input);
			expect(override.output).toBe(ANTHROPIC_EQ_WEIGHTS.output);
			expect(override.cacheCreate).toBe(ANTHROPIC_EQ_WEIGHTS.cacheCreate);
		}
	});

	it("tolerates a Codex entry that omits cache_write", () => {
		// Not a hypothetical: Codex reports no cache-creation tokens, so several
		// entries carry no rate for it.
		const omitting = entriesFor("openai").filter(
			([, cost]) => cost.cache_write == null,
		);
		expect(omitting.length).toBeGreaterThan(0);
	});
});

describe("eqTokens", () => {
	const counts = {
		inputTokens: 1000,
		outputTokens: 100,
		cacheReadInputTokens: 10_000,
		cacheCreationInputTokens: 400,
	};

	it("weights each class by its provider's ratios", () => {
		expect(eqTokens(counts, "anthropic", "claude-opus-5")).toBeCloseTo(
			1000 + 400 * 1.25 + 10_000 * 0.1 + 100 * 5,
			9,
		);
		expect(eqTokens(counts, "openai", "gpt-5.6-codex")).toBeCloseTo(
			1000 + 400 * 1.25 + 10_000 * 0.1 + 100 * 6,
			9,
		);
	});

	it("prefers a model's own weights over its provider's", () => {
		// The 8x output ratio, not the shared 6x. Fitting an output-heavy model on
		// the shared weight inflates its coefficient by about a third, and no
		// interval can correct a systematic weight error.
		expect(eqTokens(counts, "openai", "gpt-5.3-codex-spark")).toBeCloseTo(
			1000 + 400 * 1.25 + 10_000 * 0.1 + 100 * 8,
			9,
		);
	});

	it("treats missing, negative and non-finite counts as zero", () => {
		expect(eqTokens({}, "anthropic", "claude-opus-5")).toBe(0);
		expect(
			eqTokens(
				{
					inputTokens: -500,
					outputTokens: Number.NaN,
					cacheReadInputTokens: 10,
				},
				"anthropic",
				"claude-opus-5",
			),
		).toBeCloseTo(1, 9);
	});
});

describe("eqTokenProviderFor", () => {
	it("prices codex accounts on the OpenAI ratios and everything else on Anthropic's", () => {
		expect(eqTokenProviderFor("codex")).toBe("openai");
		expect(eqTokenProviderFor("openai")).toBe("openai");
		expect(eqTokenProviderFor("anthropic")).toBe("anthropic");
		expect(eqTokenProviderFor(null)).toBe("anthropic");
	});
});
