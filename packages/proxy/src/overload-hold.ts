import { Logger } from "@clankermux/logger";
import { createKeyedSemaphore } from "./keyed-semaphore";

const log = new Logger("OverloadHold");

// ---------------------------------------------------------------------------
// Per-bucket concurrency semaphore for transparent overload holds.
//
// When every candidate for a request is overload-gated, proxy.ts holds the
// live client connection (bounded) instead of bouncing a synthetic 529 — but
// an incident affects MANY concurrent requests at once, and every holder pins
// a connection plus a wake-up attempt against the recovering upstream. The cap
// bounds how many requests may hold per overload bucket; overflow degrades to
// the immediate synthetic 529 (current pre-hold behavior).
//
// Keyed by the overload bucket key (`anthropic-upstream:haiku`,
// `anthropic-upstream`, ...) so a Haiku-only incident's holders don't consume
// the slots of an unrelated family. Backed by its OWN `keyed-semaphore.ts`
// instance — `handlers/burst-cooldown.ts` (`tryAcquireHoldSlot`) uses a
// separate instance; that counter is burst-retry-only and provider-global,
// so the two never share state.
// ---------------------------------------------------------------------------

/**
 * Module-level cap on simultaneously-held requests PER overload bucket.
 * Exported so tests that need to reason about the cap (e.g. to saturate it)
 * read the single source of truth rather than re-hardcoding the literal.
 */
export const OVERLOAD_HOLD_MAX_CONCURRENT_PER_BUCKET = 16;

/**
 * Max time (ms) proxy.ts holds a live client connection at an overload
 * terminal — every candidate overload-gated, or every attempt suppressed
 * behind an in-flight half-open probe — before falling back to the synthetic
 * 529.
 *
 * 330s, matching CW_HOLD_MAX_MS_NO_CODEX_FALLBACK. A 60s breaker cooldown
 * inside a 120s budget bought at most ONE probe opportunity: the hold's
 * `waitMs > remaining` guard refuses to start a sleep it cannot finish, so a
 * probe that re-tripped left no room for the next cooldown and the hold gave
 * up. 330s covers roughly five, which is what an intermittent upstream
 * incident (re-tripping about once a minute) actually needs.
 *
 * The ceiling is the CLIENT's request timeout, not ours: the Anthropic SDK
 * defaults to 600s, measured from request ingress rather than from
 * `holdStart`, and body buffering, selection, token refresh and the original
 * failed attempts all come out of it before the hold begins — as does the
 * response the client still has to receive afterwards. 330s keeps a real
 * margin under that; 500s would not.
 *
 * Bun's 180s socket idleTimeout is not the binding limit here: the hold
 * re-arms it on entry and every IDLE_REARM_INTERVAL_MS (150s), and each
 * re-arm grants a fresh 180s. That re-arm is a documented no-op on the
 * translated Codex `/v1/responses` path — see OVERLOAD_HOLD_MAX_MS_NO_REARM.
 */
export const OVERLOAD_HOLD_MAX_MS = 330_000;

/**
 * Hold budget for requests whose connection CANNOT be kept alive past Bun's
 * 180s base idleTimeout, i.e. the translated Codex `/v1/responses` path, where
 * `bumpIdleTimeout`'s `server.timeout(req, …)` targets a `Request` that does
 * not map to the original socket (see request-ingress.ts). There the 180s runs
 * from before the hold even starts, so it is an absolute upper bound rather
 * than a budget — holding longer would have OUR server close the connection
 * mid-hold. The Codex CLI's own `stream_idle_timeout_ms` (300s default) cannot
 * rescue a socket we already closed.
 *
 * Kept at the previous global value, which has run in production under this
 * ceiling without incident.
 */
export const OVERLOAD_HOLD_MAX_MS_NO_REARM = 120_000;

// Test-only budget override (same spirit as the injectable
// `maxConcurrentHolds` parameter below): the budget-expiry paths are
// untestable against the real 330s without it. Production never sets it.
let overloadHoldBudgetOverrideMs: number | null = null;

/**
 * Effective hold budget for this request.
 *
 * `canRearmIdleTimeout` is false for connections whose Bun idle timer we
 * cannot refresh (the translated Codex `/v1/responses` path) — those are
 * capped by the 180s socket timeout regardless of what we would like to wait,
 * so they get the shorter no-re-arm budget. A test override wins over both.
 */
export function getOverloadHoldBudgetMs(canRearmIdleTimeout = true): number {
	if (overloadHoldBudgetOverrideMs !== null)
		return overloadHoldBudgetOverrideMs;
	return canRearmIdleTimeout
		? OVERLOAD_HOLD_MAX_MS
		: OVERLOAD_HOLD_MAX_MS_NO_REARM;
}

/** Test-only override of the hold budget. Pass null to restore the default. */
export function setOverloadHoldBudgetOverrideForTests(ms: number | null): void {
	overloadHoldBudgetOverrideMs = ms;
}

const holdSlots = createKeyedSemaphore(OVERLOAD_HOLD_MAX_CONCURRENT_PER_BUCKET);

/**
 * Atomically acquire a hold slot for `bucketKey` if its current count is below
 * the cap. Returns `true` and increments on success; returns `false` (no
 * change) when the bucket is already at cap.
 *
 * `maxConcurrentHolds` is an injectable override for tests; it defaults to the
 * fixed `OVERLOAD_HOLD_MAX_CONCURRENT_PER_BUCKET` constant. Production never
 * passes it.
 */
export function tryAcquireOverloadHoldSlot(
	bucketKey: string,
	maxConcurrentHolds = OVERLOAD_HOLD_MAX_CONCURRENT_PER_BUCKET,
): boolean {
	if (!holdSlots.tryAcquire(bucketKey, maxConcurrentHolds)) {
		log.debug(
			`Overload hold slot refused for ${bucketKey}: ${holdSlots.count(bucketKey)} holder(s) at cap`,
		);
		return false;
	}
	return true;
}

/**
 * Release a previously-acquired hold slot for `bucketKey`. Never decrements
 * below 0; the map entry is dropped at 0 so an incident's keys don't
 * accumulate forever.
 */
export function releaseOverloadHoldSlot(bucketKey: string): void {
	holdSlots.release(bucketKey);
}

/**
 * Current number of held slots for `bucketKey`. For tests / observability.
 */
export function getActiveOverloadHoldCount(bucketKey: string): number {
	return holdSlots.count(bucketKey);
}

/**
 * Reset all hold-slot counters. For tests.
 */
export function resetOverloadHoldSlots(): void {
	holdSlots.reset();
}
