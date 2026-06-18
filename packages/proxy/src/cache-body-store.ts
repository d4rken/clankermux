import { TIME_CONSTANTS } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import { isBridgeableProvider } from "./bridge-policy";
import { CACHE_REPLAY_STRIP_HEADERS } from "./cache-header-strip";
import { sessionCacheStore } from "./session-cache-store";

const log = new Logger("CacheBodyStore");

/**
 * In-memory staging store that routes cache-using requests into the per-SESSION
 * {@link sessionCacheStore} for the Session Cache Bridge.
 *
 * Flow:
 *  1. When a request body is buffered in the proxy, stageRequest() is called
 *     (only for /v1/messages bodies carrying a cache_control hint — that hint is
 *     how we identify explicit-breakpoint providers and skip Codex etc.).
 *  2. When the inline usage collector finalizes a request, onSummary() is
 *     called (on every successful finalize, including zero-usage). The staged
 *     entry is always deleted, and:
 *     - If cacheCreationInputTokens > 0, the body is registered into the
 *       per-session store (which applies the cache-write-premium + min-token
 *       gates itself; sub-threshold / no-premium requests store nothing).
 *     - Else if a cache-READ occurred, the session's activity is touched (the
 *       read proves the prompt cache is still warm).
 *  3. The keepalive scheduler reads sessionCacheStore.getEligibleSessions() at
 *     tick time and replays the warm body through the proxy.
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
		{ accountId: string; sessionKey: string | null; entry: CachedRequestEntry }
	>();

	/** Whether the feature is enabled — skip staging entirely when false. */
	private enabled = false;

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) {
			this.staging.clear();
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
		sessionKey: string | null = null,
		provider: string | null = null,
	): void {
		if (!this.enabled || !accountId || !body || body.byteLength === 0) return;

		// Provider-identity gate: only bridge providers whose explicit-breakpoint
		// cache has a real write premium (Anthropic). This excludes non-Anthropic
		// providers up front, so an unrecognized model id (which getModelCacheRates
		// resolves to a Sonnet-rate fallback) can never make a non-Anthropic
		// provider look bridgeable. The hasCacheWritePremium check in
		// sessionCacheStore.register() remains as defense-in-depth.
		if (!isBridgeableProvider(provider)) return;

		// Only cache prompt-cache-relevant endpoint.
		if (path !== CACHEABLE_PATH) return;

		// Only stage if the body contains a cache_control hint — requests without
		// prompt-cache markers won't create cache entries, nothing to keep alive.
		if (!hasCacheControlHint(body)) return;

		const sanitizedHeaders: Record<string, string> = {};
		headers.forEach((value, key) => {
			if (!CACHE_REPLAY_STRIP_HEADERS.has(key.toLowerCase())) {
				sanitizedHeaders[key] = value;
			}
		});

		this.staging.set(requestId, {
			accountId,
			sessionKey,
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
	 * successful finalize, including zero-usage). Routes a cache-using request
	 * into the per-session bridge store; always cleans up staging.
	 *
	 * The session key falls back to a synthetic per-account key for unkeyed
	 * requests so they still get a (single) warm slot. {@link sessionCacheStore}
	 * applies the cache-write-premium and min-token gates internally, so a
	 * sub-threshold or no-premium summary stores nothing.
	 *  - cacheCreation > 0 → register the body (a new/refreshed warm prefix).
	 *  - else cacheRead > 0 → touchActivity (the read proves the cache is warm;
	 *    no-op if no slot exists for the key).
	 */
	onSummary(
		requestId: string,
		cacheCreationInputTokens: number | undefined,
		cacheReadInputTokens?: number,
		model?: string,
	): void {
		const staged = this.staging.get(requestId);
		this.staging.delete(requestId);

		if (!staged) return;

		const sessionKey = staged.sessionKey ?? `__account__:${staged.accountId}`;

		if (cacheCreationInputTokens && cacheCreationInputTokens > 0) {
			sessionCacheStore.register({
				accountId: staged.accountId,
				sessionKey,
				body: staged.entry.body,
				headers: new Headers(staged.entry.headers),
				path: staged.entry.path,
				model,
				cacheReadTokens: cacheReadInputTokens ?? 0,
				cacheCreationTokens: cacheCreationInputTokens,
			});
		} else if ((cacheReadInputTokens ?? 0) > 0) {
			// Cache-READ turn (a hit, no creation): no new body to register, but the
			// read proves the cache is warm, so touch the existing slot's activity
			// (no-op if we never stored one for this key).
			sessionCacheStore.touchActivity(staged.accountId, sessionKey, Date.now());
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
	 * Reap orphaned in-flight staged entries. Called at keepalive tick time as
	 * defense-in-depth for idle periods where no new stageRequest arrives to
	 * trigger the inline sweep, so a staged ~0.5–1.5 MB body can never leak.
	 */
	evictStaleEntries(): void {
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
