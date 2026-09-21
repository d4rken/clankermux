/**
 * Accepted swaps: the pairs an operator has decided not to fail over.
 *
 * The matching has to be as forgiving as detection is, and no more. A rule that
 * silently missed the dated spelling of the model it names would leave
 * enforcement firing on exactly the swap the operator just approved; a rule that
 * matched more than it says would disable the feature by accident.
 */
import { describe, expect, it } from "bun:test";
import { parseModelSubstitutionExceptions } from "@clankermux/types";
import { isSubstitutionExcepted } from "../model-substitution";

const except = (...entries: string[]) =>
	parseModelSubstitutionExceptions(entries);

describe("isSubstitutionExcepted", () => {
	it("is false with no exceptions configured", () => {
		expect(isSubstitutionExcepted("gpt-6-astra", "gpt-5.6-luna", [])).toBe(
			false,
		);
	});

	it("matches the exact pair it was written for", () => {
		const list = except("gpt-5.6-luna>gpt-6-luna");
		expect(isSubstitutionExcepted("gpt-5.6-luna", "gpt-6-luna", list)).toBe(
			true,
		);
	});

	it("is directional: the reverse swap is a different decision", () => {
		const list = except("gpt-5.6-luna>gpt-6-luna");
		expect(isSubstitutionExcepted("gpt-6-luna", "gpt-5.6-luna", list)).toBe(
			false,
		);
	});

	it("does not cover an unrelated pair on the same account", () => {
		const list = except("gpt-5.6-luna>gpt-6-luna");
		expect(isSubstitutionExcepted("gpt-6-astra", "gpt-5.6-luna", list)).toBe(
			false,
		);
	});

	it("ignores case and surrounding whitespace on both sides", () => {
		const list = except("  GPT-5.6-Luna > GPT-6-Luna  ");
		expect(isSubstitutionExcepted("gpt-5.6-luna", "gpt-6-luna", list)).toBe(
			true,
		);
	});

	// The rule is written once, against the alias. Both dated spellings of the
	// same model must still be covered, or enforcement fires on the swap the
	// operator approved as soon as the provider names a snapshot.
	it("covers the compact dated snapshot of a model named by its alias", () => {
		const list = except("claude-haiku-4-5>claude-opus-5");
		expect(
			isSubstitutionExcepted(
				"claude-haiku-4-5-20251001",
				"claude-opus-5",
				list,
			),
		).toBe(true);
	});

	it("covers the hyphenated dated snapshot too", () => {
		const list = except("claude-haiku-4-5>claude-opus-5");
		expect(
			isSubstitutionExcepted(
				"claude-haiku-4-5-2025-10-01",
				"claude-opus-5",
				list,
			),
		).toBe(true);
	});

	it("covers a vendor-prefixed spelling of the same model", () => {
		const list = except("claude-haiku-4-5>claude-opus-5");
		expect(
			isSubstitutionExcepted(
				"anthropic/claude-haiku-4-5",
				"anthropic/claude-opus-5",
				list,
			),
		).toBe(true);
	});

	it("does not equate two Ollama tags of one family", () => {
		const list = except("llama3:8b>llama3:70b");
		expect(isSubstitutionExcepted("llama3:8b", "llama3:70b", list)).toBe(true);
		expect(isSubstitutionExcepted("llama3:8b", "llama3:13b", list)).toBe(false);
	});

	describe("wildcards", () => {
		it("accepts anything served for one sent model", () => {
			const list = except("gpt-6-astra>*");
			expect(isSubstitutionExcepted("gpt-6-astra", "gpt-5.6-luna", list)).toBe(
				true,
			);
			expect(isSubstitutionExcepted("gpt-6-astra", "gpt-6-luna", list)).toBe(
				true,
			);
			expect(isSubstitutionExcepted("gpt-5.6-terra", "gpt-6-luna", list)).toBe(
				false,
			);
		});

		it("accepts one served model whatever was sent", () => {
			const list = except("*>gpt-6-luna");
			expect(isSubstitutionExcepted("gpt-5.6-luna", "gpt-6-luna", list)).toBe(
				true,
			);
			expect(isSubstitutionExcepted("gpt-6-astra", "gpt-6-luna", list)).toBe(
				true,
			);
			expect(isSubstitutionExcepted("gpt-6-astra", "gpt-5.6-luna", list)).toBe(
				false,
			);
		});

		// `*>*` would leave the mode reading "enforce" while enforcing nothing.
		// Observe mode is that state, and it says so on the settings page.
		it("refuses to accept everything", () => {
			expect(except("*>*")).toEqual([]);
			expect(
				isSubstitutionExcepted("gpt-6-astra", "gpt-5.6-luna", except("*>*")),
			).toBe(false);
		});
	});

	describe("parsing", () => {
		it("drops entries with no separator or an empty side", () => {
			expect(except("gpt-6-astra", ">gpt-6-luna", "gpt-6-astra>", "")).toEqual(
				[],
			);
		});

		it("drops an entry with more than one separator", () => {
			expect(except("a>b>c")).toEqual([]);
		});

		it("deduplicates entries that normalise to the same rule", () => {
			expect(
				except("gpt-5.6-luna>gpt-6-luna", " GPT-5.6-LUNA>gpt-6-luna "),
			).toHaveLength(1);
		});
	});
});
