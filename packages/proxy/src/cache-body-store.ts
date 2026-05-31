import { TIME_CONSTANTS } from "@clankermux/core";
import { Logger } from "@clankermux/logger";

const log = new Logger("CacheBodyStore");

/**
 * In-memory store for the last request body per account that created a cache entry.
 *
 * Flow:
 *  1. When a request body is buffered in the proxy, stageRequest() is called.
 *  2. When the inline usage collector finalizes a request, onSummary() is
 *     called (on every successful finalize, including zero-usage).
 *     - If cacheCreationInputTokens > 0, the staged entry is promoted to the
 *       per-account "last cached request" slot.
 *     - The staging entry is always deleted (request is complete).
 *  3. The keepalive scheduler reads getLastCachedRequest() at tick time and
 *     replays the body through the proxy.
 *
 * Memory bounds:
 *  - staging: one entry per in-flight request. Primarily cleared on completion
 *    via onSummary() (every successful finalize) or discardStaged() (finalize
 *    failure / terminal-no-summary paths). Because a request can still end
 *    WITHOUT either signal (an all-accounts-failed throw that never reaches
 *    forwardToClient), staging is additionally bounded by an age sweep
 *    (STAGING_MAX_AGE_MS) and a hard size cap (MAX_STAGING_ENTRIES) — otherwise
 *    orphaned ~0.5–1.5 MB bodies leak (cf. oven-sh/bun#5709: off-heap buffers
 *    the allocator never returns while still referenced).
 *  - lastCachedRequest: one entry per account → bounded by account count.
 *
 * Note: client headers ARE stored because some providers (e.g. Anthropic) copy
 * incoming headers in prepareHeaders() and augment them, so the replay needs to
 * carry the original client headers to produce an identical upstream request.
 * Providers that build headers from scratch (Qwen) simply ignore them.
 *
 * Sensitive and internal headers are stripped before storing.
 */

/**
 * Only cache requests to this path — other endpoints don't use prompt cache.
 */
const CACHEABLE_PATH = "/v1/messages";

/**
 * Byte patterns to search for in the request body to detect cache_control hints.
 * Both quoted forms cover JSON key serialization styles.
 */
const CACHE_CONTROL_HINTS: Uint8Array[] = [
	new TextEncoder().encode('"cache_control"'),
	new TextEncoder().encode('"cache-control"'),
];

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
	const hLen = haystack.length;
	const nLen = needle.length;
	if (nLen === 0) return true;
	if (nLen > hLen) return false;
	outer: for (let i = 0; i <= hLen - nLen; i++) {
		for (let j = 0; j < nLen; j++) {
			if (haystack[i + j] !== needle[j]) continue outer;
		}
		return true;
	}
	return false;
}

function hasCacheControlHint(body: ArrayBuffer): boolean {
	const bytes = new Uint8Array(body);
	return CACHE_CONTROL_HINTS.some((hint) => containsBytes(bytes, hint));
}

export interface CachedRequestEntry {
	/** Original client request body, as-received (pre-transform). */
	body: Buffer;
	/** Sanitized original client headers (no auth, no internal proxy headers). */
	headers: Record<string, string>;
	/** Request path, e.g. "/v1/messages". */
	path: string;
	/** Unix timestamp when this entry was recorded. */
	timestamp: number;
}

// Strip sensitive and internal headers before storing.
// Auth headers are injected by prepareHeaders() from account credentials.
// Internal x-clankermux-* headers are injected fresh by the scheduler.
const STRIP_HEADERS = new Set([
	"authorization",
	"x-api-key",
	"cookie",
	"x-claude-code-session-id",
	"thread-id",
	"session-id",
	"x-client-request-id",
	"x-codex-installation-id",
	"x-codex-window-id",
	"x-codex-turn-state",
	"chatgpt-account-id",
	"traceparent",
	"tracestate",
	"x-clankermux-account-id",
	// Legacy alias still accepted on inbound requests (dual-accept), strip it too.
	"x-better-ccflare-account-id",
	"x-clankermux-bypass-session",
	"x-clankermux-skip-cache",
	"x-clankermux-keepalive",
	"content-length",
	"transfer-encoding",
	"accept-encoding",
	"content-encoding",
	"connection",
	"keep-alive",
	"upgrade",
	"proxy-authorization",
	"proxy-authenticate",
	"host",
]);

