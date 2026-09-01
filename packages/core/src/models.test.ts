import { describe, expect, it } from "bun:test";
import {
	CLAUDE_MODEL_IDS,
	getModelDisplayName,
	getModelShortName,
	isValidModelId,
	LATEST_FABLE_MODEL,
	LATEST_OPUS_MODEL,
	LATEST_SONNET_MODEL,
} from "./models";

describe("Claude Sonnet 5 registration", () => {
	it("exposes the claude-sonnet-5 model id", () => {
		expect(CLAUDE_MODEL_IDS.SONNET_5).toBe("claude-sonnet-5");
	});

	it("is the latest sonnet model", () => {
		expect(LATEST_SONNET_MODEL).toBe("claude-sonnet-5");
	});

	it("has a human-readable display name", () => {
		expect(getModelDisplayName("claude-sonnet-5")).toBe("Claude Sonnet 5");
	});

	it("has a short name for UI color mapping", () => {
		expect(getModelShortName("claude-sonnet-5")).toBe("claude-sonnet-5");
	});

	it("is recognized as a valid model id", () => {
		expect(isValidModelId("claude-sonnet-5")).toBe(true);
	});
});

describe("Claude Opus 5 registration", () => {
	it("exposes the claude-opus-5 model id", () => {
		expect(CLAUDE_MODEL_IDS.OPUS_5).toBe("claude-opus-5");
	});

	it("is the latest opus model", () => {
		expect(LATEST_OPUS_MODEL).toBe("claude-opus-5");
	});

	it("has a human-readable display name", () => {
		expect(getModelDisplayName("claude-opus-5")).toBe("Claude Opus 5");
	});

	it("has a short name for UI color mapping", () => {
		// No dot-decimal — matches the Sonnet 5 / Fable 5 precedent.
		expect(getModelShortName("claude-opus-5")).toBe("claude-opus-5");
	});

	it("is recognized as a valid model id", () => {
		expect(isValidModelId("claude-opus-5")).toBe(true);
	});
});

describe("Claude Opus 4.8 registration", () => {
	it("exposes the claude-opus-4-8 model id", () => {
		expect(CLAUDE_MODEL_IDS.OPUS_4_8).toBe("claude-opus-4-8");
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

describe("Claude Fable 5 registration", () => {
	it("exposes the claude-fable-5 model id", () => {
		expect(CLAUDE_MODEL_IDS.FABLE_5).toBe("claude-fable-5");
	});

	it("has a human-readable display name", () => {
		expect(getModelDisplayName("claude-fable-5")).toBe("Claude Fable 5");
	});

	it("has a short name for UI color mapping", () => {
		expect(getModelShortName("claude-fable-5")).toBe("claude-fable-5");
	});

	it("is recognized as a valid model id", () => {
		expect(isValidModelId("claude-fable-5")).toBe(true);
	});
});

describe("Claude Mythos 5 registration", () => {
	it("exposes the claude-mythos-5 model id", () => {
		expect(CLAUDE_MODEL_IDS.MYTHOS_5).toBe("claude-mythos-5");
	});

	it("has a human-readable display name", () => {
		expect(getModelDisplayName("claude-mythos-5")).toBe("Claude Mythos 5");
	});

	it("is recognized as a valid model id", () => {
		expect(isValidModelId("claude-mythos-5")).toBe(true);
	});
});

describe("Claude Fable 5.1 registration", () => {
	it("exposes the claude-fable-5-1 model id", () => {
		expect(CLAUDE_MODEL_IDS.FABLE_5_1).toBe("claude-fable-5-1");
	});

	it("is the latest fable model", () => {
		expect(LATEST_FABLE_MODEL).toBe("claude-fable-5-1");
	});

	it("has a human-readable display name", () => {
		expect(getModelDisplayName("claude-fable-5-1")).toBe("Claude Fable 5.1");
	});

	it("has a short name for UI color mapping", () => {
		// Dot-decimal for an x.y version — matches the Opus 4.8 precedent.
		expect(getModelShortName("claude-fable-5-1")).toBe("claude-fable-5.1");
	});

	it("is recognized as a valid model id", () => {
		expect(isValidModelId("claude-fable-5-1")).toBe(true);
	});
});

describe("Claude Mythos 5.1 registration", () => {
	it("exposes the claude-mythos-5-1 model id", () => {
		expect(CLAUDE_MODEL_IDS.MYTHOS_5_1).toBe("claude-mythos-5-1");
	});

	it("has a human-readable display name", () => {
		expect(getModelDisplayName("claude-mythos-5-1")).toBe("Claude Mythos 5.1");
	});

	it("has a short name for UI color mapping", () => {
		expect(getModelShortName("claude-mythos-5-1")).toBe("claude-mythos-5.1");
	});

	it("is recognized as a valid model id", () => {
		expect(isValidModelId("claude-mythos-5-1")).toBe(true);
	});
});
