import { describe, expect, it } from "bun:test";
import { parseReasoningEffort, stripEffortControls } from "../reasoning-effort";

describe("parseReasoningEffort", () => {
	it("returns null for null/undefined/non-object bodies", () => {
		expect(parseReasoningEffort(null)).toBeNull();
		expect(parseReasoningEffort(undefined)).toBeNull();
		expect(parseReasoningEffort("a string")).toBeNull();
		expect(parseReasoningEffort(42)).toBeNull();
		expect(parseReasoningEffort([1, 2, 3])).toBeNull();
	});

	it("returns null when neither thinking nor reasoning is present", () => {
		expect(parseReasoningEffort({})).toBeNull();
		expect(
			parseReasoningEffort({ model: "claude-opus-4-8", messages: [] }),
		).toBeNull();
	});

	describe("anthropic thinking", () => {
		it("returns thinking:<budget> for enabled thinking with a numeric budget", () => {
			expect(
				parseReasoningEffort({
					thinking: { type: "enabled", budget_tokens: 4096 },
				}),
			).toBe("thinking:4096");
		});

		it("returns bare thinking when enabled without budget_tokens", () => {
			expect(parseReasoningEffort({ thinking: { type: "enabled" } })).toBe(
				"thinking",
			);
		});

		it("returns bare thinking when budget_tokens is not a finite number", () => {
			expect(
				parseReasoningEffort({
					thinking: { type: "enabled", budget_tokens: "lots" },
				}),
			).toBe("thinking");
			expect(
				parseReasoningEffort({
					thinking: { type: "enabled", budget_tokens: Number.NaN },
				}),
			).toBe("thinking");
		});

		it("returns null for disabled thinking", () => {
			expect(
				parseReasoningEffort({ thinking: { type: "disabled" } }),
			).toBeNull();
		});

		it("returns null for a non-object thinking value", () => {
			expect(parseReasoningEffort({ thinking: "enabled" })).toBeNull();
			expect(parseReasoningEffort({ thinking: null })).toBeNull();
		});
	});

	describe("openai reasoning", () => {
		it("returns the effort string as-is", () => {
			expect(parseReasoningEffort({ reasoning: { effort: "high" } })).toBe(
				"high",
			);
			expect(parseReasoningEffort({ reasoning: { effort: "minimal" } })).toBe(
				"minimal",
			);
		});

		it("accepts arbitrary effort strings beyond the narrow adapter type", () => {
			expect(parseReasoningEffort({ reasoning: { effort: "xhigh" } })).toBe(
				"xhigh",
			);
			expect(parseReasoningEffort({ reasoning: { effort: "max" } })).toBe(
				"max",
			);
		});

		it("returns null for non-string or missing effort", () => {
			expect(parseReasoningEffort({ reasoning: { effort: 3 } })).toBeNull();
			expect(parseReasoningEffort({ reasoning: {} })).toBeNull();
			expect(parseReasoningEffort({ reasoning: "high" })).toBeNull();
		});

		it("returns null for an empty effort string", () => {
			expect(parseReasoningEffort({ reasoning: { effort: "" } })).toBeNull();
		});
	});

	it("records adaptive thinking effort", () => {
		expect(
			parseReasoningEffort({
				thinking: { type: "adaptive" },
				output_config: { effort: "low" },
			}),
		).toBe("low");
	});

	it("prefers explicit Responses effort when both shapes are present", () => {
		expect(
			parseReasoningEffort({
				thinking: { type: "enabled", budget_tokens: 1024 },
				reasoning: { effort: "high" },
			}),
		).toBe("high");
	});
});

it("recognizes explicit chat effort and prioritizes explicit settings over thinking budget", () => {
	expect(parseReasoningEffort({ reasoning_effort: "max" })).toBe("max");
	expect(
		parseReasoningEffort({
			reasoning_effort: "",
			thinking: { type: "enabled", budget_tokens: 100 },
		}),
	).toBe("thinking:100");
	expect(parseReasoningEffort({ reasoning_effort: 3 })).toBeNull();
	expect(
		parseReasoningEffort({
			reasoning: { effort: "high" },
			reasoning_effort: "max",
			output_config: { effort: "low" },
		}),
	).toBe("high");
	expect(
		parseReasoningEffort({
			reasoning_effort: "max",
			thinking: { type: "enabled", budget_tokens: 100 },
		}),
	).toBe("max");
	expect(
		parseReasoningEffort({
			output_config: { effort: "max" },
			thinking: { type: "enabled", budget_tokens: 100 },
		}),
	).toBe("max");
});

describe("stripEffortControls", () => {
	it("removes every effort control parseReasoningEffort reads", () => {
		const body: Record<string, unknown> = {
			model: "m",
			reasoning: { effort: "high", summary: "auto" },
			reasoning_effort: "high",
			thinking: { type: "enabled", budget_tokens: 2048 },
			output_config: { effort: "high", format: { type: "json_schema" } },
		};
		stripEffortControls(body);
		expect(body).toEqual({
			model: "m",
			output_config: { format: { type: "json_schema" } },
		});
		expect(parseReasoningEffort(body)).toBeNull();
	});
	it("drops an output_config that held only the effort", () => {
		const body: Record<string, unknown> = { output_config: { effort: "max" } };
		stripEffortControls(body);
		expect(body).toEqual({});
	});
	it("replaces output_config instead of editing an object a parent body shares", () => {
		const shared = { effort: "high", format: { type: "text" } };
		const body: Record<string, unknown> = { output_config: shared };
		stripEffortControls(body);
		expect(shared).toEqual({ effort: "high", format: { type: "text" } });
		expect(body.output_config).not.toBe(shared);
	});
	it("leaves a body without effort controls alone", () => {
		const body: Record<string, unknown> = {
			model: "m",
			output_config: { format: { type: "text" } },
		};
		stripEffortControls(body);
		expect(body).toEqual({
			model: "m",
			output_config: { format: { type: "text" } },
		});
	});
});
