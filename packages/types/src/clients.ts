import type { ApiKeyResponse } from "./api-key";
import type { RoutingRule } from "./routing";

export type ClientApplication =
	| "generic"
	| "claude-code"
	| "codex"
	| "opencode"
	| "oh-my-pi"
	| "pi";
export type ClientFormat = "anthropic" | "openai" | "codex";
export interface ClientModel {
	id: string;
	displayName: string;
	targetModel: string;
	accountIds: string[] | null;
	createdAt?: string;
	codexMetadata?: Record<string, unknown>;
	metadataCapturedAt?: number;
	metadataScope?: string;
}
export interface ClientModelCostTier {
	inputTokensAbove: number;
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}
export interface ClientModelCost {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** Rates replacing the base set above `inputTokensAbove`, ascending. */
	tiers?: ClientModelCostTier[];
}

/** Cache lifetime policy that is common to every route serving an alias. */
export interface ModelCachePolicy {
	mode: "explicit" | "implicit" | "none" | "unknown";
	defaultTtlMs?: number;
	supportedTtlMs?: number[];
	refreshOnReuse?: boolean;
	expiry: "unavailable" | "estimated" | "exact";
	source: "gateway-policy" | "unknown";
	ttlAnchor?: "request_start" | "request_end" | "unknown";
	ttlSemantics?: "configured" | "minimum" | "typical" | "unknown";
}

/** Advisory retention window; elapsed time means uncertain warmth, never proven expiry. */
export interface ModelCacheRetention {
	basis: "documented" | "inferred" | "heuristic";
	retentionMs: number;
	typicalRangeMs?: [number, number];
	semantics: "configured" | "minimum" | "typical" | "heuristic";
	confidence: "high" | "medium" | "low";
	anchor: "request_start" | "request_end";
	anchorBasis: "documented" | "assumed";
	refreshOnReuse: boolean;
	refreshBasis: "documented" | "assumed";
	sources: Array<{ url: string; note: string }>;
	note: string;
}

/**
 * Metadata for one published alias, resolved per
 * request and never persisted: a stored copy would describe the route the
 * catalogue had when it was written, not the one serving now.
 * Advisory assumptions are labelled separately from verified cache policy.
 */
export interface ClientModelMetadata {
	/** Tokens this alias's route admits. */
	contextWindow?: number;
	maxOutputTokens?: number;
	reasoning?: boolean;
	inputModalities?: Array<"text" | "image">;
	cost?: ClientModelCost;
	cachePolicy?: ModelCachePolicy;
	cacheRetention?: ModelCacheRetention;
}
export type ClientModelMetadataMap = Record<string, ClientModelMetadata>;
export interface ClientModelMetadataResponse {
	models: ClientModelMetadataMap;
	/** False when a real catalogue did not back the lookup (cold start, timeout). */
	catalogueLoaded: boolean;
	catalogueStale: boolean;
}
export interface ClientCatalogue {
	models: ClientModel[];
	defaultModel: string | null;
	envelope?: Record<string, unknown>;
}
export interface ClientProfile {
	apiKeyId: string;
	application: ClientApplication;
	revision: number;
	catalogues: Record<ClientFormat, ClientCatalogue>;
	notices: string[];
}
export interface ClientDestinations {
	accountId: string | null;
	providers: string[] | null;
	excludedProviders?: string[] | null;
}
export interface ClientDraft {
	id?: string;
	revision?: number;
	name: string;
	application: ClientApplication;
	destinations: ClientDestinations;
	catalogues: Record<ClientFormat, ClientCatalogue>;
}
export interface ClientView extends ClientProfile {
	key: ApiKeyResponse;
	aliasRules: RoutingRule[];
}
export interface ClientSuggestion {
	id: string;
	displayName: string;
	accountIds: string[];
	codexMetadataAvailable: boolean;
}
export interface ClientSuggestions {
	models: ClientSuggestion[];
	accounts: Array<{
		id: string;
		name: string;
		provider: string;
		completeness: "unknown" | "known-complete" | "known-empty";
		error: string | null;
	}>;
}
export interface ClientReview {
	token: string;
	draft: ClientDraft;
	aliasRules: RoutingRule[];
	precedingRules: string[];
	notices: string[];
}
export type ClientBulkMode = "add" | "remove" | "replace";
export interface ClientBulkOperation {
	format: ClientFormat;
	mode: ClientBulkMode;
	/** add/replace: the entries. remove: only `id` is read. */
	models: ClientModel[];
	/** replace only; ignored for add/remove. */
	defaultModel?: string | null;
}
export interface ClientBulkClientResult {
	apiKeyId: string;
	name: string;
	status: "changed" | "unchanged" | "rejected";
	/** Set only when `status` is `rejected`. */
	reason: string | null;
	/** Published model IDs this operation would add / drop for this client. */
	added: string[];
	removed: string[];
	/**
	 * Published IDs kept but altered — `targetModel`, `displayName` or
	 * `accountIds` differ from the stored entry. Without this a replace that
	 * repoints `fast` from `target-a` to `target-b` previews as `changed` with
	 * both other arrays empty, so the operator never sees what changes.
	 */
	modified: string[];
	/** Non-null when the format's default model changes. */
	defaultModelChange: { from: string | null; to: string | null } | null;
	notices: string[];
}
export interface ClientBulkReview {
	token: string;
	operation: ClientBulkOperation;
	clients: ClientBulkClientResult[];
}
