import type { ProjectPathOverride } from "./project-rules";
import type {
	CachePrefixCapture,
	ContextComposition,
	ProjectAttributionSource,
	ToolCallStat,
} from "./request";

/** Combo slot routing info — maps each returned account to its slot's model override */
export interface ComboSlotInfo {
	/** The combo name (null when not using combo routing) */
	comboName: string | null;
	/** Ordered list of { accountId, modelOverride } for combo slots, indexed by position in the returned accounts array */
	slots: Array<{ accountId: string; modelOverride: string }>;
}

export interface RequestMeta {
	id: string;
	method: string;
	path: string;
	timestamp: number;
	/** Stable client conversation/thread key used for cache-affinity routing */
	affinityKey?: string | null;
	/** Source of the affinity key; persisted separately for routing analysis */
	affinityScope?: RequestAffinityScope | null;
	/** Optional tenant partition for affinity keys, e.g. authenticated API key id */
	affinityPartition?: string | null;
	project?: string | null;
	/**
	 * Which attribution tier produced `project` (see ProjectAttributionSource).
	 * `null`/absent = the request was never eligible for project attribution,
	 * which is distinct from the recorded value `"none"` ("eligible, no tier
	 * fired"). Derived once in handleProxy and threaded like `project`.
	 */
	projectAttributionSource?: ProjectAttributionSource | null;
	/** Model resolved at ingress before an upstream response is available. */
	requestedModel?: string | null;
	/**
	 * Ingest-time context composition computed once in handleProxy from the
	 * parsed POST /v1/messages body; null/absent when not computed (other
	 * endpoints, unparseable body). Threaded to the recorder like `project`.
	 */
	contextComposition?: ContextComposition | null;
	/**
	 * Ingest-time per-tool call/error stats mined from the final message of the
	 * parsed POST /v1/messages body; null/absent when not computed (other
	 * endpoints, no tool_result blocks). Threaded to the recorder like
	 * `contextComposition`.
	 */
	toolCallStats?: ToolCallStat[] | null;
	/**
	 * Per-request reasoning effort: `"thinking:<budget>"` / `"thinking"` for
	 * Anthropic bodies, the raw `reasoning.effort` string for OpenAI Responses
	 * bodies, null when absent. Derived once in handleProxy.
	 */
	reasoningEffort?: string | null;
	/**
	 * Cache-measurement capture: `<apiKeyId|anon>:<Claude Code session uuid>`
	 * from the body's metadata.user_id (same value resolveProject derives for
	 * session-based project inheritance). Null/absent when the body carried no
	 * session id. Threaded to the recorder like `project`.
	 */
	sessionKey?: string | null;
	/**
	 * Cache-measurement capture: per-breakpoint prompt-cache prefix digests
	 * computed once in handleProxy from the parsed POST /v1/messages body (see
	 * packages/proxy/src/cache-prefix-hash.ts). Null/absent when not computed
	 * (other endpoints, no ephemeral cache_control breakpoints, unparseable
	 * body). Threaded to the recorder like `contextComposition`.
	 */
	cachePrefixHashes?: CachePrefixCapture | null;
	headers?: Headers;
	/** True only for in-process scheduler/probe requests, never from client headers */
	internal?: boolean;
	/** Active combo name (set when combo routing is used) */
	comboName?: string | null;
	/** Combo slot index being attempted (set per-iteration in proxy loop) */
	comboSlotIndex?: number | null;
	/** Internal routing telemetry persisted with the request for optimization analysis */
	routing?: RequestRoutingMeta;
	/** Resolved per-key routing pin from the authenticated API key (Feature: API-key→account/class pin). */
	pin?: { accountId: string | null; providers: string[] | null } | null;
	/** Set when a pin strict-fails account selection; handleProxy returns a terminal pinned_target_unavailable error. */
	pinFailure?: { code: string; message: string } | null;
	/**
	 * Unconditional floor for Codex-CLI traffic: when true, the request may NEVER
	 * be routed to an official Anthropic/Claude account (ban risk + not a real
	 * cross-model review). Set by the /v1/responses adapter for ALL Codex CLI
	 * requests, independent of any API-key pin or auth config. Composes with the
	 * pin and also disables the (Anthropic-only) burst-hold for the request.
	 */
	excludeOfficialAnthropic?: boolean | null;
}

export type RequestAffinityScope =
	| "claude_session"
	| "codex_thread"
	| "project";

export interface RequestRoutingMeta {
	strategy: string;
	decision: string;
	affinityScope?: RequestAffinityScope | null;
	affinityKey?: string | null;
	selectedAccountId?: string | null;
	/**
	 * The account that post-selection gates resolved as the FIRST attempt, set
	 * after every gate and reorder has run. Distinct from `selectedAccountId`
	 * (the strategy's pick, pre-gate): a soft-demotion reorder can move the
	 * strategy's pick out of first place, and consumers that must respect that
	 * reorder have to test position, not list membership.
	 */
	primaryAttemptAccountId?: string | null;
	previousAccountId?: string | null;
	candidatesCount?: number | null;
	failoverReason?: string | null;
	/**
	 * The cache-affinity-pinned account id for this request, when one is known —
	 * EVEN IF that account is currently in cooldown and a sibling was handed out
	 * as `selectedAccountId` instead (an `affinity_hold`). Populated by the
	 * session strategy on affinity hit/hold so the transparent burst-retry
	 * feature can target the cache-warm account before the failover loop iterates
	 * siblings. `null` when there is no affinity pin (miss/reassign/no key) or the
	 * strategy doesn't track affinity.
	 *
	 * In-memory routing decision only — NOT persisted (omitted from the recorder's
	 * routing projection).
	 */
	heldAccountId?: string | null;
}

