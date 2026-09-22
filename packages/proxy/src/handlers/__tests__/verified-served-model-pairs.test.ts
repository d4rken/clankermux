import { describe, expect, it } from "bun:test";
import {
	isModelSubstitution,
	isSubstitutionExcepted,
} from "../model-substitution";

/**
 * The provider-scoped table of request→served pairs verified against a live
 * upstream, and the three things it must not become: a rule that fires without
 * a provider, a rule that fires on the wrong provider, or a suffix rule.
 */
describe("verified served-model pairs", () => {
	describe("grok-subscription", () => {
		it("accepts the grok-4.6 → grok-4.6-build rename", () => {
			expect(
				isModelSubstitution("grok-4.6", "grok-4.6-build", "grok-subscription"),
			).toBe(false);
		});

		it("accepts the pair in either direction", () => {
			// The table states an equivalence, not a direction: both ids name one
			// model, so a request for either answered by either is not a swap.
			expect(
				isModelSubstitution("grok-4.6-build", "grok-4.6", "grok-subscription"),
			).toBe(false);
		});

		it("normalises case and surrounding space before matching the pair", () => {
			expect(
				isModelSubstitution(
					" GROK-4.6 ",
					"Grok-4.6-Build",
					"grok-subscription",
				),
			).toBe(false);
		});

		it("still reports a swap between two models the catalogue publishes separately", () => {
			// `grok-4.7` and `grok-4.7-build-fast` are two entries on /v1/models. A
			// suffix rule would equate them and disable detection for the pair.
			expect(
				isModelSubstitution(
					"grok-4.7",
					"grok-4.7-build-fast",
					"grok-subscription",
				),
			).toBe(true);
			expect(
				isModelSubstitution("grok-4.7", "grok-4.7-build", "grok-subscription"),
			).toBe(true);
		});

		it("does not extend the pair to a different model", () => {
			expect(
				isModelSubstitution("grok-4.6", "grok-4.5-build", "grok-subscription"),
			).toBe(true);
			expect(
				isModelSubstitution("grok-4.6-build", "grok-4.7", "grok-subscription"),
			).toBe(true);
		});
	});

	describe("scope", () => {
		it("is unreachable without a provider", () => {
			expect(isModelSubstitution("grok-4.6", "grok-4.6-build")).toBe(true);
		});

		it("is unreachable for a provider with no verified pairs", () => {
			// Including the metered API-key `grok` provider: a different upstream,
			// never observed renaming anything.
			expect(isModelSubstitution("grok-4.6", "grok-4.6-build", "grok")).toBe(
				true,
			);
			expect(
				isModelSubstitution("grok-4.6", "grok-4.6-build", "anthropic"),
			).toBe(true);
			expect(isModelSubstitution("grok-4.6", "grok-4.6-build", "")).toBe(true);
		});
	});

	describe("exception matching stays consistent with detection", () => {
		const list = [{ sent: "grok-4.6", served: "grok-4.7" }];

		it("covers the paired spelling of an exception's model", () => {
			expect(
				isSubstitutionExcepted(
					"grok-4.6-build",
					"grok-4.7",
					list,
					"grok-subscription",
				),
			).toBe(true);
		});

		it("does not cover it without the provider", () => {
			expect(isSubstitutionExcepted("grok-4.6-build", "grok-4.7", list)).toBe(
				false,
			);
		});
	});
});
