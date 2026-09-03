/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { describe, expect, it } from "bun:test";
import {
	getSupportedReasoningEfforts,
	resolveReasoningEffort,
	validateReasoningEffort,
} from "./reasoning";

describe("reasoning effort support", () => {
	it("exposes supported Claude and Codex effort matrices", () => {
		expect(getSupportedReasoningEfforts("claude-sonnet-4-6")).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(getSupportedReasoningEfforts("claude-opus-5")).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(getSupportedReasoningEfforts("claude-haiku-4-5")).toEqual([
			"low",
			"medium",
		]);
		expect(getSupportedReasoningEfforts("claude-fable-5")).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(getSupportedReasoningEfforts("claude-mythos-5")).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(getSupportedReasoningEfforts("gpt-5.3-codex")).toEqual([
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
		expect(getSupportedReasoningEfforts("gpt-5.5")).toEqual([
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
		expect(getSupportedReasoningEfforts("gpt-5.4-mini")).toEqual([
			"low",
			"medium",
		]);
		// GPT-6 drops `minimal` and adds `max`; the generation prefix covers
		// later tiers and dated variants without a table edit.
		expect(getSupportedReasoningEfforts("gpt-6-astra")).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(getSupportedReasoningEfforts("gpt-6-astra-2026-09-03")).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	it("keeps max on GPT-6 and downgrades minimal to its floor", () => {
		expect(
			validateReasoningEffort("max", {
				sourceModel: "claude-fable-5-1",
				targetModel: "gpt-6-astra",
			}),
		).toBe("max");
		expect(
			validateReasoningEffort("minimal", {
				sourceModel: "gpt-6-astra",
				targetModel: "gpt-6-astra",
			}),
		).toBe("low");
	});

	it("accepts valid reasoning effort for supported Claude and Codex models", () => {
		expect(
			validateReasoningEffort("xhigh", {
				sourceModel: "claude-sonnet-4-6",
				targetModel: "gpt-5.3-codex",
			}),
		).toBe("xhigh");
	});

	it("downgrades unsupported effort to nearest lower supported level", () => {
		const resolved = resolveReasoningEffort("xhigh", {
			sourceModel: "claude-sonnet-4-6",
			targetModel: "gpt-5.4-mini",
		});
		expect(resolved.effort).toBe("medium");
		expect(resolved.downgrades).toEqual([
			{
				model: "gpt-5.4-mini",
				from: "xhigh",
				to: "medium",
			},
		]);
	});

	it("rejects unsupported reasoning effort values", () => {
		expect(() =>
			validateReasoningEffort("extreme", {
				sourceModel: "claude-sonnet-4-6",
				targetModel: "gpt-5.3-codex",
			}),
		).toThrow(
			"reasoning.effort must be one of: minimal, low, medium, high, xhigh, max",
		);
	});

	it("passes through effort unchanged when target model is unknown", () => {
		const resolved = resolveReasoningEffort("xhigh", {
			sourceModel: "claude-sonnet-4-6",
			targetModel: "unknown-model-xyz",
		});
		expect(resolved.effort).toBe("xhigh");
		expect(resolved.downgrades).toEqual([]);
	});

	it("passes through effort unchanged when source model is unknown", () => {
		const resolved = resolveReasoningEffort("xhigh", {
			sourceModel: "claude-future-model-99",
			targetModel: "gpt-5.3-codex",
		});
		expect(resolved.effort).toBe("xhigh");
		expect(resolved.downgrades).toEqual([]);
	});
});
