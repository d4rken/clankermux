import { getModelCacheRates } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import {
	DEFAULT_MIN_CACHE_TOKENS,
	hasCacheWritePremium,
	isEligibleByTokens,
	KEEPALIVE_REFRESH_1H_MS,
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
import { bridgeStats } from "./bridge-stats";
import { CACHE_REPLAY_STRIP_HEADERS } from "./cache-header-strip";
import { bodyCacheTtlIsOneHour } from "./cache-ttl-injector";

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
 *  3. A real resume turn books the warm-resume WIN (the payoff: we avoided the
 *     resume re-cache penalty) and resets the budget for the next idle period.
 *     The common resume shape reads the warm prefix AND appends a new breakpoint
 *     (cache_read>0 AND cache_creation>0), so it lands in register(), which books
 *     the win against the prior slot before replacing it. A rarer PURE read (no
 *     creation) lands in touchActivity(), which books the win and resets in place.
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
	/** Cache-write rate (USD per 1M) of the model — the 5-minute rate (1.25x input). */
	cacheWritePer1M: number;
	/**
	 * Effective cache-write rate (USD per 1M) for THIS slot's TTL — used to size the
	 * spend budget and charge miss costs. For a PROMOTED (1h-TTL) slot the real write
	 * is 2x input (vs the 5-minute 1.25x), so the budget stretches further and a miss
	 * is charged at the true recreate cost. For a non-promoted (5m-TTL) slot this
	 * equals {@link cacheWritePer1M}.
	 */
	cacheWriteEffectivePer1M: number;
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
	/** Total keepalives charged during the current idle period; resets on a real
	 * warm resume (touchActivity). */
	keepaliveCount: number;
	/**
	 * Per-slot refresh cadence (ms). A promoted session (1h-TTL cache) refreshes on
	 * the slow {@link KEEPALIVE_REFRESH_1H_MS} (~50 min) cadence; a non-promoted
	 * (default 5m-TTL) session uses {@link KEEPALIVE_REFRESH_MS} (3 min). Decided at
	 * register() time from the promotion tracker (the staged sessionKey is the real
	 * affinity key, or the never-promoted `__account__:<id>` fallback → 3 min).
	 */
	refreshMs: number;
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

	/**
	 * Set the minimum cached-token eligibility threshold (clamped to >= 0). Raising
	 * the threshold evicts any already-stored slot that no longer clears it, so a
	 * mid-session increase doesn't leave below-threshold sessions being bridged.
	 */
	setMinTokens(minTokens: number): void {
		this.minTokens =
			Number.isFinite(minTokens) && minTokens > 0 ? minTokens : 0;
		for (const [key, slot] of this.slots) {
			if (slot.cachedTokens < this.minTokens) {
				this.deleteKey(key);
			}
		}
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

		// Capture the prior slot BEFORE the reject gates / upsert below. A real cache
		// READ on this turn means the warm prefix we maintained was reused — and if we
		// spent keepalive budget keeping it warm, that is the warm-resume WIN the bridge
		// exists to produce. Book it now, before the gates can drop the slot, so a
		// genuine resume still counts even when this turn's NEW (grown) body is rejected
		// for size/min-token/premium reasons. The common resume turn carries BOTH
		// cache_read>0 and a small cache_creation>0, so onSummary routes it HERE (a pure
		// read with no creation goes through touchActivity instead). The slot is always
		// discarded later in this method (replaced on success, deleteKey'd on reject),
		// so booking here never double-counts a subsequent turn.
		const prev = this.slots.get(key);
		if (prev && cacheReadTokens > 0) {
			this.bookWarmResume(prev, cacheReadTokens);
		}

		// Token-count gate: too small to be worth bridging. Drop any stale slot.
		if (!isEligibleByTokens(cachedTokens, this.minTokens)) {
			this.deleteKey(key);
			log.debug(
				`[CacheBridge] skip session=${key} reason=below-min tokens=${cachedTokens} min=${this.minTokens}`,
			);
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
			log.debug(
				`[CacheBridge] skip session=${key} reason=no-premium model=${model ?? "?"}`,
			);
			return;
		}

		const bodyBytes = byteLengthOf(body);
		// Per-body cap: an oversized body is not stored. Drop any prior slot for
		// this key — it would now be stale relative to the new (unstored) request.
		if (bodyBytes > MAX_SESSION_BODY_BYTES) {
			this.deleteKey(key);
			log.debug(
				`[CacheBridge] Skipping session ${key}: body ${bodyBytes}B exceeds per-body cap ${MAX_SESSION_BODY_BYTES}B`,
			);
			return;
		}

		// Detach a private copy of the request bytes (used for both the stored body
		// and the TTL inspection below).
		const bytes =
			body instanceof ArrayBuffer
				? new Uint8Array(body)
				: new Uint8Array(body.buffer, body.byteOffset, body.byteLength);

		// A slot's TTL is whatever the request body ACTUALLY wrote upstream — i.e.
		// whether its ephemeral cache breakpoints carry ttl:"1h" — NOT what the
		// promotion tracker currently thinks. The proxy injects ttl:"1h" before
		// staging, so the staged body is the single source of truth: this stays in
		// lockstep with the real cache regardless of the estimate-vs-observed token
		// straddle, a mid-session minTokens change, or a client that set ttl itself.
		// A 1h cache is written at 2x input (Anthropic), NOT the 5-minute cache_write
		// rate (1.25x input) getModelCacheRates() returns — so a 1h slot uses the true
		// 1h write rate to size the budget (a larger premium → larger budget → the
		// multi-hour bridge stretches further) and to charge a miss (a recreate at 1h
		// costs 2x). A 5m slot keeps the 5-minute rate. Malformed body → 5m default.
		let isOneHour = false;
		try {
			isOneHour = bodyCacheTtlIsOneHour(
				JSON.parse(new TextDecoder().decode(bytes)),
			);
		} catch {
			// Non-JSON body — treat as the default 5m TTL.
		}

		// `prev` (captured at the top, before the gates) also drives the warm /
		// re-warm / ttl-change transition logging below. Nothing between here and the
		// upsert mutates this.slots for the key on the success path, so it's still the
		// current slot.
		const cacheWriteEffectivePer1M = isOneHour
			? rates.inputPer1M * 2
			: rates.cacheWritePer1M;

		const slot: SessionCacheSlot = {
			accountId,
			sessionKey,
			body: Buffer.from(bytes),
			headers: sanitizeHeaders(headers),
			path,
			model,
			cachedTokens,
			cacheReadPer1M: rates.cacheReadPer1M,
			cacheWritePer1M: rates.cacheWritePer1M,
			cacheWriteEffectivePer1M,
			priorityUsd: resumePenaltyUsd(
				cachedTokens,
				rates.cacheReadPer1M,
				rates.cacheWritePer1M,
			),
			budgetUsd: keepaliveBudgetUsd(
				cachedTokens,
				rates.cacheReadPer1M,
				cacheWriteEffectivePer1M,
			),
			spentUsd: 0,
			lastActivityTs: Date.now(),
			lastKeepaliveTs: null,
			keepaliveFailures: 0,
			keepaliveCount: 0,
			refreshMs: isOneHour ? KEEPALIVE_REFRESH_1H_MS : KEEPALIVE_REFRESH_MS,
		};

		// Upsert: subtract any prior slot's bytes before replacing.
		this.deleteKey(key);
		this.slots.set(key, slot);
		this.totalBytes += slot.body.byteLength;

		const ttlLabel = (ms: number): string =>
			ms === KEEPALIVE_REFRESH_1H_MS ? "1h" : "5m";
		if (!prev) {
			log.info(
				`[CacheBridge] warm session=${key} tokens=${cachedTokens} ttl=${ttlLabel(slot.refreshMs)} budgetUsd=${slot.budgetUsd.toFixed(4)} writeRate=${slot.cacheWriteEffectivePer1M}`,
			);
		} else if (prev.refreshMs !== slot.refreshMs) {
			log.info(
				`[CacheBridge] re-warm ttl-change session=${key} tokens=${cachedTokens} ttl=${ttlLabel(slot.refreshMs)} (was ${ttlLabel(prev.refreshMs)}) budgetUsd=${slot.budgetUsd.toFixed(4)} writeRate=${slot.cacheWriteEffectivePer1M}`,
			);
		} else {
			log.debug(`[CacheBridge] re-warm session=${key} tokens=${cachedTokens}`);
		}

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
	 * keepalive) for at least its per-slot {@link SessionCacheSlot.refreshMs} — 3 min
	 * for default 5m-TTL slots, ~50 min for promoted 1h-TTL slots — so a keepalive
	 * lands before the slot's prompt-cache TTL expires.
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
			if (now - lastTouch < slot.refreshMs) continue;
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
		expectedLastActivityTs?: number,
	): void {
		const key = SessionCacheStore.key(accountId, sessionKey);
		const slot = this.slots.get(key);
		if (!slot) return;
		// Stale-outcome guard: if a real request touched (touchActivity) or
		// re-registered the slot while this keepalive was in flight, lastActivityTs
		// will differ from what it was at dispatch. The fresh activity already reset
		// the budget, so charging this now-stale result would corrupt the new idle
		// period — drop it. (Omitted by direct unit tests → no guard.)
		if (
			expectedLastActivityTs !== undefined &&
			slot.lastActivityTs !== expectedLastActivityTs
		) {
			return;
		}
		// A miss re-creates the cache at THIS slot's TTL: a 1h slot's recreate costs
		// 2x input, so charge the effective write rate, not the 5-minute cache_write
		// rate. The hit cost is cache_read regardless of TTL.
		const cost = cacheHit
			? keepaliveHitCostUsd(slot.cachedTokens, slot.cacheReadPer1M)
			: keepaliveMissCostUsd(slot.cachedTokens, slot.cacheWriteEffectivePer1M);
		// Whether the spend was under budget BEFORE this charge (for the
		// budget-exhausted edge log below — log only on the crossing charge).
		const wasUnderBudget = slot.spentUsd < slot.budgetUsd;
		slot.spentUsd += cost;
		slot.lastKeepaliveTs = now;
		slot.keepaliveCount += 1;
		// A successful keepalive clears the consecutive-failure streak.
		slot.keepaliveFailures = 0;
		bridgeStats.recordResult(cacheHit, cost);
		if (cacheHit) {
			log.debug(
				`[CacheBridge] keepalive HIT session=${key} costUsd=${cost.toFixed(5)} spent=${slot.spentUsd.toFixed(4)}/${slot.budgetUsd.toFixed(4)}`,
			);
		}
		// Budget-exhaustion edge: the cache is now warm server-side but no real
		// resume has happened yet — surface the spend that didn't (yet) pay off.
		// (No MISS line here — the scheduler logs the cache_creation MISS detail.)
		if (slot.spentUsd >= slot.budgetUsd && wasUnderBudget) {
			log.info(
				`[CacheBridge] budget-exhausted session=${key} spent=${slot.spentUsd.toFixed(4)} budget=${slot.budgetUsd.toFixed(4)} keepalives=${slot.keepaliveCount} (no resume yet)`,
			);
		}
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
		expectedLastActivityTs?: number,
	): void {
		const key = SessionCacheStore.key(accountId, sessionKey);
		const slot = this.slots.get(key);
		if (!slot) return;
		// Stale-outcome guard (see recordKeepaliveResult): a real request that
		// touched/re-registered the slot mid-flight makes this failure stale — the
		// slot is healthy now, so don't back it off or count it toward eviction.
		if (
			expectedLastActivityTs !== undefined &&
			slot.lastActivityTs !== expectedLastActivityTs
		) {
			return;
		}
		bridgeStats.recordFailure();
		// Back off so the slot isn't immediately due again on the next tick.
		slot.lastKeepaliveTs = now;
		slot.keepaliveFailures += 1;
		if (slot.keepaliveFailures >= MAX_KEEPALIVE_FAILURES) {
			log.debug(
				`[CacheBridge] evicting session=${key} after ${slot.keepaliveFailures} consecutive keepalive failures`,
			);
			this.deleteKey(key);
		}
	}

	/**
	 * Book a warm-resume WIN for a slot whose maintained warm prefix was just re-read
	 * by a real request — the payoff the bridge exists to produce. Only counts when we
	 * actually spent keepalive budget on this slot (`spentUsd > 0`); a normal active
	 * turn that never went idle spent nothing and books nothing. Valued at the slot's
	 * ACTUAL TTL write rate (`cacheWriteEffectivePer1M` — a 1h slot would have cost 2x
	 * input to recreate, not the 5-minute rate the LRU `priorityUsd` deliberately
	 * keeps) times the prefix tokens actually re-read, capped at the slot's stored
	 * cached-token count so we never attribute reads beyond the prefix we maintained.
	 * Does NOT mutate the slot — callers own the lifecycle (register replaces it,
	 * touchActivity resets it).
	 */
	private bookWarmResume(slot: SessionCacheSlot, readTokens: number): void {
		if (slot.spentUsd <= 0) return;
		const tokens =
			readTokens > 0
				? Math.min(readTokens, slot.cachedTokens)
				: slot.cachedTokens;
		const savedUsd =
			((slot.cacheWriteEffectivePer1M - slot.cacheReadPer1M) / 1_000_000) *
			tokens;
		bridgeStats.recordWarmResume(savedUsd);
		log.info(
			`[CacheBridge] warm-resume WIN session=${SessionCacheStore.key(slot.accountId, slot.sessionKey)} savedUsd=${savedUsd.toFixed(4)} spentUsd=${slot.spentUsd.toFixed(4)} netUsd=${(savedUsd - slot.spentUsd).toFixed(4)} keepalives=${slot.keepaliveCount}`,
		);
	}

	/**
	 * Mark a session as freshly active on a confirmed PURE cache-READ turn (a real
	 * request that HIT the cache without re-creating any of it). Cache-read turns prove
	 * the prompt cache is still warm, so we bump lastActivityTs (the session is
	 * not idle) and RESET the spend budget (spentUsd, lastKeepaliveTs) — a real
	 * hit restores full confidence the same way a fresh cache-CREATING request
	 * does, so the session can bridge again through the next idle period. A warm
	 * resume is booked first via {@link bookWarmResume}. (The common resume turn that
	 * ALSO creates cache is booked in {@link register} instead — it carries
	 * cache_creation>0, so onSummary routes it there, not here.)
	 *
	 * `readTokens` is the cache_read token count for this turn (the prefix actually
	 * re-read); 0/omitted falls back to the slot's full stored cached-token count.
	 *
	 * No-op when no slot exists for the key: only cache-CREATING requests
	 * establish a slot, so a read-only session we never stored stays unstored
	 * (we don't have a warm body to replay for it). We also do NOT replace the
	 * stored body — the last cache-creating body is still a valid warm prefix,
	 * and re-copying it every read turn would churn memory for no benefit.
	 */
	touchActivity(
		accountId: string,
		sessionKey: string,
		now: number,
		readTokens = 0,
	): void {
		const key = SessionCacheStore.key(accountId, sessionKey);
		const slot = this.slots.get(key);
		if (!slot) return;
		this.bookWarmResume(slot, readTokens);
		slot.lastActivityTs = now;
		slot.spentUsd = 0;
		slot.lastKeepaliveTs = null;
		slot.keepaliveCount = 0;
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

	/** Number of warm slots on the 1h-TTL (promoted) refresh cadence. */
	getPromotedSessions(): number {
		let count = 0;
		for (const slot of this.slots.values()) {
			if (slot.refreshMs === KEEPALIVE_REFRESH_1H_MS) count++;
		}
		return count;
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
