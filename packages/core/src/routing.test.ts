import { describe, expect, it } from "bun:test";
import type { RoutingRule } from "@clankermux/types";
import {
	getRoutingModelFamily,
	isModelPermitted,
	matchRoutingRule,
	resolveRoutingTarget,
	validateRoutingRule,
} from "./routing";

const rule = (patch: Partial<RoutingRule> = {}): RoutingRule => ({
	id: "r",
	name: "Experiment",
	enabled: true,
	position: 10,
	match_api_key_id: null,
	match_model_kind: "any",
	match_model_value: null,
	pool_kind: "inherit",
	pool_provider: null,
	pool_account_ids: null,
	target_kind: "default",
	target_model: null,
	...patch,
});

describe("routing policy", () => {
	it("recognizes Claude families without treating arbitrary model substrings as Claude", () => {
		expect(getRoutingModelFamily("claude-fable-5-1")).toBe("anthropic:fable");
		expect(getRoutingModelFamily("claude-mythos-5")).toBe("anthropic:fable");
		expect(getRoutingModelFamily("claude-sonnet-4-5-20250929")).toBe(
			"anthropic:sonnet",
		);
		for (const id of [
			"gpt-6-astra",
			"my-sonnet-model",
			"claude-sonnetish",
			"vendor/claude-sonnet-4-5",
			"opus",
		]) {
			expect(getRoutingModelFamily(id)).toBeNull();
		}
	});
	it("matches legacy Claude IDs and family rules without substring matching", () => {
		for (const id of [
			"claude-3-5-sonnet-20241022",
			"claude-3-7-sonnet",
			"claude-3-7-sonnet-latest",
		]) {
			expect(getRoutingModelFamily(id)).toBe("anthropic:sonnet");
			expect(
				matchRoutingRule(
					[
						rule({
							match_model_kind: "family",
							match_model_value: "anthropic:sonnet",
						}),
					],
					null,
					id,
				)?.id,
			).toBe("r");
		}
	});

	it("takes the first enabled match in position order and ANDs key/model predicates", () => {
		const rows = [
			rule({ id: "late", position: 20 }),
			rule({ id: "disabled", enabled: false, position: 0 }),
			rule({
				id: "keyed",
				position: 10,
				match_api_key_id: "key",
				match_model_kind: "exact",
				match_model_value: "claude-fable-5-1",
			}),
		];
		expect(matchRoutingRule(rows, "key", "claude-fable-5-1")?.id).toBe("keyed");
		expect(matchRoutingRule(rows, "other", "claude-fable-5-1")?.id).toBe(
			"late",
		);
		expect(matchRoutingRule(rows, "key", "claude-sonnet-5")?.id).toBe("late");
	});
	it("resolves provider defaults per candidate; literal/requested terminate resolution", () => {
		expect(resolveRoutingTarget(null, "codex", "claude-fable-5-1")).toEqual({
			upstreamModel: "gpt-6-astra",
			targetSource: "provider_default",
		});
		expect(
			resolveRoutingTarget(null, "qwen", "claude-sonnet-5").upstreamModel,
		).toBe("coder-model");
		expect(
			resolveRoutingTarget(null, "openrouter", "claude-sonnet-5").upstreamModel,
		).toBe("claude-sonnet-5");
		expect(
			resolveRoutingTarget(
				rule({ target_kind: "literal", target_model: "claude-sonnet-5" }),
				"codex",
				"claude-fable-5-1",
			).upstreamModel,
		).toBe("claude-sonnet-5");
		expect(
			resolveRoutingTarget(
				rule({ target_kind: "requested" }),
				"codex",
				"claude-fable-5-1",
			).upstreamModel,
		).toBe("claude-fable-5-1");
	});
	it("only asserts an unknown exact account/model pair through the winning literal account rule", () => {
		const assertion = rule({
			pool_kind: "accounts",
			pool_account_ids: ["a"],
			target_kind: "literal",
			target_model: "target",
		});
		expect(isModelPermitted(null, "a", "target", assertion)).toBe(true);
		expect(isModelPermitted(null, "b", "target", assertion)).toBe(false);
		expect(isModelPermitted(null, "a", "different", assertion)).toBe(false);
		for (const bad of [
			rule(),
			rule({ target_kind: "literal", target_model: "target" }),
			{ ...assertion, target_kind: "requested" as const },
			{ ...assertion, enabled: false },
		]) {
			expect(isModelPermitted(null, "a", "target", bad)).toBe(false);
		}
		const known = {
			completeness: "known-empty" as const,
			discovered_ids: [],
			manual_ids: [],
		};
		expect(isModelPermitted(known, "a", "target", assertion)).toBe(false);
		expect(
			isModelPermitted(
				{ ...known, manual_ids: ["target"] },
				"a",
				"target",
				null,
			),
		).toBe(true);
	});
	it("validates tagged fields, bounded strings, and explicit family names", () => {
		expect(validateRoutingRule(rule())).toEqual(rule());
		for (const bad of [
			rule({ pool_kind: "accounts", pool_account_ids: [] }),
			rule({ pool_kind: "provider" }),
			rule({ target_kind: "literal" }),
			rule({ target_model: "ignored" }),
			rule({ match_model_kind: "family", match_model_value: "sonnet" }),
			rule({ match_model_value: "ignored" }),
			rule({ position: 1.5 }),
			rule({ pool_account_ids: ["a"] }),
		]) {
			expect(() => validateRoutingRule(bad)).toThrow();
		}
	});
});

it("uses Devin defaults only for anchored Claude families and preserves explicit targets", () => {
	for (const id of [
		"claude-opus-4-6",
		"claude-sonnet-4-5",
		"claude-haiku-4-5",
		"claude-fable-5",
		"claude-mythos-5",
	])
		expect(resolveRoutingTarget(null, "devin", id)).toEqual({
			upstreamModel: "swe-2",
			targetSource: "provider_default",
		});
	for (const id of ["swe-2-high", "my-sonnet-model"])
		expect(resolveRoutingTarget(null, "devin", id).upstreamModel).toBe(id);
	expect(
		resolveRoutingTarget(
			rule({ target_kind: "requested" }),
			"devin",
			"claude-sonnet-4-5",
		).upstreamModel,
	).toBe("claude-sonnet-4-5");
	expect(
		resolveRoutingTarget(
			rule({ target_kind: "literal", target_model: "swe-1.6" }),
			"devin",
			"claude-opus-4-6",
		).upstreamModel,
	).toBe("swe-1.6");
});
