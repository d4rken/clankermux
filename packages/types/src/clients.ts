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
export const ALIAS_REASONING_EFFORTS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
export type AliasReasoningEffort = (typeof ALIAS_REASONING_EFFORTS)[number];

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
	/**
	 * Canonical effort values the route accepts. An alias always lists its fixed
	 * range and maps the chosen level onto each target it tries.
	 */
	supportedReasoningEfforts?: AliasReasoningEffort[];
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
/**
 * A global catalogue entry: the part of a {@link ClientModel} that means the
 * same for every client. Codex metadata and Anthropic `createdAt` depend on the
 * client they are published to, so each client supplies its own.
 */
export type GlobalCatalogueModel = Pick<
	ClientModel,
	"id" | "displayName" | "targetModel" | "accountIds"
>;
export interface GlobalCatalogueFormat {
	models: GlobalCatalogueModel[];
	defaultModel: string | null;
}
export interface GlobalCatalogue {
	/** 0 until the first global catalogue is saved. */
	revision: number;
	catalogues: Record<ClientFormat, GlobalCatalogueFormat>;
}
export interface GlobalCatalogueView extends GlobalCatalogue {
	/** IDs of the clients that use the global catalogue. */
	subscribers: string[];
}
/**
 * How one client's catalogue differs from the global one in one format.
 *
 * An addition whose ID is also global replaces that entry for this client. The
 * default follows the global one while `inheritDefault` is set, and is
 * `defaultModel` otherwise; either way it is published only while that model
 * is.
 */
export interface ClientGlobalDelta {
	additions: GlobalCatalogueModel[];
	removals: string[];
	inheritDefault: boolean;
	defaultModel: string | null;
}
/** A global entry this client cannot publish, and why. */
export interface GlobalCatalogueSkip {
	id: string;
	reason: string;
}
export interface ClientGlobalState {
	/** Global revision the published catalogues were last composed from. */
	appliedRevision: number;
	/** One entry per format the global catalogue covers for this application. */
	formats: Partial<
		Record<ClientFormat, ClientGlobalDelta & { skipped: GlobalCatalogueSkip[] }>
	>;
}
/**
 * Formats the global catalogue fills for a client of this application. A
 * generic client may speak any of the three; every other application reads
 * exactly one.
 */
export const globalCatalogueFormats = (
	application: ClientApplication,
): ClientFormat[] =>
	application === "generic"
		? ["anthropic", "openai", "codex"]
		: application === "claude-code"
			? ["anthropic"]
			: application === "codex"
				? ["codex"]
				: ["openai"];
const CLAUDE_CODE_VISIBLE = /claude|anthropic/i;
/**
 * The name Claude Code sees for a catalogue ID. Its model picker lists only
 * IDs naming Claude, so any other gets a `claude-` prefix:
 *
 *   gpt-6-astra      -> claude-gpt-6-astra
 *   alias:frontier   -> claude-alias:frontier
 *   claude-opus-5-5  -> claude-opus-5-5
 */
export const claudeCodeName = (id: string): string =>
	CLAUDE_CODE_VISIBLE.test(id) ? id : `claude-${id}`;
/**
 * The ID a Claude Code name may stand for, or null when `claudeCodeName` can
 * never have produced it. A result is only a candidate: `claude-opus-5-5`
 * yields `opus-5-5`, and whether a name really is a prefixed one is decided
 * by what the accounts serve.
 */
export const claudeCodeTarget = (name: string): string | null => {
	if (!name.startsWith("claude-")) return null;
	const rest = name.slice("claude-".length);
	return rest && !CLAUDE_CODE_VISIBLE.test(rest) ? rest : null;
};
/**
 * A catalogue as Claude Code sees it: each entry under its `claudeCodeName`,
 * and the default only while its entry is listed. Two entries can land on one
 * name (`gpt-6` and `claude-gpt-6`); the one already stored under that name
 * wins, else the first, so every reader resolves the same way.
 */
export function claudeCodeCatalogue<T extends { id: string }>(
	models: readonly T[],
	defaultModel: string | null,
): {
	models: Array<{ model: T; name: string }>;
	defaultModel: string | null;
} {
	const byName = new Map<string, T>();
	for (const model of models) {
		const name = claudeCodeName(model.id);
		const held = byName.get(name);
		if (!held || (held.id !== name && model.id === name))
			byName.set(name, model);
	}
	const listed = models
		.map((model) => ({ model, name: claudeCodeName(model.id) }))
		.filter(({ model, name }) => byName.get(name) === model);
	const chosen = listed.find(({ model }) => model.id === defaultModel);
	return { models: listed, defaultModel: chosen?.name ?? null };
}
/** The client-independent fields of an entry, with a canonical account pin. */
export const globalEntry = (
	model: GlobalCatalogueModel,
): GlobalCatalogueModel => ({
	id: model.id,
	displayName: model.displayName,
	targetModel: model.targetModel,
	accountIds: Array.isArray(model.accountIds)
		? [...new Set(model.accountIds)].sort()
		: model.accountIds,
});
/** Whether two entries mean the same thing for every client. */
export const sameGlobalEntry = (
	a: GlobalCatalogueModel,
	b: GlobalCatalogueModel,
): boolean => JSON.stringify(globalEntry(a)) === JSON.stringify(globalEntry(b));
/** Where an entry of a format the global catalogue covers comes from. */
export type GlobalProvenance = "global" | "override" | "added";
/**
 * One client's view of a global format: global entries in global order, each
 * replaced by the client's same-ID addition and dropped when removed, then the
 * client's other additions. Nothing here is validated for the client.
 */
