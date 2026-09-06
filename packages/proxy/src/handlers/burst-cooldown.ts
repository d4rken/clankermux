import { Logger } from "@clankermux/logger";
import { createKeyedSemaphore } from "../keyed-semaphore";

const log = new Logger("BurstCooldown");

// Transparent burst-429 retry tuning constants owned by this module (the marker
// + the hold-slot semaphore). Fixed, source-level defaults — the feature is
// unconditionally on and not env-configurable.

/**
 * Lifetime (ms) of upstream burst evidence suppressing sibling diversion.
 * Only a fresh upstream burst observation renews it. Individual holds have
 * independent budgets and may finish after this marker expires. Success on one
 * account neither renews nor clears provider-wide evidence: concurrent requests
 * may still encounter a real burst. Without new evidence, recovery is bounded
 * by this lifetime regardless of successful traffic volume.
 */
const BURST_RETRY_MARKER_MS = 120_000;
/** At most one continued-burst summary per interval, emitted on observation. */
const BURST_RETRY_SUMMARY_MS = 30_000;
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
let burstObservations = 0;
let observationsSinceSummary = 0;
let lastSummaryAt = 0;

/**
 * Record upstream burst evidence and mark the Anthropic throttle active until
 * `now + BURST_RETRY_MARKER_MS`. Extends (never shortens) an existing marker.
 * Do not call on hold admission, suppressed probes, or successful responses.
 *
 * `markerMs` is an injectable override for tests; it defaults to the fixed
 * `BURST_RETRY_MARKER_MS` constant. Production never passes it.
 */
export function markAnthropicBurstThrottle(
	now = Date.now(),
	markerMs = BURST_RETRY_MARKER_MS,
): void {
	const until = now + markerMs;
	let previous = anthropicBurstThrottleUntil;
	if (previous !== null && previous <= now) {
		// Fresh evidence immediately reactivates protection. Retain the old
		// window's counts without claiming that routing has recovered.
		log.info(
			`Anthropic-OAuth previous burst evidence expired before fresh evidence; observations=${burstObservations}, newObservations=${observationsSinceSummary}`,
		);
		clearAnthropicBurstThrottle();
		previous = null;
	}
	const effectiveUntil = previous !== null ? Math.max(previous, until) : until;
	anthropicBurstThrottleUntil = effectiveUntil;
	burstObservations += 1;
	observationsSinceSummary += 1;
	if (previous === null) {
		lastSummaryAt = now;
		log.warn(
			`Anthropic-OAuth burst throttle active until ${new Date(effectiveUntil).toISOString()}; holding cache accounts (sibling diversion suppressed); observations=1`,
		);
		observationsSinceSummary = 0;
	} else if (now - lastSummaryAt >= BURST_RETRY_SUMMARY_MS) {
		log.info(
			`Anthropic-OAuth burst throttle continues until ${new Date(effectiveUntil).toISOString()}; observations=${burstObservations}, newObservations=${observationsSinceSummary}`,
		);
		lastSummaryAt = now;
		observationsSinceSummary = 0;
	}
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
		log.info(
			`Anthropic-OAuth burst evidence expired; observations=${burstObservations}, newObservations=${observationsSinceSummary}; sibling diversion restored`,
		);
		clearAnthropicBurstThrottle();
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
	burstObservations = 0;
	observationsSinceSummary = 0;
	lastSummaryAt = 0;
}

// ---------------------------------------------------------------------------
// Concurrency semaphore for simultaneous transparent-retry holds.
//
// A counting semaphore capping how many requests may concurrently hold
// & re-probe a cache account, so our own re-probes don't pile onto the same
// per-IP window. The cap is the fixed `BURST_RETRY_MAX_CONCURRENT_HOLDS`
// constant. Backed by its OWN `keyed-semaphore.ts` instance under a single
// fixed key (the throttle is provider-global, not per-bucket) — state is
// never shared with `overload-hold.ts`'s per-bucket instance.
// ---------------------------------------------------------------------------

const HOLD_SLOT_KEY = "burst-retry";
const holdSlots = createKeyedSemaphore(BURST_RETRY_MAX_CONCURRENT_HOLDS);

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
	return holdSlots.tryAcquire(HOLD_SLOT_KEY, maxConcurrentHolds);
}

/**
 * Release a previously-acquired hold slot. Never decrements below 0.
 */
export function releaseHoldSlot(): void {
	holdSlots.release(HOLD_SLOT_KEY);
}

/**
 * Current number of held slots. For tests / observability.
 */
export function getActiveHoldCount(): number {
	return holdSlots.count(HOLD_SLOT_KEY);
}

/**
 * Reset the hold-slot counter to 0. For tests.
 */
export function resetHoldSlots(): void {
	holdSlots.reset();
}
