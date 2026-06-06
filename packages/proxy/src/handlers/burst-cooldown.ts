import { Logger } from "@clankermux/logger";

const log = new Logger("BurstCooldown");

// Transparent burst-429 retry tuning constants owned by this module (the marker
// + the hold-slot semaphore). Fixed, source-level defaults — the feature is
// unconditionally on and not env-configurable.

/**
 * Lifetime (ms) of the shared burst marker that suppresses sibling diversion.
 *
 * Sized to cover (≥) a SINGLE transparent-retry hold budget
 * (`BURST_RETRY_MAX_HOLD_MS = 120_000` in transparent-retry.ts). A request that
 * holds its cache account for the full budget must keep the marker live for the
 * whole hold, so concurrent affinity requests keep holding their own cache
 * accounts (sibling diversion suppressed) rather than seeing the marker lapse
 * mid-storm and diverting. If you change the hold budget, change this in step.
 */
const BURST_RETRY_MARKER_MS = 120_000;
/**
 * Module-level cap on simultaneously-held requests. Exported so callers/tests
 * that need to reason about the cap (e.g. to saturate it) read the single
 * source of truth rather than re-hardcoding the literal.
 */
export const BURST_RETRY_MAX_CONCURRENT_HOLDS = 8;

// ---------------------------------------------------------------------------
// Shared Anthropic-OAuth burst marker.
//
// The Anthropic 429 we hold for is a per-IP burst throttle (a burst of 4+
// simultaneous requests trips Anthropic's per-IP limit and 429s every account
// at the same instant). Because the throttle is provider-wide — not
// per-account — a SINGLE marker for the whole Anthropic-OAuth family is
// sufficient; we deliberately do NOT key per-account.
//
// While the marker is active, OAuth-Anthropic-affinity requests should hold
// their own cache account and re-probe it, NOT divert to a sibling Anthropic
// account (the sibling shares the same egress IP and is throttled by the same
// window; diverting is futile and re-pays the per-account prompt cache).
//
// Modeled on `provider-overload-cooldown.ts` (the `anthropic-upstream` 529
// mechanism): module-level state, `Date.now()` default for `now`, lazy expiry
// on read, and a `clear*` reset for tests.
// ---------------------------------------------------------------------------

// Single provider-family marker (no per-account keying — see note above).
let anthropicBurstThrottleUntil: number | null = null;

/**
 * Mark the Anthropic per-IP burst throttle as active until
 * `now + BURST_RETRY_MARKER_MS`. Extends (never shortens) an existing marker.
 *
 * `markerMs` is an injectable override for tests; it defaults to the fixed
 * `BURST_RETRY_MARKER_MS` constant. Production never passes it.
 */
export function markAnthropicBurstThrottle(
	now = Date.now(),
	markerMs = BURST_RETRY_MARKER_MS,
): void {
	const until = now + markerMs;
	const previous =
		anthropicBurstThrottleUntil && anthropicBurstThrottleUntil > now
			? anthropicBurstThrottleUntil
			: null;
	const effectiveUntil = previous ? Math.max(previous, until) : until;
	anthropicBurstThrottleUntil = effectiveUntil;
	log.warn(
		`Anthropic-OAuth burst throttle active until ${new Date(effectiveUntil).toISOString()}; holding cache accounts (sibling diversion suppressed)`,
	);
}

/**
 * Returns the active-until timestamp if the burst marker is still active
 * (`> now`), else `null`. Lazily clears expired state on read.
 */
export function getAnthropicBurstThrottleUntil(
	now = Date.now(),
): number | null {
	const until = anthropicBurstThrottleUntil;
	if (!until) return null;
	if (until <= now) {
		anthropicBurstThrottleUntil = null;
		return null;
	}
	return until;
}

/**
 * Returns `true` while the Anthropic-OAuth burst marker is active.
 */
export function isAnthropicBurstThrottleActive(now = Date.now()): boolean {
	return getAnthropicBurstThrottleUntil(now) !== null;
}

/**
 * Clear the burst marker. For tests + explicit reset.
 */
export function clearAnthropicBurstThrottle(): void {
	anthropicBurstThrottleUntil = null;
}

// ---------------------------------------------------------------------------
// Concurrency semaphore for simultaneous transparent-retry holds.
//
// A minimal counting semaphore capping how many requests may concurrently hold
// & re-probe a cache account, so our own re-probes don't pile onto the same
// per-IP window. The cap is the fixed `BURST_RETRY_MAX_CONCURRENT_HOLDS`
// constant.
//
// JS is single-threaded, so "atomic" check-and-increment is just a synchronous
// compare-and-set — no locking required.
// ---------------------------------------------------------------------------

let activeHoldCount = 0;

/**
 * Atomically acquire a hold slot if the current count is below the cap.
 * Returns `true` and increments on success; returns `false` (no change) when
 * already at cap.
 *
 * `maxConcurrentHolds` is an injectable override for tests; it defaults to the
 * fixed `BURST_RETRY_MAX_CONCURRENT_HOLDS` constant. Production never passes it.
 */
export function tryAcquireHoldSlot(
	maxConcurrentHolds = BURST_RETRY_MAX_CONCURRENT_HOLDS,
): boolean {
	if (activeHoldCount >= maxConcurrentHolds) {
		return false;
	}
	activeHoldCount += 1;
	return true;
}

/**
 * Release a previously-acquired hold slot. Never decrements below 0.
 */
export function releaseHoldSlot(): void {
	if (activeHoldCount > 0) {
		activeHoldCount -= 1;
	}
}

/**
 * Current number of held slots. For tests / observability.
 */
export function getActiveHoldCount(): number {
	return activeHoldCount;
}

/**
 * Reset the hold-slot counter to 0. For tests.
 */
export function resetHoldSlots(): void {
	activeHoldCount = 0;
}
