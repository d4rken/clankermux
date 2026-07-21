/**
 * Minimal keyed counting semaphore shared by the proxy's hold-slot caps
 * (`overload-hold.ts` per-overload-bucket, `handlers/burst-cooldown.ts` with a
 * single fixed key). Each consumer creates its OWN instance — state is never
 * shared across modules.
 *
 * JS is single-threaded, so "atomic" check-and-increment is just a synchronous
 * compare-and-set — no locking required.
 */

export interface KeyedSemaphore {
	/**
	 * Atomically acquire a slot for `key` if its current count is below the
	 * cap. Returns `true` and increments on success; returns `false` (no
	 * change) when the key is already at cap.
	 *
	 * `capOverride` is an injectable override for tests; it defaults to the
	 * instance cap. Production never passes it.
	 */
	tryAcquire(key: string, capOverride?: number): boolean;
	/**
	 * Release a previously-acquired slot for `key`. Never decrements below 0;
	 * the entry is dropped at 0 so keys don't accumulate forever.
	 */
	release(key: string): void;
	/**
	 * Current number of held slots for `key`, or the total across all keys
	 * when `key` is omitted. For tests / observability.
	 */
	count(key?: string): number;
	/**
	 * Reset all counters. For tests.
	 */
	reset(): void;
}

export function createKeyedSemaphore(cap: number): KeyedSemaphore {
	const counts = new Map<string, number>();
	return {
		tryAcquire(key: string, capOverride = cap): boolean {
			const current = counts.get(key) ?? 0;
			if (current >= capOverride) {
				return false;
			}
			counts.set(key, current + 1);
			return true;
		},
		release(key: string): void {
			const current = counts.get(key) ?? 0;
			if (current <= 1) {
				counts.delete(key);
				return;
			}
			counts.set(key, current - 1);
		},
		count(key?: string): number {
			if (key !== undefined) {
				return counts.get(key) ?? 0;
			}
			let total = 0;
			for (const value of counts.values()) {
				total += value;
			}
			return total;
		},
		reset(): void {
			counts.clear();
		},
	};
}
