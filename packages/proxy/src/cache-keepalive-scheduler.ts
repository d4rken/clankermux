import type { Config } from "@clankermux/config";
import { registerHeartbeat } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import { BRIDGE_JITTER_MAX_MS } from "./bridge-policy";
import { bridgeStats } from "./bridge-stats";
import { cacheBodyStore } from "./cache-body-store";
import { dispatchProxyRequest } from "./dispatch";
import type { ProxyContext } from "./proxy";
import {
	type SessionCacheSlot,
	sessionCacheStore,
} from "./session-cache-store";
import { sessionPromotionTracker } from "./session-promotion";

const log = new Logger("CacheKeepaliveScheduler");

/**
 * Operational cap on how many session keepalives a single tick may dispatch.
 * Bounds tick duration and protects against a burst of replays when many
 * sessions become eligible at once. Sessions over the cap are deferred to the
 * next tick (highest-priority first). Kept here (not in bridge-policy) as a
 * scheduler-local operational knob rather than cost math.
 */
const MAX_BRIDGE_KEEPALIVES_PER_TICK = 20;

/**
 * Number of keepalive replays dispatched concurrently within a tick. The capped
 * eligible batch is drained in chunks of this size (each chunk via
 * Promise.allSettled) so a full batch of MAX_BRIDGE_KEEPALIVES_PER_TICK drains in
 * ~ceil(batch / KEEPALIVE_CONCURRENCY) waves instead of one serial await per
 * session. This keeps the last sessions in a large batch from drifting toward
 * Anthropic's ~5-min prompt-cache TTL under upstream latency, while keeping the
 * per-IP burst modest (and keepalive 429s are already cooldown-exempt).
 */
const KEEPALIVE_CONCURRENCY = 4;

/**
 * Heartbeat tick cadence (2 min). The scheduler wakes this often; per-session
 * due-ness is decided inside the store by {@link KEEPALIVE_REFRESH_MS}, so the
 * tick only needs to be comfortably under the cache TTL.
 */
// Poll often enough that a slot crossing the KEEPALIVE_REFRESH_MS (3 min)
// threshold is picked up within one tick, keeping the replay well under
// Anthropic's 5-min cache TTL even with upstream latency.
const KEEPALIVE_TICK_SECONDS = 60;

/**
 * Parse the first `cache_creation_input_tokens` value from a keepalive response.
 *
 * Works for both response shapes the proxy may return: a JSON envelope (the
 * `usage` object embeds the field) and an SSE stream (the field appears inside a
 * `message_start` event's serialized `data:` line). In both cases the raw text
 * contains the literal `"cache_creation_input_tokens": <n>` token, so a single
 * regex over the body text covers both without parsing the stream. Returns the
 * matched count, or null when the field is absent (e.g. an error body) — null
 * means "unknown", so the caller does not treat it as a proven hit or miss.
 */
export function extractCacheCreationTokens(text: string): number | null {
	const match = text.match(/"cache_creation_input_tokens"\s*:\s*(\d+)/);
	if (!match) return null;
	const parsed = Number(match[1]);
	return Number.isFinite(parsed) ? parsed : null;
}

export class CacheKeepaliveScheduler {
	private proxyContext: ProxyContext;
	private config: Config;
	private unregisterInterval: (() => void) | null = null;
	private enabled = false;
	private boundConfigChangeHandler:
		| ((event: { key: string; newValue: unknown }) => void)
		| null = null;

	constructor(proxyContext: ProxyContext, config: Config) {
		this.proxyContext = proxyContext;
		this.config = config;
	}

	start(): void {
		this.enabled = this.config.getCacheWarmingEnabled();
		// Cache warming drives both the staging store (which routes bodies) and the
		// per-session warm-body store.
		cacheBodyStore.setEnabled(this.enabled);
		sessionCacheStore.setEnabled(this.enabled);
		// The predictive 1h-TTL promotion tracker is mode-aware (off/static/dynamic),
		// so hand it the configured mode rather than a boolean.
		sessionPromotionTracker.setMode(this.config.getCacheWarmingMode());
		sessionCacheStore.setMinTokens(this.config.getCacheWarmingMinTokens());

		// React dynamically to cache-warming config changes.
		this.boundConfigChangeHandler = ({
			key,
			newValue,
		}: {
			key: string;
			newValue: unknown;
		}) => {
			// Both the mode field and the legacy boolean resolve through
			// getCacheWarmingMode(); recompute from config so either key is handled
			// (setCacheWarmingMode emits "cache_warming_mode").
			if (key === "cache_warming_mode" || key === "cache_warming_enabled") {
				const mode = this.config.getCacheWarmingMode();
				const next = mode !== "off";
				cacheBodyStore.setEnabled(next);
				sessionCacheStore.setEnabled(next);
				sessionPromotionTracker.setMode(mode);
				if (next !== this.enabled) {
					this.enabled = next;
					this.restart();
				}
			} else if (key === "cache_warming_min_tokens") {
				if (typeof newValue === "number") {
					sessionCacheStore.setMinTokens(newValue);
				}
			}
		};
		this.config.on("change", this.boundConfigChangeHandler);

		this.startInterval();
	}

