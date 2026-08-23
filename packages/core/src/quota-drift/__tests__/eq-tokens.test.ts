import { describe, expect, it } from "bun:test";
import { __pricingTestHooks } from "../../pricing";
import {
	ANTHROPIC_EQ_WEIGHTS,
	type EqTokenWeights,
	eqTokenProviderFor,
	eqTokens,
	OPENAI_EQ_WEIGHTS,
} from "../eq-tokens";

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

/**
 * Models whose list price does NOT follow their provider's usual ratios, with
 * the ratio each one actually carries.
 *
 * These are recorded, not skipped: the entry pins the exact divergent value, so
 * this model moving again, or any OTHER model diverging, still fails. Removing
 * an entry when the provider re-aligns a price is the intended maintenance.
 *
 * `gpt-5.3-codex-spark` is priced 1.75 in / 14 out, an 8x output ratio against
 * the 6x every other Codex-served model carries. Its exposure is therefore
 * understated by the shared weight — inert today (the model has zero recorded
 * requests in this deployment), but it is a real bias if that ever changes.
 */
const KNOWN_RATIO_DIVERGENCES: Readonly<
	Record<
		string,
		Partial<Record<"output" | "cache_read" | "cache_write", number>>
	>
> = {
	"gpt-5.3-codex-spark": { output: 8 },
};

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
		const want = KNOWN_RATIO_DIVERGENCES[id]?.[kind] ?? providerWeight;
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

	it("still pins a model that diverges from its provider's ratios", () => {
		// The divergence list is not an escape hatch: the exact value is asserted,
		// so this model moving again fails just as loudly as a new divergence.
		const spark = entriesFor("openai").find(
			([id]) => id === "gpt-5.3-codex-spark",
		);
		expect(spark).toBeDefined();
		const [, cost] = spark as [string, ModelCost];
		expect(cost.output / cost.input).toBeCloseTo(8, 9);
		// It is priced above the shared weight, so the shared weight understates
		// its exposure rather than overstating it.
		expect(cost.output / cost.input).toBeGreaterThan(OPENAI_EQ_WEIGHTS.output);
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
	it("weights each class by its provider's ratios", () => {
		const counts = {
			inputTokens: 1000,
			outputTokens: 100,
			cacheReadInputTokens: 10_000,
			cacheCreationInputTokens: 400,
		};

		expect(eqTokens(counts, "anthropic")).toBeCloseTo(
			1000 + 400 * 1.25 + 10_000 * 0.1 + 100 * 5,
			9,
		);
		expect(eqTokens(counts, "openai")).toBeCloseTo(
			1000 + 400 * 1.25 + 10_000 * 0.1 + 100 * 6,
			9,
		);
	});

	it("treats missing, negative and non-finite counts as zero", () => {
		expect(eqTokens({}, "anthropic")).toBe(0);
		expect(
			eqTokens(
				{
					inputTokens: -500,
					outputTokens: Number.NaN,
					cacheReadInputTokens: 10,
				},
				"anthropic",
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
