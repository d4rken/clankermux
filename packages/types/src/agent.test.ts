import { describe, expect, it } from "bun:test";
import { COMMON_MODELS } from "./agent";

describe("COMMON_MODELS", () => {
	const models = COMMON_MODELS as readonly string[];

	it("includes Claude Opus 4.8", () => {
		expect(models).toContain("claude-opus-4-8");
	});

	it("includes Claude Opus 4.7", () => {
		expect(models).toContain("claude-opus-4-7");
	});
});
