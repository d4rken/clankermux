import { describe, expect, it } from "bun:test";
import {
	CLAUDE_MODEL_IDS,
	getModelDisplayName,
	getModelShortName,
	isValidModelId,
	LATEST_OPUS_MODEL,
} from "./models";

describe("Claude Opus 4.8 registration", () => {
	it("exposes the claude-opus-4-8 model id", () => {
		expect(CLAUDE_MODEL_IDS.OPUS_4_8).toBe("claude-opus-4-8");
	});

	it("is the latest opus model", () => {
		expect(LATEST_OPUS_MODEL).toBe("claude-opus-4-8");
	});

	it("has a human-readable display name", () => {
		expect(getModelDisplayName("claude-opus-4-8")).toBe("Claude Opus 4.8");
	});

	it("has a short name for UI color mapping", () => {
		expect(getModelShortName("claude-opus-4-8")).toBe("claude-opus-4.8");
	});

	it("is recognized as a valid model id", () => {
		expect(isValidModelId("claude-opus-4-8")).toBe(true);
	});
});
