import type { CacheWarmingMode } from "@clankermux/config";
import { Logger } from "@clankermux/logger";
import {
	DESTICK_AFTER_ACTIVE_TURNS,
	IDLE_GAP_FOR_PROMOTION_MS,
	MAX_PROMOTION_TRACKER_ENTRIES,
	PROMOTE_AFTER_TURNS,
} from "./bridge-policy";

const log = new Logger("SessionPromotion");

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
 * MODE-AWARE promotion policy:
 *   - `off`: tracker is inert (observe → false, isPromoted → false), state cleared.
 *   - `static`: a session is promoted (and stays promoted, sticky) as soon as its
 *     estimated context clears the configured min-token threshold.
 *   - `dynamic`: HYBRID predictive promotion — a session becomes promoted once
 *     EITHER it is "established" (>= {@link PROMOTE_AFTER_TURNS} turns) OR it has
 *     shown an idle gap (>= {@link IDLE_GAP_FOR_PROMOTION_MS}). In dynamic mode a
 *     promoted session is DE-STICKED — demoted back to the cheap 5m TTL — after
 *     {@link DESTICK_AFTER_ACTIVE_TURNS} consecutive non-idle (actively-worked)
 *     turns, because the 1h write premium is being paid with no idle benefit. A
 *     fresh idle gap re-promotes it; the establish-by-turns trigger only fires
 *     once per session (the {@link PromotionEntry.establishedOnce} latch).
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
	/** Whether this session is currently promoted to 1h TTL. */
	promoted: boolean;
	/** Latch: set once the session has been promoted at least once. Gates the
	 * dynamic establish-by-turns trigger so a de-sticked session doesn't
	 * immediately re-promote on turn count alone — only a fresh idle gap can. */
	establishedOnce: boolean;
	/** Count of consecutive non-idle turns while promoted (dynamic de-stick). */
	activeStreak: number;
}

class SessionPromotionTracker {
	private mode: CacheWarmingMode = "off";
	private readonly entries = new Map<string, PromotionEntry>();

	/**
	 * Set the operating mode. Switching to "off" clears all state; while off,
	 * observe/isPromoted are no-ops (observe returns false, isPromoted false).
	 */
	setMode(mode: CacheWarmingMode): void {
		this.mode = mode;
		if (mode === "off") {
			this.entries.clear();
		}
	}

	/**
	 * Back-compat alias for callers that still toggle the tracker as a boolean
	 * (true → dynamic, false → off).
	 */
	setEnabled(enabled: boolean): void {
		this.setMode(enabled ? "dynamic" : "off");
	}

	/**
	 * Record a turn for `sessionKey` and decide whether to inject 1h TTL on this
	 * request. Updates turn count, idle-gap, promotion (mode-dependent), and
	 * lastSeenTs, then enforces the size cap. Returns
	 * `promoted && estimatedTokens >= minTokens`. No-op returning false when off.
	 */
	observeAndShouldInject(
		sessionKey: string,
		now: number,
		estimatedTokens: number,
		minTokens: number,
	): boolean {
		if (this.mode === "off") return false;

		const existing = this.entries.get(sessionKey);
		const turnCount = (existing?.turnCount ?? 0) + 1;
		const gap = existing ? now - existing.lastSeenTs : 0;

		if (this.mode === "static") {
			const eligible = estimatedTokens >= minTokens;
			const wasPromoted = existing?.promoted ?? false;
			const promoted = wasPromoted || eligible;
			if (promoted && !wasPromoted) {
				log.debug(
					`[CacheBridge] promote session=${sessionKey} mode=static turnCount=${turnCount}`,
				);
			}
			// Re-insert (delete first) so Map iteration order reflects recency for the
			// cap's LRU eviction; lastSeenTs is the authoritative recency key.
			this.entries.delete(sessionKey);
			this.entries.set(sessionKey, {
				turnCount,
				lastSeenTs: now,
				promoted,
				establishedOnce: existing?.establishedOnce ?? promoted,
				activeStreak: 0,
			});
			this.enforceCap();
			return promoted;
		}

		// dynamic mode
		let promoted = existing?.promoted ?? false;
		let establishedOnce = existing?.establishedOnce ?? false;
		let activeStreak = existing?.activeStreak ?? 0;
		const idle = existing ? gap >= IDLE_GAP_FOR_PROMOTION_MS : false;

		if (promoted) {
			if (idle) {
				activeStreak = 0;
			} else {
				activeStreak += 1;
				if (activeStreak >= DESTICK_AFTER_ACTIVE_TURNS) {
					promoted = false;
					activeStreak = 0;
					log.info(
						`[CacheBridge] de-stick session=${sessionKey} activeStreak=${DESTICK_AFTER_ACTIVE_TURNS} turnCount=${turnCount}`,
					);
				}
			}
		} else {
			const establish = !establishedOnce && turnCount >= PROMOTE_AFTER_TURNS;
			if (idle || establish) {
				promoted = true;
				establishedOnce = true;
				activeStreak = 0;
				const trigger = idle ? "idle" : "turns";
				log.info(
					`[CacheBridge] promote session=${sessionKey} trigger=${trigger} turnCount=${turnCount} gap=${gap}ms mode=dynamic`,
				);
			}
		}

		this.entries.delete(sessionKey);
		this.entries.set(sessionKey, {
			turnCount,
			lastSeenTs: now,
			promoted,
			establishedOnce,
			activeStreak,
		});
		this.enforceCap();

		return promoted && estimatedTokens >= minTokens;
	}

	/** The promoted flag for a session (false if absent or off). */
	isPromoted(sessionKey: string): boolean {
		if (this.mode === "off") return false;
		return this.entries.get(sessionKey)?.promoted ?? false;
	}

	/** Number of currently-promoted sessions. */
	getPromotedCount(): number {
		let count = 0;
		for (const entry of this.entries.values()) {
			if (entry.promoted) count++;
		}
		return count;
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
