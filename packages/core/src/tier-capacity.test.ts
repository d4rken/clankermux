import { describe, expect, it } from "bun:test";
import { TIER_CAPACITY_TABLE, tierCapacityUnits } from "./tier-capacity";

describe("tierCapacityUnits", () => {
	it("resolves every row of the table to its declared units", () => {
		expect(TIER_CAPACITY_TABLE.length).toBe(7);
		for (const entry of TIER_CAPACITY_TABLE) {
			expect(
				tierCapacityUnits({
					provider: entry.provider,
					planTier: entry.planTier,
					rateLimitTier: entry.rateLimitTier,
				}),
			).toBe(entry.units);
		}
	});

	it("returns null for a tier the table does not list", () => {
		// A known plan with an unlisted rate-limit token, an unknown plan, a
		// provider with no rows at all, and a missing plan tier are all the same
		// answer: no capacity, never a default of 1.
		expect(
			tierCapacityUnits({
				provider: "anthropic",
				planTier: "max",
				rateLimitTier: null,
			}),
		).toBeNull();
		expect(
			tierCapacityUnits({
				provider: "anthropic",
				planTier: "team",
				rateLimitTier: null,
			}),
		).toBeNull();
		expect(
			tierCapacityUnits({
				provider: "anthropic",
				planTier: "pro",
				rateLimitTier: "1x",
			}),
		).toBeNull();
		expect(
			tierCapacityUnits({
				provider: "codex",
				planTier: "pro",
				rateLimitTier: "20x",
			}),
		).toBeNull();
		expect(
			tierCapacityUnits({
				provider: "codex",
				planTier: "team",
				rateLimitTier: null,
			}),
		).toBeNull();
		expect(
			tierCapacityUnits({
				provider: "ollama",
				planTier: null,
				rateLimitTier: null,
			}),
		).toBeNull();
		expect(
			tierCapacityUnits({
				provider: "anthropic",
				planTier: null,
				rateLimitTier: "20x",
			}),
		).toBeNull();
	});

	it("never parses a multiplier out of the token", () => {
		// "10x" reads like a capacity; the table is a lookup, so an unlisted
		// token is unknown rather than a guessed 10.
		expect(
			tierCapacityUnits({
				provider: "anthropic",
				planTier: "max",
				rateLimitTier: "10x",
			}),
		).toBeNull();
	});

	it("carries the declared ratios within each provider", () => {
		const units = (
			provider: string,
			planTier: string,
			rateLimitTier: string | null,
		): number => {
			const value = tierCapacityUnits({ provider, planTier, rateLimitTier });
			if (value === null) throw new Error("expected a known tier");
			return value;
		};

		const anthropicPro = units("anthropic", "pro", null);
		const anthropic5x = units("anthropic", "max", "5x");
		const anthropic20x = units("anthropic", "max", "20x");
		expect(anthropic20x / anthropic5x).toBe(4);
		expect(anthropic5x / anthropicPro).toBe(5);
		expect(units("anthropic", "pro", "pro")).toBe(anthropicPro);

		const codexPlus = units("codex", "plus", null);
		const codexProLite = units("codex", "prolite", null);
		const codexPro = units("codex", "pro", null);
		expect(codexPro / codexProLite).toBe(4);
		expect(codexProLite / codexPlus).toBe(5);
	});
});
