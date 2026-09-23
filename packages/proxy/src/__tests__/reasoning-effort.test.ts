import { describe, expect, it } from "bun:test";
import {
	clampOutputConfigEffort,
	parseReasoningEffort,
	stripEffortControls,
} from "../reasoning-effort";

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

it("treats the last system-message effort update as the current effort", () => {
	const update = (effort: unknown) => ({
		role: "system",
		output_config: { effort },
	});
	const messages = [
		{ role: "user", content: "hi" },
		update("low"),
		{ role: "user", content: "again", output_config: { effort: "xhigh" } },
		update("high"),
		update(""),
	];
	const thinking = { type: "enabled", budget_tokens: 100 };
	expect(
		parseReasoningEffort({
			messages,
			output_config: { effort: "max" },
			thinking,
		}),
	).toBe("high");
	expect(parseReasoningEffort({ messages, thinking })).toBe("high");
	expect(parseReasoningEffort({ messages, reasoning_effort: "medium" })).toBe(
		"medium",
	);
	expect(
		parseReasoningEffort({ messages, reasoning: { effort: "minimal" } }),
	).toBe("minimal");
	expect(
		parseReasoningEffort({
			messages: [update(""), update(3)],
			output_config: { effort: "max" },
		}),
	).toBe("max");
});

describe("stripEffortControls", () => {
	it("removes every effort control parseReasoningEffort reads", () => {
		const body: Record<string, unknown> = {
			model: "m",
			reasoning: { effort: "high", summary: "auto" },
			reasoning_effort: "high",
			thinking: { type: "adaptive" },
			output_config: { effort: "high", format: { type: "json_schema" } },
			messages: [
				{ role: "user", content: "hi" },
				{ role: "system", output_config: { effort: "max" } },
			],
		};
		stripEffortControls(body);
		expect(body).toEqual({
			model: "m",
			reasoning: { summary: "auto" },
			output_config: { format: { type: "json_schema" } },
			messages: [{ role: "user", content: "hi" }, { role: "system" }],
		});
		expect(parseReasoningEffort(body)).toBeNull();
	});
	it("keeps a thinking budget and reasoning fields that are not the effort", () => {
		const reasoning = {
			effort: "high",
			summary: "auto",
			exclude: false,
			max_tokens: 512,
			enabled: true,
		};
		const body: Record<string, unknown> = {
			reasoning,
			thinking: { type: "enabled", budget_tokens: 2048 },
		};
		stripEffortControls(body);
		expect(body).toEqual({
			reasoning: {
				summary: "auto",
				exclude: false,
				max_tokens: 512,
				enabled: true,
			},
			thinking: { type: "enabled", budget_tokens: 2048 },
		});
		expect(reasoning.effort).toBe("high");
	});
	it("drops a reasoning object that held only the effort", () => {
		const body: Record<string, unknown> = { reasoning: { effort: "low" } };
		stripEffortControls(body);
		expect(body).toEqual({});
	});
	it("removes adaptive thinking, which means nothing without an effort", () => {
		const body: Record<string, unknown> = {
			thinking: { type: "adaptive" },
			output_config: { effort: "high" },
		};
		stripEffortControls(body);
		expect(body).toEqual({});
	});
	it("removes system-message effort updates without editing the shared originals", () => {
		const user = { role: "user", content: "hi" };
		const update = {
			role: "system",
			content: "switch",
			output_config: { effort: "max", format: { type: "text" } },
		};
		const bare = { role: "system", output_config: { effort: "low" } };
		const messages = [user, update, bare];
		const body: Record<string, unknown> = { messages };
		stripEffortControls(body);
		expect(body.messages).toEqual([
			user,
			{
				role: "system",
				content: "switch",
				output_config: { format: { type: "text" } },
			},
			{ role: "system" },
		]);
		expect(body.messages).not.toBe(messages);
		expect((body.messages as unknown[])[0]).toBe(user);
		expect(messages).toEqual([user, update, bare]);
		expect(update.output_config).toEqual({
			effort: "max",
			format: { type: "text" },
		});
		expect(bare.output_config).toEqual({ effort: "low" });
	});
	it("leaves effort on a non-system message and keeps the array when nothing changed", () => {
		const messages = [
			{ role: "user", content: "hi", output_config: { effort: "high" } },
		];
		const body: Record<string, unknown> = { messages };
		stripEffortControls(body);
		expect(body.messages).toBe(messages);
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

describe("clampOutputConfigEffort", () => {
	const toMedium = (effort: string) => (effort === "high" ? "medium" : effort);
	it("rewrites the request's effort and each system-message update", () => {
		const shared = { effort: "high", format: { type: "text" } };
		const update = { role: "system", output_config: { effort: "high" } };
		const low = { role: "system", output_config: { effort: "low" } };
		const messages = [update, low];
		const body: Record<string, unknown> = {
			thinking: { type: "adaptive" },
			reasoning: { effort: "high" },
			output_config: shared,
			messages,
		};
		clampOutputConfigEffort(body, toMedium);
		expect(body).toEqual({
			thinking: { type: "adaptive" },
			reasoning: { effort: "high" },
			output_config: { effort: "medium", format: { type: "text" } },
			messages: [{ role: "system", output_config: { effort: "medium" } }, low],
		});
		expect((body.messages as unknown[])[1]).toBe(low);
		expect(shared.effort).toBe("high");
		expect(update.output_config.effort).toBe("high");
		expect(messages).toEqual([update, low]);
	});
	it("keeps objects whose effort is already acceptable", () => {
		const config = { effort: "low" };
		const messages = [{ role: "system", output_config: { effort: "max" } }];
		const body: Record<string, unknown> = { output_config: config, messages };
		clampOutputConfigEffort(body, toMedium);
		expect(body.output_config).toBe(config);
		expect(body.messages).toBe(messages);
	});
});