export function composeGlobalCatalogue(
	global: GlobalCatalogueFormat,
	delta: Pick<ClientGlobalDelta, "additions" | "removals">,
): Array<{ model: GlobalCatalogueModel; provenance: GlobalProvenance }> {
	const overrides = new Map(delta.additions.map((m) => [m.id, m]));
	const removed = new Set(delta.removals);
	const globalIds = new Set(global.models.map((m) => m.id));
	return [
		...global.models
			.filter((m) => !removed.has(m.id))
			.map((m) => {
				const override = overrides.get(m.id);
				return override
					? { model: override, provenance: "override" as const }
					: { model: m, provenance: "global" as const };
			}),
		...delta.additions
			.filter((m) => !globalIds.has(m.id))
			.map((m) => ({ model: m, provenance: "added" as const })),
	];
}
/**
 * The additions and removals that make a client publish exactly `list`.
 *
 * A list read from what a client publishes never holds the global entries it
 * skips, so their absence says nothing and each keeps the removal state it had
 * in `previous`. An entry identical to its global one is not an addition.
 */
export function globalDeltaFromList(
	global: GlobalCatalogueFormat,
	previous: Pick<ClientGlobalDelta, "removals">,
	list: GlobalCatalogueModel[],
	skipped: ReadonlySet<string>,
): Pick<ClientGlobalDelta, "additions" | "removals"> {
	const byId = new Map(global.models.map((m) => [m.id, m]));
	const listed = new Set(list.map((m) => m.id));
	return {
		additions: list
			.filter((m) => {
				const entry = byId.get(m.id);
				return !entry || !sameGlobalEntry(entry, m);
			})
			.map(globalEntry),
		removals: global.models
			.filter(
				(m) =>
					!listed.has(m.id) &&
					(!skipped.has(m.id) || previous.removals.includes(m.id)),
			)
			.map((m) => m.id)
			.sort(),
	};
}
export interface ClientProfile {
	apiKeyId: string;
	application: ClientApplication;
	revision: number;
	/**
	 * What each format publishes. For a format the global catalogue covers, this
	 * is composed from the global catalogue and {@link global}.
	 */
	catalogues: Record<ClientFormat, ClientCatalogue>;
	notices: string[];
	/** Null when this client does not use the global catalogue. */
	global: ClientGlobalState | null;
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
	/**
	 * Alias IDs whose route this save deletes. Taking an alias out of the
	 * catalogues otherwise keeps its routing rule, so a client that still sends
	 * the ID keeps working.
	 */
	droppedAliasRoutes?: string[];
	/**
	 * Omitted: keep the stored choice. Null: stop using the global catalogue,
	 * publishing `catalogues` as given. An object: use it, with these
	 * differences; `catalogues` is then ignored for every format it covers, and
	 * a covered format missing here follows the global catalogue unchanged.
	 */
	global?: {
		formats: Partial<Record<ClientFormat, ClientGlobalDelta>>;
	} | null;
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
export type ClientBulkOperation = (
	| {
			format: ClientFormat;
			/**
			 * Drops every `remove` ID, then appends each `add` entry a client does
			 * not already publish. An ID may appear in only one of the two lists.
			 */
			mode: "edit";
			add: ClientModel[];
			remove: string[];
	  }
	| {
			format: ClientFormat;
			mode: "replace";
			models: ClientModel[];
			defaultModel?: string | null;
	  }
) & {
	/**
	 * Also delete the routes of the aliases this operation takes out of a
	 * client's catalogues. Without it their routes are kept.
	 */
	dropRoutes?: boolean;
};
export type ClientBulkMode = ClientBulkOperation["mode"];
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
	/** Alias IDs whose routes the operation deletes. */
	droppedRoutes: string[];
	/** Alias IDs whose routes stay although no catalogue publishes them. */
	keptRoutes: string[];
	notices: string[];
}
export interface ClientBulkReview {
	token: string;
	operation: ClientBulkOperation;
	clients: ClientBulkClientResult[];
}
export interface GlobalCatalogueDraft {
	/** The revision this edit was made against. */
	revision: number;
	catalogues: Record<ClientFormat, GlobalCatalogueFormat>;
	/** Every client that should use the global catalogue after this edit. */
	subscribers: string[];
	/** Alias IDs whose leftover routes every subscriber drops, as in {@link ClientDraft}. */
	droppedAliasRoutes?: string[];
}
export interface GlobalCatalogueFormatChange {
	added: string[];
	removed: string[];
	modified: string[];
	defaultModelChange: { from: string | null; to: string | null } | null;
	skipped: GlobalCatalogueSkip[];
}
export interface GlobalCatalogueClientResult {
	apiKeyId: string;
	name: string;
	status: "changed" | "unchanged" | "rejected";
	/** Set only when `status` is `rejected`: the client keeps what it publishes now. */
	reason: string | null;
	subscription: "joins" | "leaves" | "stays";
	formats: Partial<Record<ClientFormat, GlobalCatalogueFormatChange>>;
	notices: string[];
}
export interface GlobalCatalogueReview {
	token: string;
	draft: GlobalCatalogueDraft;
	clients: GlobalCatalogueClientResult[];
}
