import { getModelCacheRates } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import {
	DEFAULT_MIN_CACHE_TOKENS,
	hasCacheWritePremium,
	isEligibleByTokens,
	KEEPALIVE_REFRESH_MS,
	keepaliveBudgetUsd,
	keepaliveHitCostUsd,
	keepaliveMissCostUsd,
	MAX_KEEPALIVE_FAILURES,
	MAX_SESSION_BODY_BYTES,
	MAX_SESSION_BRIDGE_BYTES,
	MAX_SESSION_SLOTS,
	resumePenaltyUsd,
} from "./bridge-policy";
import { CACHE_REPLAY_STRIP_HEADERS } from "./cache-header-strip";

const log = new Logger("SessionCacheStore");

/**
 * In-memory, per-SESSION warm-body store for the Session Cache Bridge.
 *
 * This is the per-session analogue of {@link CacheBodyStore} (cache-body-store.ts),
 * which keeps ONE last-cached-request body per account. This store keeps one body
 * per (account, session) pair, so multiple idle Claude Code / Codex sessions on
 * the same account each stay warm independently.
 *
 * Flow:
 *  1. After a real request finalizes with prompt-cache usage, the proxy calls
 *     register() with the original (pre-transform) client body + headers and the
 *     observed cache_read / cache_creation token counts. register() gates on a
 *     real cache-WRITE premium (so OpenAI/Codex/zai are skipped — bridging is a
 *     net loss without a write premium to avoid) AND a minimum cached-token
 *     count, then computes a per-session SPEND BUDGET.
 *  2. The keepalive scheduler reads getEligibleSessions() at tick time, dispatches
 *     a keepalive replay for the most valuable due sessions, then calls
 *     recordKeepaliveResult() to charge the hit/miss cost against the budget.
 *  3. A real cache-read turn calls touchActivity() to reset the budget for the
 *     next idle period (a real hit proves the cache is warm).
 *
 * Spend-budget model (see bridge-policy.ts): each keepalive charges its hit or
 * miss cost to spentUsd; a session stays eligible while spentUsd < budgetUsd.
 * ~4-5 hits fit the budget; a single miss ≈ the whole budget (so a miss stops
 * further keepalives — it has already re-warmed the cache server-side).
 *
 * Memory bounds (cf. oven-sh/bun#5709 — off-heap buffers the allocator never
 * returns while still referenced, so every stored body must be deliberately
 * bounded):
 *  - Slot count: hard cap of {@link MAX_SESSION_SLOTS}. Over the cap, the
 *    lowest-priority slot (least USD avoided) is evicted first.
 *  - Total bytes: {@link MAX_SESSION_BRIDGE_BYTES} across all stored bodies,
 *    enforced by the same lowest-priority-first eviction.
 *  - Per-body cap: {@link MAX_SESSION_BODY_BYTES} — a larger body is not stored
 *    (and removes any stale slot for that key). Bodies are typically 0.5–1.5 MB.
 *  Each body is copied with Buffer.from(...) to detach it from the (potentially
 *  larger) source ArrayBuffer and keep only the bytes we need.
 *
 * Note: client headers ARE stored (sanitized) because some providers copy
 * incoming headers in prepareHeaders() and augment them, so the keepalive replay
 * needs the original client headers to produce an identical upstream request.
 * Sensitive and internal headers are stripped before storing.
 */

