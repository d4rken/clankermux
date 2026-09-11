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
	target_kind: "requested",
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
	it("sends the requested model unchanged without a literal rule", () => {
		// No rule at all, and the retired-and-normalized "requested" action, both
		// resolve to identity for every provider: nothing implicit rewrites a model.
		for (const model of ["claude-fable-5-1", "claude-sonnet-5", "gpt-6-astra"])
			for (const winning of [null, rule({ target_kind: "requested" })])
				expect(resolveRoutingTarget(winning, model)).toEqual({
					upstreamModel: model,
					targetSource: winning ? "requested" : "identity",
				});
	});
	it("changes the model only through a literal rule", () => {
		expect(
			resolveRoutingTarget(
				rule({ target_kind: "literal", target_model: "gpt-6-astra" }),
				"claude-fable-5-1",
			),
		).toEqual({ upstreamModel: "gpt-6-astra", targetSource: "literal" });
		expect(() =>
			resolveRoutingTarget(rule({ target_kind: "literal" }), "claude-sonnet-5"),
		).toThrow("Literal route requires a target model");
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
		// The retired "default" action is normalized on the way through, so it
		// cannot be reintroduced by a client that still sends it. The validator
		// runs on both the read and the write path.
		expect(validateRoutingRule(rule({ target_kind: "default" }))).toEqual(
			rule({ target_kind: "requested" }),
		);
		expect(() =>
			validateRoutingRule(
				rule({ target_kind: "default", target_model: "gpt-6-astra" }),
			),
		).toThrow("Target model");
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

it("never rewrites a model id, including the retired Devin alias", () => {
	for (const model of [
		"claude-opus-4-6",
		"claude-sonnet-4-5",
		"claude-haiku-4-5",
		"claude-fable-5",
		"claude-mythos-5",
		"swe-2",
		"swe-2-high",
		"gpt-5.6-terra",
		"qwen3-coder-plus",
	])
		expect(resolveRoutingTarget(null, model)).toEqual({
			upstreamModel: model,
			targetSource: "identity",
		});
	expect(
		resolveRoutingTarget(
			rule({ target_kind: "literal", target_model: "swe-1.6" }),
			"claude-opus-4-6",
		).upstreamModel,
	).toBe("swe-1.6");
});
