import {
	IDLE_GAP_FOR_PROMOTION_MS,
	MAX_PROMOTION_TRACKER_ENTRIES,
	PROMOTE_AFTER_TURNS,
} from "./bridge-policy";

/**
 * Request-time predictive 1-hour-TTL promotion tracker (Phase 2 of the Session
 * Cache Bridge).
 *
 * Anthropic's prompt cache TTL is chosen at WRITE time (`cache_control.ttl`).
 * Phase 1 keepalives only bridge the default 5-min TTL (~15 min of practical
 * coverage). To bridge an idle-prone large session for HOURS we must PREDICT,
 * before the session goes idle, that it's worth paying the 1h-write premium (2×
 * input vs 1.25× for 5m) and inject `ttl:"1h"` on its cache breakpoints.
 *
 * The decision is per-SESSION (keyed by the affinity/session key —
 * `x-claude-code-session-id` / Codex thread-id), evaluated at request arrival
 * BEFORE account selection, so it's independent of which account serves it.
 *
 * HYBRID promotion policy: a session becomes promoted (sticky, never un-set)
 * once EITHER
 *   - it is "established": >= {@link PROMOTE_AFTER_TURNS} cache-relevant turns
 *     (a long-lived session is likely to be juggled / left idle), OR
 *   - it has shown an idle gap: >= {@link IDLE_GAP_FOR_PROMOTION_MS} between two
 *     consecutive turns (it's drifting toward the 5-min expiry).
 * Injection only happens when the session is promoted AND its estimated context
 * size clears the configured min-token threshold (small sessions aren't worth
 * the 1h write premium).
 *
 * MEMORY BOUND: only tiny per-session metadata is held (no request bodies),
 * capped at {@link MAX_PROMOTION_TRACKER_ENTRIES}; over cap the entry with the
 * oldest `lastSeenTs` is LRU-evicted.
 */

interface PromotionEntry {
	/** Count of cache-relevant turns observed for this session. */
	turnCount: number;
	/** Timestamp (ms) of the most recent observed turn. */
	lastSeenTs: number;
	/** Sticky: once true, stays true for the life of the entry. */
	promoted: boolean;
}

class SessionPromotionTracker {
	private enabled = true;
	private readonly entries = new Map<string, PromotionEntry>();

	/**
	 * Enable/disable the tracker. Disabling clears all state; while disabled,
	 * observe/isPromoted are no-ops (observe returns false, isPromoted false).
	 */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) {
			this.entries.clear();
		}
	}

	/**
	 * Record a turn for `sessionKey` and decide whether to inject 1h TTL on this
	 * request. Updates turn count, idle-gap, sticky promotion, and lastSeenTs,
	 * then enforces the size cap. Returns `promoted && estimatedTokens >= minTokens`.
	 * No-op returning false when disabled.
	 */
	observeAndShouldInject(
		sessionKey: string,
		now: number,
		estimatedTokens: number,
		minTokens: number,
	): boolean {
		if (!this.enabled) return false;

		const existing = this.entries.get(sessionKey);
		const turnCount = (existing?.turnCount ?? 0) + 1;
		const gap = existing ? now - existing.lastSeenTs : 0;
		const promoted =
			(existing?.promoted ?? false) ||
			turnCount >= PROMOTE_AFTER_TURNS ||
			gap >= IDLE_GAP_FOR_PROMOTION_MS;

		// Re-insert (delete first) so Map iteration order reflects recency for the
		// cap's LRU eviction; lastSeenTs is the authoritative recency key.
		this.entries.delete(sessionKey);
		this.entries.set(sessionKey, { turnCount, lastSeenTs: now, promoted });
		this.enforceCap();

		return promoted && estimatedTokens >= minTokens;
	}

	/** The sticky promoted flag for a session (false if absent or disabled). */
	isPromoted(sessionKey: string): boolean {
		if (!this.enabled) return false;
		return this.entries.get(sessionKey)?.promoted ?? false;
	}

	/** Drop a single session's entry. */
	evict(sessionKey: string): void {
		this.entries.delete(sessionKey);
	}

	/** Number of tracked sessions. */
	getSize(): number {
		return this.entries.size;
	}

	/** Drop all tracked sessions. */
	clear(): void {
		this.entries.clear();
	}

	/** Evict the entry with the oldest lastSeenTs while over the cap. */
	private enforceCap(): void {
		while (this.entries.size > MAX_PROMOTION_TRACKER_ENTRIES) {
			let oldestKey: string | null = null;
			let oldestTs = Number.POSITIVE_INFINITY;
			for (const [key, entry] of this.entries) {
				if (entry.lastSeenTs < oldestTs) {
					oldestTs = entry.lastSeenTs;
					oldestKey = key;
				}
			}
			if (oldestKey === null) break;
			this.entries.delete(oldestKey);
		}
	}
}

/** Singleton request-time promotion tracker. */
export const sessionPromotionTracker = new SessionPromotionTracker();
