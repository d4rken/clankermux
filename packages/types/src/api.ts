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
	 * Per-request reasoning effort: `"thinking:<budget>"` / `"thinking"` for
	 * Anthropic bodies, the raw `reasoning.effort` string for OpenAI Responses
	 * bodies, null when absent. Derived once in handleProxy.
	 */
	reasoningEffort?: string | null;
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
	payloadDays: number;
	requestDays: number;
	usageSnapshotDays: number;
	memorySnapshotDays: number;
	storePayloads: boolean;
}

export interface RetentionSetRequest {
	payloadDays?: number;
	requestDays?: number;
	usageSnapshotDays?: number;
	memorySnapshotDays?: number;
	storePayloads?: boolean;
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
	key: "payloads" | "requests" | "usage_snapshots" | "memory_snapshots";
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
