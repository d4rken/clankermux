import { describe, expect, it } from "bun:test";
import { deriveSubscriptionPriceUsdMicros } from "./subscription-pricing";

const derive = (input: {
	provider?: string | null;
	planTier?: string | null;
	rateLimitTier?: string | null;
	cadence?: string | null;
}) =>
	deriveSubscriptionPriceUsdMicros({
		provider: input.provider ?? null,
		planTier: input.planTier ?? null,
		rateLimitTier: input.rateLimitTier ?? null,
		cadence: input.cadence ?? null,
	});

describe("deriveSubscriptionPriceUsdMicros", () => {
	describe("anthropic", () => {
		it("prices Max from the rate-limit multiplier", () => {
			expect(
				derive({
					provider: "anthropic",
					planTier: "max",
					rateLimitTier: "20x",
				}),
			).toBe(200_000_000);
			expect(
				derive({ provider: "anthropic", planTier: "max", rateLimitTier: "5x" }),
			).toBe(100_000_000);
		});

		it("refuses Max without a multiplier — the tier covers two prices", () => {
			expect(
				derive({ provider: "anthropic", planTier: "max", rateLimitTier: null }),
			).toBeNull();
			expect(
				derive({ provider: "anthropic", planTier: "max", rateLimitTier: "1x" }),
			).toBeNull();
		});

		it("prices Pro, and ignores the multiplier for it", () => {
			expect(derive({ provider: "anthropic", planTier: "pro" })).toBe(
				20_000_000,
			);
			expect(
				derive({ provider: "anthropic", planTier: "pro", rateLimitTier: "ai" }),
			).toBe(20_000_000);
		});

		it("has no price for free and per-seat plans", () => {
			for (const planTier of ["claude_free", "team", "enterprise"]) {
				expect(derive({ provider: "anthropic", planTier })).toBeNull();
			}
		});

		it("treats a null provider as anthropic, matching the account default", () => {
			expect(
				derive({ provider: null, planTier: "max", rateLimitTier: "20x" }),
			).toBe(200_000_000);
		});
	});

	describe("codex", () => {
		it("prices the known plan types", () => {
			expect(derive({ provider: "codex", planTier: "plus" })).toBe(20_000_000);
			expect(derive({ provider: "codex", planTier: "pro" })).toBe(200_000_000);
			expect(derive({ provider: "codex", planTier: "prolite" })).toBe(
				100_000_000,
			);
		});

		it("has no price for per-seat and unknown plan types", () => {
			for (const planTier of ["team", "business", "enterprise", "edu"]) {
				expect(derive({ provider: "codex", planTier })).toBeNull();
			}
		});

		it("does not borrow the anthropic table", () => {
			// 'max' prices under anthropic but is not a ChatGPT plan type.
			expect(
				derive({ provider: "codex", planTier: "max", rateLimitTier: "20x" }),
			).toBeNull();
		});
	});

	describe("providers with no tier table", () => {
		it("returns null", () => {
			expect(derive({ provider: "devin", planTier: "Pro" })).toBeNull();
			expect(derive({ provider: "zai", planTier: "pro" })).toBeNull();
			expect(derive({ provider: "openrouter", planTier: "pro" })).toBeNull();
		});
	});

	describe("cadence", () => {
		it("resolves for monthly and for an unset cadence", () => {
			expect(
				derive({ provider: "codex", planTier: "pro", cadence: "monthly" }),
			).toBe(200_000_000);
			expect(
				derive({ provider: "codex", planTier: "pro", cadence: null }),
			).toBe(200_000_000);
		});

		it("refuses a yearly cycle — the table holds monthly prices only", () => {
			expect(
				derive({ provider: "codex", planTier: "pro", cadence: "yearly" }),
			).toBeNull();
		});

		it("refuses a one-time date, which is never auto-recorded", () => {
			expect(
				derive({ provider: "codex", planTier: "pro", cadence: "none" }),
			).toBeNull();
		});
	});

	describe("input normalisation", () => {
		it("matches case-insensitively and trims", () => {
			expect(
				derive({ provider: " Codex ", planTier: "PRO", cadence: "Monthly" }),
			).toBe(200_000_000);
			expect(
				derive({
					provider: "ANTHROPIC",
					planTier: " Max ",
					rateLimitTier: "20X",
				}),
			).toBe(200_000_000);
		});

		it("returns null when the plan tier is missing or blank", () => {
			expect(derive({ provider: "codex", planTier: null })).toBeNull();
			expect(derive({ provider: "codex", planTier: "   " })).toBeNull();
		});
	});
});
