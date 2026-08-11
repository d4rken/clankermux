import { describe, expect, it } from "bun:test";
import {
	DEFAULT_CODEX_MODEL_BY_FAMILY,
	DEFAULT_QWEN_MODEL_BY_FAMILY,
	LATEST_FABLE_MODEL,
	LATEST_OPUS_MODEL,
} from "@clankermux/core";
import {
	buildModelMappingsPayload,
	formatMappingValue,
	getPlaceholderModels,
	parseMappingValue,
} from "./model-mappings";

describe("getPlaceholderModels", () => {
	it("shows the Codex family defaults for a codex account", () => {
		expect(getPlaceholderModels("codex")).toEqual(
			DEFAULT_CODEX_MODEL_BY_FAMILY,
		);
	});

	it("shows the Qwen family defaults for a qwen account", () => {
		expect(getPlaceholderModels("qwen")).toEqual(DEFAULT_QWEN_MODEL_BY_FAMILY);
		expect(getPlaceholderModels("qwen").fable).toBe("coder-model");
	});

	it("falls back to the latest Claude ids for an unknown provider", () => {
		const placeholders = getPlaceholderModels("openai-compatible");
		expect(placeholders.opus).toBe(LATEST_OPUS_MODEL);
		expect(placeholders.fable).toBe(LATEST_FABLE_MODEL);
	});

	it("falls back to the latest Claude ids when the provider is absent", () => {
		expect(getPlaceholderModels(null).opus).toBe(LATEST_OPUS_MODEL);
		expect(getPlaceholderModels(undefined).opus).toBe(LATEST_OPUS_MODEL);
	});
});

describe("formatMappingValue / parseMappingValue", () => {
	it("round-trips a single model", () => {
		expect(formatMappingValue("model-a")).toBe("model-a");
		expect(parseMappingValue("model-a")).toBe("model-a");
	});

	it("round-trips an ordered list", () => {
		expect(formatMappingValue(["model-a", "model-b"])).toBe("model-a, model-b");
		expect(parseMappingValue("model-a, model-b")).toEqual([
			"model-a",
			"model-b",
		]);
	});

	it("treats a blank or separator-only field as no mapping", () => {
		expect(formatMappingValue(undefined)).toBe("");
		expect(parseMappingValue("")).toBeNull();
		expect(parseMappingValue("  ,  ")).toBeNull();
	});
});

describe("buildModelMappingsPayload", () => {
	const blank = { opus: "", sonnet: "", haiku: "", fable: "" };

	it("keeps exact model-id keys when a family field is edited", () => {
		// The update endpoint replaces model_mappings wholesale, so a dropped key
		// is a silent deletion.
		const payload = buildModelMappingsPayload(
			{ "claude-fable-5": "special", opus: "x" },
			{ ...blank, opus: "y" },
		);
		expect(payload).toEqual({ "claude-fable-5": "special", opus: "y" });
	});

	it("drops a family whose field was cleared, keeping unknown keys", () => {
		const payload = buildModelMappingsPayload(
			{ "claude-fable-5": "special", opus: "x" },
			blank,
		);
		expect(payload).toEqual({ "claude-fable-5": "special" });
	});

	it("writes list values as arrays", () => {
		const payload = buildModelMappingsPayload(null, {
			...blank,
			sonnet: "a, b",
		});
		expect(payload).toEqual({ sonnet: ["a", "b"] });
	});

	it("returns an empty payload when nothing is configured", () => {
		expect(buildModelMappingsPayload(null, blank)).toEqual({});
		expect(buildModelMappingsPayload(undefined, blank)).toEqual({});
	});

	it("takes the field value over the stored one for a family key", () => {
		const payload = buildModelMappingsPayload(
			{ fable: ["old-a", "old-b"] },
			{ ...blank, fable: "new-a" },
		);
		expect(payload).toEqual({ fable: "new-a" });
	});

	it("omits unknown keys whose stored value the endpoint would reject", () => {
		// Legacy/hand-edited rows can hold values the core resolver skips; the
		// update endpoint 400s the entire save on any one of them.
		const payload = buildModelMappingsPayload(
			{
				"claude-null": null,
				"claude-number": 42,
				"claude-empty-array": [],
				"claude-blank-item": [""],
				"claude-blank-string": "   ",
				"claude-fable-5": "special",
			},
			{ ...blank, opus: "y" },
		);
		expect(payload).toEqual({ "claude-fable-5": "special", opus: "y" });
	});

	it("keeps valid unknown keys unchanged across a family-field edit", () => {
		const payload = buildModelMappingsPayload(
			{
				"claude-fable-5": "special",
				"claude-opus-4-1": ["first", "second"],
				sonnet: "old",
			},
			{ ...blank, sonnet: "new" },
		);
		expect(payload).toEqual({
			"claude-fable-5": "special",
			"claude-opus-4-1": ["first", "second"],
			sonnet: "new",
		});
	});
});
