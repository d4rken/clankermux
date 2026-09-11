import type {
	ModelPermissionSet,
	ResolvedRoutingTarget,
	RoutingModelFamily,
	RoutingRule,
} from "@clankermux/types";

export const ROUTING_MODEL_FAMILIES: readonly RoutingModelFamily[] = [
	"anthropic:opus",
	"anthropic:sonnet",
	"anthropic:haiku",
	"anthropic:fable",
];

/** Anchored IDs only; quota classification deliberately uses a different helper. */
export function getRoutingModelFamily(
	model: string,
): RoutingModelFamily | null {
	const match =
		/^claude-(opus|sonnet|haiku|fable|mythos)-\d+(?:[.-]\d+)*(?:-latest)?$/i.exec(
			model,
		) ??
		/^claude-\d+(?:[.-]\d+)*-(opus|sonnet|haiku)(?:-\d+)?(?:-latest)?$/i.exec(
			model,
		);
	if (!match) return null;
	const family = match[1]?.toLowerCase();
	return `anthropic:${family === "mythos" ? "fable" : family}` as RoutingModelFamily;
}

export function matchRoutingRule(
	rules: readonly RoutingRule[],
	apiKeyId: string | null,
	requestedModel: string,
): RoutingRule | null {
	return (
		[...rules]
			.sort((a, b) => a.position - b.position)
			.find(
				(rule) =>
					rule.enabled &&
					(rule.match_api_key_id === null ||
						rule.match_api_key_id === apiKeyId) &&
					(rule.match_model_kind === "any" ||
						(rule.match_model_kind === "exact"
							? rule.match_model_value === requestedModel
							: rule.match_model_value ===
								getRoutingModelFamily(requestedModel))),
			) ?? null
	);
}

/**
 * A literal rule is the ONLY thing that may change a model id. Every other
 * outcome, including no matching rule at all, sends what the client asked for.
 */
export function resolveRoutingTarget(
	rule: RoutingRule | null,
	requestedModel: string,
): ResolvedRoutingTarget {
	if (rule?.target_kind === "literal") {
		if (!rule.target_model)
			throw new Error("Literal route requires a target model");
		return { upstreamModel: rule.target_model, targetSource: "literal" };
	}
	if (rule?.target_kind === "requested")
		return { upstreamModel: requestedModel, targetSource: "requested" };
	return { upstreamModel: requestedModel, targetSource: "identity" };
}

export function isModelPermitted(
	permissions: ModelPermissionSet | null,
	accountId: string,
	model: string,
	winningRule: RoutingRule | null,
): boolean {
	if (permissions?.manual_ids.includes(model)) return true;
	if (permissions && permissions.completeness !== "unknown")
		return permissions.discovered_ids.includes(model);
	return (
		winningRule?.enabled === true &&
		winningRule.pool_kind === "accounts" &&
		winningRule.pool_account_ids?.includes(accountId) === true &&
		winningRule.target_kind === "literal" &&
		winningRule.target_model === model
	);
}

export function validateRoutingRule(value: unknown): RoutingRule {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Routing rule must be an object");
	const r = value as RoutingRule;
	const string = (v: unknown, label: string, max = 256) => {
		if (typeof v !== "string" || !v.trim() || v !== v.trim() || v.length > max)
			throw new Error(`Invalid ${label}`);
	};
	const absent = (v: unknown, label: string) => {
		if (v !== null) throw new Error(`${label} must be null`);
	};
	string(r.id, "rule ID");
	string(r.name, "rule name");
	if (typeof r.enabled !== "boolean") throw new Error("Invalid enabled flag");
	if (!Number.isSafeInteger(r.position) || r.position < 0)
		throw new Error("Position must be a nonnegative safe integer");
	if (r.match_api_key_id !== null) string(r.match_api_key_id, "API key ID");
	switch (r.match_model_kind) {
		case "any":
			absent(r.match_model_value, "Model predicate");
			break;
		case "exact":
			string(r.match_model_value, "Model predicate");
			break;
		case "family":
			if (
				!ROUTING_MODEL_FAMILIES.includes(
					r.match_model_value as RoutingModelFamily,
				)
			)
				throw new Error("Invalid model family");
			break;
		default:
			throw new Error("Invalid model predicate kind");
	}
	switch (r.pool_kind) {
		case "inherit":
			absent(r.pool_provider, "Pool provider");
			absent(r.pool_account_ids, "Pool accounts");
			break;
		case "provider":
			string(r.pool_provider, "Pool provider");
			absent(r.pool_account_ids, "Pool accounts");
			break;
		case "accounts":
			absent(r.pool_provider, "Pool provider");
			if (
				!Array.isArray(r.pool_account_ids) ||
				!r.pool_account_ids.length ||
				r.pool_account_ids.length > 1000
			)
				throw new Error("Account pool must be nonempty");
			for (const id of r.pool_account_ids) string(id, "Pool account ID");
			if (new Set(r.pool_account_ids).size !== r.pool_account_ids.length)
				throw new Error("Duplicate account ID");
			break;
		default:
			throw new Error("Invalid pool kind");
	}
	switch (r.target_kind) {
		case "literal":
			string(r.target_model, "Target model");
			break;
		case "default":
		case "requested":
			absent(r.target_model, "Target model");
			break;
		default:
			throw new Error("Invalid target kind");
	}
	// The retired "default" action now means exactly "requested". Normalizing
	// here rather than merely accepting matters because the repository runs this
	// validator on both the read and the write path, so an older API client
	// cannot recreate `default` rows after the one-shot data pass.
	const target_kind = r.target_kind === "default" ? "requested" : r.target_kind;
	return {
		id: r.id,
		name: r.name,
		enabled: r.enabled,
		position: r.position,
		match_api_key_id: r.match_api_key_id,
		match_model_kind: r.match_model_kind,
		match_model_value: r.match_model_value,
		pool_kind: r.pool_kind,
		pool_provider: r.pool_provider,
		pool_account_ids: r.pool_account_ids ? [...r.pool_account_ids] : null,
		target_kind,
		target_model: r.target_model,
	};
}