export interface SessionCacheSlot {
	accountId: string;
	sessionKey: string;
	/** Detached copy of the original client request body (pre-transform). */
	body: Buffer;
	/** Sanitized original client headers (no auth, no internal proxy headers). */
	headers: Record<string, string>;
	/** Request path, e.g. "/v1/messages". */
	path: string;
	/** Model id observed on the real request (undefined if not parsed). */
	model: string | undefined;
	/** cacheRead + cacheCreation tokens observed on the real request. */
	cachedTokens: number;
	/** Cache-read rate (USD per 1M) of the model — used to charge hit costs. */
	cacheReadPer1M: number;
	/** Cache-write rate (USD per 1M) of the model — used to charge miss costs. */
	cacheWritePer1M: number;
	/** resumePenaltyUsd — LRU priority (higher = keep). */
	priorityUsd: number;
	/** Derated keepalive spend budget in USD; bridging stops at spentUsd >= this. */
	budgetUsd: number;
	/** Accumulated keepalive spend in USD for the current idle period. */
	spentUsd: number;
	/** Last real-request finalize time (ms epoch). */
	lastActivityTs: number;
	/** Last keepalive dispatch time, or null if none sent yet. */
	lastKeepaliveTs: number | null;
	/** Consecutive non-routable/failed keepalive attempts; resets on success. */
	keepaliveFailures: number;
}

function sanitizeHeaders(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, key) => {
		if (!CACHE_REPLAY_STRIP_HEADERS.has(key.toLowerCase())) {
			out[key] = value;
		}
	});
	return out;
}

function byteLengthOf(body: ArrayBuffer | ArrayBufferView): number {
	return body.byteLength;
}

export interface RegisterSessionParams {
	accountId: string;
	sessionKey: string;
	body: ArrayBuffer | ArrayBufferView;
	headers: Headers;
	path: string;
	model: string | undefined;
	cacheReadTokens: number;
	cacheCreationTokens: number;
}

class SessionCacheStore {
	/** "${accountId}:${sessionKey}" → slot. */
	private slots = new Map<string, SessionCacheSlot>();

	/** Running total of stored body bytes (kept in lockstep with slots). */
	private totalBytes = 0;

	/** Whether the feature is enabled — register is a no-op when false. */
	private enabled = false;

	/** Minimum cached-token count for a session to be worth bridging. */
	private minTokens = DEFAULT_MIN_CACHE_TOKENS;

