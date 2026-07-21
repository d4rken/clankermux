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
export const OVERLOAD_HOLD_MAX_CONCURRENT_PER_BUCKET = 8;

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