// Retention and maintenance API shapes
export interface RetentionGetResponse {
	/** Payload retention window in HOURS (all sibling windows are in days). */
	payloadHours: number;
	/**
	 * Byte budget for stored payloads in MEGABYTES; 0 = disabled. Counts payload
	 * CONTENT bytes, not the database file size.
	 */
	payloadMaxMb: number;
	requestDays: number;
	usageSnapshotDays: number;
	memorySnapshotDays: number;
	cacheKeepaliveSnapshotDays: number;
	storePayloads: boolean;
}

export interface RetentionSetRequest {
	/** Payload retention window in HOURS (all sibling windows are in days). */
	payloadHours?: number;
	/** Byte budget for stored payloads in MEGABYTES; 0 disables it. */
	payloadMaxMb?: number;
	requestDays?: number;
	usageSnapshotDays?: number;
	memorySnapshotDays?: number;
	cacheKeepaliveSnapshotDays?: number;
	storePayloads?: boolean;
}

// Project-attribution rules. Shared rather than re-declared client-side: a
// server-side rename must not typecheck while the client silently disagrees.
export interface ProjectRulesGetResponse {
	roots: string[];
	overrides: ProjectPathOverride[];
	/**
	 * The built-in roots, so the UI can offer "restore defaults" without
	 * hardcoding a list that would drift from the server's.
	 */
	defaultRoots: string[];
	/**
	 * Working directories seen since startup that matched no rule, most recent
	 * first. In-memory and bounded, so an empty list means "nothing recently",
	 * never "nothing ever".
	 */
	unmatched: { path: string; count: number; lastSeenAt: number }[];
}

export interface ProjectRulesSetRequest {
	roots: string[];
	overrides: ProjectPathOverride[];
}

export interface CleanupResponse {
	removedRequests: number;
	removedPayloads: number;
	payloadCutoffIso: string | null;
	requestCutoffIso: string;
}

/**
 * One row of the per-data-type storage breakdown shown beside the retention
 * controls. `key` ties the figure to a control (Payloads / Requests / Usage
 * snapshots).
 *
 * `approxBytes` is *logical content bytes* — `SUM(LENGTH(col))` across the
 * table's columns — not a true on-disk page size. The `dbstat` virtual table
 * (which would give page-accurate per-table figures including indexes) is not
 * compiled into the bundled bun:sqlite build, so per-row index/page overhead
 * is not attributable here. The per-type figures therefore deliberately
 * undercount and will NOT sum to `dbBytes`; the UI labels them approximate.
 */
export interface StorageUsageType {
	key:
		| "payloads"
		| "requests"
		| "usage_snapshots"
		| "usage_scoped_snapshots"
		| "unified_claim_observations"
		| "unified_summary_observations"
		| "internal_dispatch_spend"
		| "codex_window_observations"
		| "openai_bucket_observations"
		| "quota_drift_results"
		| "memory_snapshots"
		| "tool_calls"
		| "tool_errors";
	/** Underlying SQLite table that was measured. */
	table: string;
	rowCount: number;
	approxBytes: number;
}

/**
 * Response from `GET /api/storage/usage` — backs the standing "space used per
 * retained data type" display in the retention settings card. Measured on the
 * server and cached briefly (a full-table scan is needed for the byte sums).
 */
export interface StorageUsageResponse {
	/**
	 * Whether per-table logical sizing could be measured. The card hides the
	 * size breakdown when false. (SQLite always reports true today.)
	 */
	available: boolean;
	/** ISO timestamp of when these figures were measured (possibly cached). */
	measuredAt: string;
	/** Whole SQLite file size on disk, bytes — exact (includes indexes/free pages). */
	dbBytes: number;
	/** WAL sidecar size, bytes. */
	walBytes: number;
	types: StorageUsageType[];
}

// Model-catalogue curation: the dashboard's "Models" page and the
// `GET /v1/models` reply it shapes.

/**
 * A wire dialect, which is also the unit a catalogue is curated in. The two
 * mounts serve different clients different shapes, so an entry hidden for
 * Codex is untouched for Claude Code.
 */
export type ModelDialect = "anthropic" | "openai";

/**
 * Where the uncurated list came from. Shown verbatim to the operator, because
 * "the models Anthropic lists" and "the models this build knows about" are
 * different answers and only one of them is live.
 */
export type ModelBaselineSource =
	/** Anthropic's live `/v1/models`. */
	| "upstream"
	/** The registry compiled into this build; upstream could not be read. */
	| "bundled"
	/** The bundled Codex model list. */
	| "static"
	/** The per-subscription Codex catalogue, read from one of our accounts. */
	| "codex-catalog";

/** One row of the operator's editing view: baseline plus what was done to it. */
export interface ModelCatalogRow {
	id: string;
	/** The name as served, after any override. */
	displayName: string;
	/** Whether the entry exists upstream or only because it was added here. */
	source: "upstream" | "custom";
	hidden: boolean;
	/** The stored override, or null when the baseline's own name is served. */
	overrideDisplayName: string | null;
}

/** Response from `GET /api/models/catalog?dialect=…`. */
export interface ModelCatalogResponse {
	baseline: {
		source: ModelBaselineSource;
		/** Epoch ms of the fetch backing the baseline, or null when it is static. */
		fetchedAt: number | null;
	};
	rows: ModelCatalogRow[];
}

/**
 * Body of `POST /api/models/overrides`. FULL REPLACEMENT: every field is
 * required, because the editing view always holds the complete state of the row
 * it renders and a partial merge would make two concurrent edits silently
 * combine.
 */
export interface ModelOverrideSetRequest {
	dialect: ModelDialect;
	modelId: string;
	hidden: boolean;
	custom: boolean;
	displayName: string | null;
}
