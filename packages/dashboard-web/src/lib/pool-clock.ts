import { registerUIRefresh } from "@clankermux/core";

/**
 * One ticking clock shared by every quota surface on the page.
 *
 * Overview and Usage each used to own a 30s `registerUIRefresh` under a
 * different id, driving two independent `computePoolUsage` passes over the same
 * accounts. The two pages could therefore disagree by up to 30 seconds about
 * numbers a reader compares side by side.
 *
 * WHY THIS IS REFCOUNTED RATHER THAN A SHARED ID. The obvious fix — give both
 * components the same `registerUIRefresh` id — is broken, and quietly so.
 * `IntervalManager.register` REPLACES any interval already holding that id, and
 * the unregister closure it hands back is `() => this.unregister(id)`, keyed on
 * the id rather than on the registration. So with two mounted subscribers the
 * second registration silently displaces the first, and then the FIRST
 * component to unmount tears down the interval the second is still using. The
 * survivor's clock stops, its countdowns freeze, and nothing errors. That
 * failure needs two pages mounted at once to appear at all, which is exactly
 * the case a single-page session never exercises.
 *
 * So exactly one registration exists at a time, created on the first
 * subscription and torn down on the last.
 */

/** How often quota countdowns and pool figures recompute. */
export const POOL_CLOCK_SECONDS = 30;

const subscribers = new Set<(now: number) => void>();
let unregister: (() => void) | null = null;

function tick(): void {
	const now = Date.now();
	// Copied before iterating: a subscriber that unsubscribes inside its own
	// callback would otherwise mutate the set mid-iteration.
	for (const notify of [...subscribers]) notify(now);
}

/**
 * Subscribe to the shared clock. Returns an unsubscribe function; the interval
 * is torn down when the last subscriber leaves.
 */
export function subscribePoolClock(notify: (now: number) => void): () => void {
	subscribers.add(notify);
	if (unregister === null) {
		// `registerUIRefresh` runs its callback immediately, so the subscriber
		// that creates the registration is served by that first tick.
		unregister = registerUIRefresh({
			id: "pool-clock",
			callback: tick,
			seconds: POOL_CLOCK_SECONDS,
			description: "Shared quota pool/countdown refresh",
		});
	} else {
		// A LATER subscriber gets no such tick — React runs mounted effects in
		// order, so the second page to mount joins a registration that has
		// already fired and would otherwise wait up to a full interval for its
		// first value. Serve it now, so every subscriber has a reading from the
		// moment it subscribes regardless of mount order.
		notify(Date.now());
	}
	return () => {
		subscribers.delete(notify);
		if (subscribers.size === 0 && unregister !== null) {
			unregister();
			unregister = null;
		}
	};
}