	stop(): void {
		this.stopInterval();
		if (this.boundConfigChangeHandler) {
			this.config.off("change", this.boundConfigChangeHandler);
			this.boundConfigChangeHandler = null;
		}
	}

	private stopInterval(): void {
		if (this.unregisterInterval) {
			this.unregisterInterval();
			this.unregisterInterval = null;
		}
	}

	private restart(): void {
		this.stopInterval();
		this.startInterval();
	}

	private startInterval(): void {
		if (!this.enabled) {
			log.info("Cache warming disabled");
			return;
		}

		log.info(
			`Starting cache warming scheduler, tick interval: ${KEEPALIVE_TICK_SECONDS}s`,
		);

		this.unregisterInterval = registerHeartbeat({
			id: "cache-keepalive-scheduler",
			callback: () => this.sendKeepalives(),
			seconds: KEEPALIVE_TICK_SECONDS,
			description: "Cache warming scheduler",
		});
	}

	/**
	 * Dispatch keepalives for the most valuable idle sessions in the per-session
	 * warm-body store. The (already per-tick-capped) eligible batch is drained in
	 * chunks of KEEPALIVE_CONCURRENCY, each chunk dispatched concurrently via
	 * Promise.allSettled with a small pre-dispatch decorrelation jitter per replay.
	 * Bounded concurrency caps batch-position lateness (so the last sessions in a
	 * full batch don't drift toward the prompt-cache TTL) while keeping the per-IP
	 * burst modest; keepalive 429s are already cooldown-exempt.
	 */
	private async sendKeepalives(): Promise<void> {
		// Reap orphaned in-flight staged bodies (defense-in-depth for idle periods).
		cacheBodyStore.evictStaleEntries();

		// Observability: in-flight staged bodies should stay small and flat. A
		// climbing number here means the staging leak has resurfaced.
		log.debug(
			`Cache body store: ${cacheBodyStore.getStagingSize()} in-flight staged, ${sessionCacheStore.getSize()} warm session(s)`,
		);

		// Per-tick bridge economics heartbeat. INFO when there are warm sessions to
		// report on, DEBUG when idle (keeps the journal quiet while inactive).
		const s = bridgeStats.snapshot();
		const summary = `[CacheBridge] summary mode=${this.config.getCacheWarmingMode()} warm=${sessionCacheStore.getSize()} promoted=${sessionCacheStore.getPromotedSessions()} hits=${s.hits} misses=${s.misses} hitRate=${(s.hitRate * 100).toFixed(0)}% failures=${s.failures} resumes=${s.warmResumes} spentUsd=${s.spentUsd.toFixed(4)} savedUsd=${s.savedUsd.toFixed(4)} netUsd=${s.netUsd.toFixed(4)}`;
		if (sessionCacheStore.getSize() > 0) {
			log.info(summary);
		} else {
			log.debug(summary);
		}

		const eligible = sessionCacheStore.getEligibleSessions(Date.now());

		if (eligible.length === 0) {
			log.debug("No eligible sessions for cache warming");
			return;
		}

		// Snapshot each slot's activity stamp NOW, at batch-selection time — before
		// the per-chunk jitter delay below. If a real request touches a slot during
		// that delay, replaySessionKeepalive sees the changed stamp and skips it (the
		// session is no longer idle), and the same stamp guards outcome recording.
		const batch = eligible
			.slice(0, MAX_BRIDGE_KEEPALIVES_PER_TICK)
			.map((slot) => ({ slot, expectedActivityTs: slot.lastActivityTs }));
		if (eligible.length > batch.length) {
			log.info(
				`Sending cache warming keepalive to ${batch.length} session(s); ${eligible.length - batch.length} deferred to next tick (cap ${MAX_BRIDGE_KEEPALIVES_PER_TICK})`,
			);
		} else {
			log.info(`Sending cache warming keepalive to ${batch.length} session(s)`);
		}

		// Drain the batch in bounded-concurrency chunks. Each chunk runs
		// concurrently (Promise.allSettled) so one slow upstream doesn't stall the
		// rest, with a small per-replay pre-dispatch jitter to spread replays across
		// the per-IP window. Per-replay errors are caught so one failure never
		// rejects the chunk.
		for (let i = 0; i < batch.length; i += KEEPALIVE_CONCURRENCY) {
			const chunk = batch.slice(i, i + KEEPALIVE_CONCURRENCY);
			await Promise.allSettled(
				chunk.map(async ({ slot, expectedActivityTs }) => {
					// Small decorrelation jitter (<=1s) before each dispatch to keep
					// ticks bounded while still spreading replays across the per-IP window.
					await new Promise((r) =>
						setTimeout(r, Math.random() * BRIDGE_JITTER_MAX_MS),
					);
					// replaySessionKeepalive records its own failure (including on a
					// thrown dispatch) so a zombie slot backs off and eventually evicts.
					await this.replaySessionKeepalive(slot, expectedActivityTs);
				}),
			);
		}
	}

