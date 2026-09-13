import type { RoutingRule } from "@clankermux/types";
export function newRoutingRule(position: number): RoutingRule {
	return {
		id: "",
		name: "",
		enabled: true,
		position,
		match_api_key_id: null,
		match_model_kind: "any",
		match_model_value: null,
		pool_kind: "inherit",
		pool_provider: null,
		pool_account_ids: null,
		target_kind: "requested",
		target_model: null,
	};
}
export function changeRulePool(
	rule: RoutingRule,
	kind: RoutingRule["pool_kind"],
): RoutingRule {
	return {
		...rule,
		pool_kind: kind,
		pool_provider: kind === "provider" ? "codex" : null,
		pool_account_ids: kind === "accounts" ? [] : null,
	};
}
export function changeRuleTarget(
	rule: RoutingRule,
	kind: RoutingRule["target_kind"],
): RoutingRule {
	return {
		...rule,
		target_kind: kind,
		target_model: kind === "literal" ? "" : null,
	};
}