	private static key(accountId: string, sessionKey: string): string {
		return `${accountId}:${sessionKey}`;
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) {
			this.clear();
		}
	}

	/** Set the minimum cached-token eligibility threshold (clamped to >= 0). */
	setMinTokens(minTokens: number): void {
		this.minTokens =
			Number.isFinite(minTokens) && minTokens > 0 ? minTokens : 0;
	}

	/**
	 * Record (or refresh) a session's warm body after a real cache-using request
	 * finalized. Gates on a real cache-WRITE premium and the minimum cached-token
	 * count; a fresh real request RESETS the spend budget for that session. No-op
	 * when disabled.
	 */
	register(params: RegisterSessionParams): void {
		if (!this.enabled) return;

		const {
			accountId,
			sessionKey,
			body,
			headers,
			path,
			model,
			cacheReadTokens,
			cacheCreationTokens,
		} = params;

		const key = SessionCacheStore.key(accountId, sessionKey);
		const cachedTokens = cacheReadTokens + cacheCreationTokens;

		// Token-count gate: too small to be worth bridging. Drop any stale slot.
		if (!isEligibleByTokens(cachedTokens, this.minTokens)) {
			this.deleteKey(key);
			return;
		}

		// Provider economic gate: no cache-write premium → bridging is a net loss
		// (this skips zai/GLM, whose cache_write is 0). Drop any stale slot for the
		// key.
		//
		// NOTE: this gate is the SECOND of two. The first is upstream in
		// cache-body-store.stageRequest(), which only stages requests carrying a
		// `cache_control` hint — i.e. explicit-breakpoint providers (Anthropic).
		// Automatic-cache providers (OpenAI/Codex) never send `cache_control`, so
		// they never reach register() at all. That matters because
		// getModelCacheRates() returns a Sonnet-rate FALLBACK for unknown model
		// ids: a brand-new (real) Anthropic model still bridges correctly, but a
		// hypothetical non-Anthropic provider that DID send `cache_control` with an
		// unrecognized id would wrongly pass this premium check. The staging gate is
		// what actually excludes such providers today — keep both in lockstep.
		const rates = getModelCacheRates(model ?? "");
		if (!hasCacheWritePremium(rates.cacheReadPer1M, rates.cacheWritePer1M)) {
			this.deleteKey(key);
			return;
		}

		const bodyBytes = byteLengthOf(body);
		// Per-body cap: an oversized body is not stored. Drop any prior slot for
		// this key — it would now be stale relative to the new (unstored) request.
		if (bodyBytes > MAX_SESSION_BODY_BYTES) {
			this.deleteKey(key);
			log.debug(
				`Skipping session ${key}: body ${bodyBytes}B exceeds per-body cap ${MAX_SESSION_BODY_BYTES}B`,
			);
			return;
		}

		const slot: SessionCacheSlot = {
			accountId,
			sessionKey,
			body: Buffer.from(
				body instanceof ArrayBuffer
					? new Uint8Array(body)
					: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
			),
			headers: sanitizeHeaders(headers),
			path,
			model,
			cachedTokens,
			cacheReadPer1M: rates.cacheReadPer1M,
			cacheWritePer1M: rates.cacheWritePer1M,
			priorityUsd: resumePenaltyUsd(
				cachedTokens,
				rates.cacheReadPer1M,
				rates.cacheWritePer1M,
			),
			budgetUsd: keepaliveBudgetUsd(
				cachedTokens,
				rates.cacheReadPer1M,
				rates.cacheWritePer1M,
			),
			spentUsd: 0,
			lastActivityTs: Date.now(),
			lastKeepaliveTs: null,
			keepaliveFailures: 0,
		};

		// Upsert: subtract any prior slot's bytes before replacing.
		this.deleteKey(key);
		this.slots.set(key, slot);
		this.totalBytes += slot.body.byteLength;

		this.enforceBounds();
	}

	/**
	 * Evict lowest-priority-first until both the slot cap and the total byte budget
	 * are satisfied. Tiebreak on oldest lastActivityTs.
	 */
	private enforceBounds(): void {
		let evicted = 0;
		while (
			this.slots.size > MAX_SESSION_SLOTS ||
			this.totalBytes > MAX_SESSION_BRIDGE_BYTES
		) {
			let victim: SessionCacheSlot | null = null;
			let victimKey: string | null = null;
			for (const [k, slot] of this.slots) {
				if (
					victim === null ||
					slot.priorityUsd < victim.priorityUsd ||
					(slot.priorityUsd === victim.priorityUsd &&
						slot.lastActivityTs < victim.lastActivityTs)
				) {
					victim = slot;
					victimKey = k;
				}
			}
			if (victimKey === null) break; // map empty — defensive
			this.deleteKey(victimKey);
			evicted++;
		}
		if (evicted > 0) {
			log.debug(
				`Evicted ${evicted} session slot(s) to honor bounds (size=${this.slots.size}, bytes=${this.totalBytes})`,
			);
		}
	}

	/** Delete a slot by composite key, keeping totalBytes in lockstep. */
	private deleteKey(key: string): void {
		const existing = this.slots.get(key);
		if (existing) {
			this.totalBytes -= existing.body.byteLength;
			this.slots.delete(key);
		}
	}

	/**
	 * Sessions worth keepalive-ing right now, most valuable first.
	 *
	 * A slot is eligible iff it has a positive budget, has not yet exhausted that
	 * budget (spentUsd < budgetUsd), and has been untouched (no real activity or
	 * keepalive) for at least {@link KEEPALIVE_REFRESH_MS} — so a keepalive lands
	 * before Anthropic's 5-min cache TTL expires.
	 */
	getEligibleSessions(now: number): SessionCacheSlot[] {
		const eligible: SessionCacheSlot[] = [];
		for (const slot of this.slots.values()) {
			if (slot.budgetUsd <= 0) continue;
			if (slot.spentUsd >= slot.budgetUsd) continue;
			const lastTouch = Math.max(
				slot.lastActivityTs,
				slot.lastKeepaliveTs ?? 0,
			);
			if (now - lastTouch < KEEPALIVE_REFRESH_MS) continue;
			eligible.push(slot);
		}

		eligible.sort((a, b) => b.priorityUsd - a.priorityUsd);
		return eligible;
	}

	/**
	 * Charge the outcome of a keepalive against the session's spend budget. A HIT
	 * costs cache_read × prefix; a MISS costs cache_write × prefix (≈ the whole
	 * budget, so a miss exhausts it in one shot — at which point the cache has
	 * already been re-created warm server-side, so we simply stop bridging it).
	 */
	recordKeepaliveResult(
		accountId: string,
		sessionKey: string,
		cacheHit: boolean,
		now: number,
	): void {
		const slot = this.slots.get(SessionCacheStore.key(accountId, sessionKey));
		if (!slot) return;
		const cost = cacheHit
			? keepaliveHitCostUsd(slot.cachedTokens, slot.cacheReadPer1M)
			: keepaliveMissCostUsd(slot.cachedTokens, slot.cacheWritePer1M);
		slot.spentUsd += cost;
		slot.lastKeepaliveTs = now;
		// A successful keepalive clears the consecutive-failure streak.
		slot.keepaliveFailures = 0;
	}

	/**
	 * Record a FAILED keepalive (non-routable force-route, non-ok response, or a
	 * thrown dispatch). Backs the slot off so it isn't immediately due again
	 * (lastKeepaliveTs = now) and increments the consecutive-failure counter. Once
	 * {@link MAX_KEEPALIVE_FAILURES} consecutive failures accumulate, the slot is
	 * evicted: the account is gone or persistently paused, so re-attempting it
	 * every tick only wastes the per-tick cap and crowds out healthy sessions.
	 * No-op when no slot exists for the key.
	 */
	recordKeepaliveFailure(
		accountId: string,
		sessionKey: string,
		now: number,
	): void {
		const key = SessionCacheStore.key(accountId, sessionKey);
		const slot = this.slots.get(key);
		if (!slot) return;
		// Back off so the slot isn't immediately due again on the next tick.
		slot.lastKeepaliveTs = now;
		slot.keepaliveFailures += 1;
		if (slot.keepaliveFailures >= MAX_KEEPALIVE_FAILURES) {
			this.deleteKey(key);
		}
	}

	/**
	 * Mark a session as freshly active on a confirmed cache-READ turn (a real
	 * request that HIT the cache without re-creating it). Cache-read turns prove
	 * the prompt cache is still warm, so we bump lastActivityTs (the session is
	 * not idle) and RESET the spend budget (spentUsd, lastKeepaliveTs) — a real
	 * hit restores full confidence the same way a fresh cache-CREATING request
	 * does, so the session can bridge again through the next idle period.
	 *
	 * No-op when no slot exists for the key: only cache-CREATING requests
	 * establish a slot, so a read-only session we never stored stays unstored
	 * (we don't have a warm body to replay for it). We also do NOT replace the
	 * stored body — the last cache-creating body is still a valid warm prefix,
	 * and re-copying it every read turn would churn memory for no benefit.
	 */
	touchActivity(accountId: string, sessionKey: string, now: number): void {
		const slot = this.slots.get(SessionCacheStore.key(accountId, sessionKey));
		if (!slot) return;
		slot.lastActivityTs = now;
		slot.spentUsd = 0;
		slot.lastKeepaliveTs = null;
	}

	/** Remove all slots belonging to an account (e.g. account deleted). */
	evictAccount(accountId: string): void {
		for (const [key, slot] of this.slots) {
			if (slot.accountId === accountId) {
				this.totalBytes -= slot.body.byteLength;
				this.slots.delete(key);
			}
		}
	}

	getSize(): number {
		return this.slots.size;
	}

	getTotalBytes(): number {
		return this.totalBytes;
	}

	getAllSlots(): SessionCacheSlot[] {
		return Array.from(this.slots.values());
	}

	clear(): void {
		this.slots.clear();
		this.totalBytes = 0;
	}
}

export const sessionCacheStore = new SessionCacheStore();