	/**
	 * Replay a single session's warm body as a keepalive, then detect whether the
	 * prompt cache was still alive. Force-routes to the session's account and
	 * inspects the response for cache hit/miss to charge the spend budget.
	 *
	 * `expectedActivityTs` is the slot's lastActivityTs captured at batch-selection
	 * time. If a real request touched the slot during the inter-dispatch jitter the
	 * stamp will have changed — the session is active again, so we skip the replay
	 * entirely. The same stamp is threaded into outcome recording so a touch that
	 * lands AFTER dispatch (mid-flight) is also dropped by the store.
	 */
	private async replaySessionKeepalive(
		slot: SessionCacheSlot,
		expectedActivityTs: number,
	): Promise<void> {
		if (slot.lastActivityTs !== expectedActivityTs) {
			// A real request touched this slot between batch selection and now — it's
			// no longer idle, so don't send a keepalive for the stale idle period.
			return;
		}
		try {
			await this.dispatchSessionKeepalive(slot, expectedActivityTs);
		} catch (error) {
			// A thrown dispatch (network/exception) is a failed keepalive: back the
			// slot off and count it toward eviction so a persistently broken account
			// doesn't leave a zombie slot re-attempted every tick.
			log.error(
				`Error replaying cache warming keepalive for ${slot.accountId}:${slot.sessionKey}:`,
				error,
			);
			sessionCacheStore.recordKeepaliveFailure(
				slot.accountId,
				slot.sessionKey,
				Date.now(),
				expectedActivityTs,
			);
		}
	}

	/**
	 * Build and dispatch the keepalive replay, then charge the hit/miss outcome.
	 * On a non-ok response it records a failure (backoff + eventual eviction); a
	 * thrown error is handled by the caller {@link replaySessionKeepalive}.
	 */
	private async dispatchSessionKeepalive(
		slot: SessionCacheSlot,
		dispatchedActivityTs: number,
	): Promise<void> {
		// Reconstruct headers from the stored snapshot. Auth and internal proxy
		// headers were stripped at capture time and are injected fresh here.
		const replayHeaders = new Headers(slot.headers);
		replayHeaders.set("content-type", "application/json");
		replayHeaders.set("x-clankermux-account-id", slot.accountId);
		replayHeaders.set("x-clankermux-bypass-session", "true");
		// Tag as keepalive: visibility in the request logger + loop prevention
		// (the proxy skips staging synthetic keepalive replays).
		replayHeaders.set("x-clankermux-keepalive", "true");

		log.debug(
			`Replaying cache warming keepalive for ${slot.accountId}:${slot.sessionKey} (${slot.body.length} bytes)`,
		);

		// Patch max_tokens to 1 to minimize quota consumption — the keepalive only
		// needs to warm the cache. Do NOT touch tools/tool_choice: altering the
		// cached prefix would guarantee a cache miss. Invalid JSON → send as-is.
		let bodyToSend: BodyInit = new Uint8Array(slot.body);
		try {
			const bodyJson = JSON.parse(new TextDecoder().decode(slot.body));
			if (typeof bodyJson === "object" && bodyJson !== null) {
				bodyJson.max_tokens = 1;
				bodyToSend = JSON.stringify(bodyJson);
			}
		} catch {
			// Body isn't valid JSON — skip patching and use original.
		}

		// Dispatch in-process through the proxy pipeline. The URL is only for
		// handleProxy's parsing — routing is driven by x-clankermux-account-id.
		const url = new URL(`http://internal.clankermux${slot.path}`);
		const req = new Request(url, {
			method: "POST",
			headers: replayHeaders,
			body: bodyToSend,
		});
		const response = await dispatchProxyRequest(
			req,
			url,
			this.proxyContext,
			null,
			null,
			true,
		);

		const text = await response.text().catch(() => "");

		if (!response.ok) {
			// A 429/5xx is neither a consumed keepalive nor a proven cache miss —
			// don't charge it against the budget. But it IS a failed keepalive: a
			// non-routable force-route (deleted/manual-paused/failure-paused account)
			// resolves to no account and returns non-ok, so record the failure to
			// back the slot off and evict it after MAX_KEEPALIVE_FAILURES — otherwise
			// the slot stays perpetually due and is re-attempted every tick.
			log.warn(
				`Cache warming keepalive returned ${response.status} for ${slot.accountId}:${slot.sessionKey}`,
			);
			sessionCacheStore.recordKeepaliveFailure(
				slot.accountId,
				slot.sessionKey,
				Date.now(),
				dispatchedActivityTs,
			);
			return;
		}

		// created > 0 means the cached prefix had to be re-created → the cache had
		// already died → a miss (≈ whole budget). created === 0 → still warm (hit).
		// created === null (no field, e.g. unexpected body) is treated as a hit so
		// the small read cost is charged rather than the large miss cost.
		const created = extractCacheCreationTokens(text);
		const hit = created === null || created === 0;
		sessionCacheStore.recordKeepaliveResult(
			slot.accountId,
			slot.sessionKey,
			hit,
			Date.now(),
			dispatchedActivityTs,
		);
		if (created != null && created > 0) {
			log.info(
				`Cache warming ${slot.accountId}:${slot.sessionKey} cache MISS — expired (cache_creation=${created}), spend exhausted`,
			);
		}
	}
}
