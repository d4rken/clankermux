import { describe, expect, it } from "bun:test";
import { MODEL_SUBSTITUTION_SUPPRESSION_REASON } from "../constants";

describe("MODEL_SUBSTITUTION_SUPPRESSION_REASON", () => {
	it("is the value already written to stored rows", () => {
		// Changing it silently re-partitions existing suppression and attempt
		// history, which is why it is pinned rather than merely exported.
		expect(MODEL_SUBSTITUTION_SUPPRESSION_REASON).toBe(
			"upstream_model_substituted",
		);
	});

	it("carries no character that could close a SQL string literal", () => {
		// The client-request reader interpolates it into SQL rather than binding
		// it, because a bound `?` in that shared column list would shift every
		// other positional parameter at both of its call sites.
		expect(MODEL_SUBSTITUTION_SUPPRESSION_REASON).toMatch(/^[a-z_]+$/);
	});
});
