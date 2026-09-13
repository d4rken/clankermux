/** Routing policy is evaluated once; targets are resolved separately for each destination. */
export type RoutingModelFamily =
	| "anthropic:opus"
	| "anthropic:sonnet"
	| "anthropic:haiku"
	| "anthropic:fable";
export interface RoutingRule {
	id: string;
	name: string;
	enabled: boolean;
	position: number;
	match_api_key_id: string | null;
	match_model_kind: "any" | "exact" | "family";
	match_model_value: string | null;
	pool_kind: "inherit" | "provider" | "accounts";
	pool_provider: string | null;
	pool_account_ids: string[] | null;
	target_kind: "default" | "literal" | "requested";
	target_model: string | null;
}
export type ModelPermissionCompleteness =
	| "unknown"
	| "known-complete"
	| "known-empty";
export interface ModelPermissionSet {
	completeness: ModelPermissionCompleteness;
	discovered_ids: string[];
	manual_ids: string[];
}
export interface AccountModelPermissions extends ModelPermissionSet {
	account_id: string;
	scope: string;
	generation: number;
	last_success_at: number | null;
	last_attempt_at: number | null;
	last_error: string | null;
}
export interface ResolvedRoutingTarget {
	upstreamModel: string;
	targetSource: "literal" | "requested" | "provider_default" | "identity";
}
export interface RoutingAttempt {
	id: string;
	request_id: string;
	rule_id: string | null;
	route_snapshot: string | null;
	account_id: string | null;
	provider: string | null;
	requested_model: string;
	resolved_model: string | null;
	outgoing_model: string | null;
	reported_model: string | null;
	kind: "upstream_send" | "local_reject" | "local_success";
	started_at: number;
	finished_at: number | null;
	status: number | null;
	error: string | null;
	/**
	 * What this dispatch did to the client's reasoning effort — see
	 * {@link ReasoningEffortAdaptation} for the absent/unchanged/adapted
	 * contract. Per attempt, because two attempts of one request can target
	 * backends with different effort vocabularies. NULL on every attempt that
	 * serialized no effort, and on every row written before the columns existed.
	 */
	reasoning_effort_requested: string | null;
	reasoning_effort_effective: string | null;
	reasoning_effort_reason: string | null;
}