/**
 * Hard cap on concurrently-staged request bodies. A safety net: if orphaned
 * entries (requests that complete without onSummary/discardStaged) ever
 * accumulate faster than the age sweep clears them, this bounds worst-case
 * memory. Each entry holds a full ~0.5–1.5 MB request-body copy, so the cap is
 * sized for realistic in-flight concurrency with generous headroom.
 */
export const MAX_STAGING_ENTRIES = 500;

/**
 * Resolve a positive-millisecond env override, falling back to `fallback` when
 * unset or invalid. Mirrors the parsing forwardToClient uses for the stream
 * timeouts so the staging age stays in lockstep with how long a stream may run.
 */
function resolveEnvMs(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Maximum age of an in-flight staged entry before it's treated as an orphan and
 * evicted. Must exceed the longest a LIVE request can stay staged, so we never
 * evict one mid-flight: staging happens BEFORE the upstream call, so a request
 * can wait up to PROXY_REQUEST_TIMEOUT_MS for response headers and THEN stream
 * for up to the stream-forward total timeout (plus a chunk-timeout of margin).
 * The stream portions honor the same CF_STREAM_TOTAL_TIMEOUT_MS /
 * CF_STREAM_CHUNK_TIMEOUT_MS overrides forwardToClient uses, so raising them for
 * long agentic workloads (issue #84) widens this window in lockstep. Anything
 * older never got an onSummary/discardStaged signal (e.g. an error before the
 * response handler ran) and would otherwise leak its off-heap body (bun#5709).
 */
export const STAGING_MAX_AGE_MS =
	TIME_CONSTANTS.PROXY_REQUEST_TIMEOUT_MS +
	resolveEnvMs(
		"CF_STREAM_TOTAL_TIMEOUT_MS",
		TIME_CONSTANTS.STREAM_FORWARD_TOTAL_TIMEOUT_MS,
	) +
	resolveEnvMs(
		"CF_STREAM_CHUNK_TIMEOUT_MS",
		TIME_CONSTANTS.STREAM_FORWARD_CHUNK_TIMEOUT_MS,
	);

class CacheBodyStore {
	/**
	 * requestId → staged entry while the request is in-flight. Cleared by
	 * onSummary() (successful finalize) or discardStaged() (finalize failure /
	 * terminal-no-summary), with the age sweep + size cap as backstops.
	 */
	private staging = new Map<
		string,
		{ accountId: string; entry: CachedRequestEntry }
	>();

	/** accountId → last request that created a cache entry. */
	private lastCachedRequest = new Map<string, CachedRequestEntry>();

	/** Whether the feature is enabled — skip staging entirely when false. */
	private enabled = false;

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) {
			this.staging.clear();
			this.lastCachedRequest.clear();
		}
	}

	/**
	 * Called when a request body has been buffered.
	 * Only stages if the feature is enabled and we have a body.
	 */
	stageRequest(
		requestId: string,
		accountId: string | null,
		body: ArrayBuffer | null,
		headers: Headers,
		path: string,
	): void {
		if (!this.enabled || !accountId || !body || body.byteLength === 0) return;

		// Only cache prompt-cache-relevant endpoint.
		if (path !== CACHEABLE_PATH) return;

		// Only stage if the body contains a cache_control hint — requests without
		// prompt-cache markers won't create cache entries, nothing to keep alive.
		if (!hasCacheControlHint(body)) return;

		const sanitizedHeaders: Record<string, string> = {};
		headers.forEach((value, key) => {
			if (!STRIP_HEADERS.has(key.toLowerCase())) {
				sanitizedHeaders[key] = value;
			}
		});

		this.staging.set(requestId, {
			accountId,
			entry: {
				body: Buffer.from(body),
				headers: sanitizedHeaders,
				path,
				timestamp: Date.now(),
			},
		});

		// Bound the staging map on the hot path: reap orphaned entries (requests
		// that ended without a worker summary) and enforce the hard cap, so a
		// staged body can never leak. Both scans are O(size) over a normally-tiny
		// map.
		this.sweepStaleStaging();
		this.enforceStagingCap();
	}

	/**
	 * Called when the inline usage collector finalizes a request (every
	 * successful finalize, including zero-usage). Promotes to the per-account
	 * slot if caching was used; always cleans up staging.
	 */
	onSummary(
		requestId: string,
		cacheCreationInputTokens: number | undefined,
	): void {
		const staged = this.staging.get(requestId);
		this.staging.delete(requestId);

		if (!staged) return;

		if (cacheCreationInputTokens && cacheCreationInputTokens > 0) {
			this.lastCachedRequest.set(staged.accountId, staged.entry);
		}
	}

	/**
	 * Remove a single in-flight staged entry without promoting it. For terminal
	 * request paths that will never produce a summary (e.g. all accounts failed)
	 * and on finalize failure. Idempotent — a no-op if the entry is already gone.
	 */
	discardStaged(requestId: string): void {
		this.staging.delete(requestId);
	}

	/** Number of in-flight staged request bodies (observability/tests). */
	getStagingSize(): number {
		return this.staging.size;
	}

	/**
	 * Returns the last request body that created a cache entry for this account,
	 * or null if none is recorded.
	 */
	getLastCachedRequest(accountId: string): CachedRequestEntry | null {
		return this.lastCachedRequest.get(accountId) ?? null;
	}

	/** Returns all accounts that have a recorded cached request. */
	getAllCachedAccounts(): string[] {
		return Array.from(this.lastCachedRequest.keys());
	}

	/** Remove a specific account's cached entry (e.g. account deleted). */
	evict(accountId: string): void {
		this.lastCachedRequest.delete(accountId);
	}

	/**
	 * Evicts cached request entries older than the specified age threshold.
	 * Called at keepalive tick time to prevent replaying stale requests whose
	 * underlying prompt cache has long expired.
	 *
	 * @param ttlMinutes The configured cache TTL in minutes
	 * @param ageMultiplier Multiplier for TTL to determine max age (default: 3)
	 *                      e.g. TTL 5min with multiplier 3 = evict entries older than 15min
	 */
	evictStaleEntries(ttlMinutes: number, ageMultiplier = 3): void {
		const maxAgeMs = ttlMinutes * 60_000 * ageMultiplier;
		const cutoffTime = Date.now() - maxAgeMs;
		let evictedCount = 0;

		for (const [accountId, entry] of this.lastCachedRequest.entries()) {
			if (entry.timestamp < cutoffTime) {
				this.lastCachedRequest.delete(accountId);
				evictedCount++;
			}
		}

		if (evictedCount > 0) {
			const maxAgeMinutes = Math.round(maxAgeMs / 60_000);
			log.info(
				`Evicted ${evictedCount} stale cached request(s) older than ${maxAgeMinutes}min (TTL: ${ttlMinutes}min × ${ageMultiplier})`,
			);
		}

		// Also reap orphaned in-flight staged entries. Defense-in-depth for idle
		// periods where no new stageRequest arrives to trigger the inline sweep.
		const stagingEvicted = this.sweepStaleStaging();
		if (stagingEvicted > 0) {
			log.info(
				`Evicted ${stagingEvicted} orphaned staged request(s) older than ${Math.round(
					STAGING_MAX_AGE_MS / 60_000,
				)}min`,
			);
		}
	}

	/**
	 * Evict staged entries older than {@link STAGING_MAX_AGE_MS}. Returns the
	 * number evicted. Deleting during Map iteration is well-defined in JS.
	 */
	private sweepStaleStaging(now = Date.now()): number {
		const cutoff = now - STAGING_MAX_AGE_MS;
		let evicted = 0;
		for (const [requestId, staged] of this.staging) {
			if (staged.entry.timestamp < cutoff) {
				this.staging.delete(requestId);
				evicted++;
			}
		}
		return evicted;
	}

	/**
	 * Enforce {@link MAX_STAGING_ENTRIES} by evicting oldest-first (Map preserves
	 * insertion order). Only bites if orphans outpace the age sweep — a runaway
	 * guard, not the primary bound.
	 */
	private enforceStagingCap(): void {
		if (this.staging.size <= MAX_STAGING_ENTRIES) return;
		const excess = this.staging.size - MAX_STAGING_ENTRIES;
		let removed = 0;
		for (const requestId of this.staging.keys()) {
			if (removed >= excess) break;
			this.staging.delete(requestId);
			removed++;
		}
		log.warn(
			`Staging exceeded ${MAX_STAGING_ENTRIES} entries; evicted ${removed} oldest staged request bod(ies) to bound memory`,
		);
	}
}

export const cacheBodyStore = new CacheBodyStore();
