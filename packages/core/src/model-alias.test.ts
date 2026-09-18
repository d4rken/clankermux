import { describe, expect, it } from "bun:test";
import { isModelAliasId, validateModelAlias } from "./model-alias";

const alias = () => ({
	id: "alias:good-model",
	displayName: "Good model",
	targets: [
		{ model: "claude-fable-5", accountIds: null },
		{ model: "gpt-6-astra", accountIds: ["account-a"] },
	],
	revision: 0,
});

describe("model alias validation", () => {
	it("preserves ordered concrete targets and copies mutable input", () => {
		const input = alias();
		const result = validateModelAlias(input);
		expect(result).toEqual(input);
		input.targets.reverse();
		expect(result.targets[0]?.model).toBe("claude-fable-5");
		expect(isModelAliasId(result.id)).toBe(true);
	});
	it("reserves alias IDs and rejects nested aliases, duplicates, and empty target pools", () => {
		for (const bad of [
			{ ...alias(), id: "good-model" },
			{ ...alias(), id: "alias:" },
			{ ...alias(), targets: [] },
			{ ...alias(), targets: [{ model: "alias:fast", accountIds: null }] },
			{ ...alias(), targets: [alias().targets[0], alias().targets[0]] },
			{ ...alias(), targets: [{ model: "gpt-6-astra", accountIds: [] }] },
			{
				...alias(),
				targets: [{ model: "gpt-6-astra", accountIds: ["a", "a"] }],
			},
			{ ...alias(), revision: -1 },
			{ ...alias(), revision: 1.5 },
		])
			expect(() => validateModelAlias(bad)).toThrow();
	});
});
