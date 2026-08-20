/**
 * Main-connection lock-contention telemetry.
 *
 * Why this exists: `MAIN_CONNECTION_BUSY_TIMEOUT_MS` bounds the C-level busy
 * wait at 250 ms, and that wait happens INSIDE SQLite, on the main thread —
 * the event loop is frozen for its whole duration. EventLoopMonitor observes
 * the freeze but cannot attribute it, and its own WARN threshold is *also*
 * 250 ms, so the journal cannot distinguish "parked in the busy handler
 * waiting for the writer slot" from "slow cold page read". Both pile up just
 * above 250 ms; one is a lock problem and the other is a cache problem, and
 * they have opposite fixes.
 *
 * Durations are recorded around each individual synchronous SQLite attempt in
 * `BunSqlAdapter.withBusyRetry`, NOT around a whole repository call. That
 * placement matters twice over. It is the only point where SQLITE_BUSY is
 * visible at all — the adapter catches it, sleeps 500 ms and retries, so
 * nothing downstream ever sees one — and it excludes that sleep, which does
 * not block the loop and would otherwise inflate a "blocking time" number by
 * half a second per retry.
 *
 * READING THE OUTPUT — and its one important limit:
 *
 *   - `busyOccurrences > 0` is positive proof of SQLite lock contention, and
 *     under ordinary WAL writes that means the writer slot. Read the paired
 *     duration samples for how long the loop was actually blocked; the count
 *     establishes cause, not magnitude. It also does not name the holder --
 *     the payload worker is one candidate among the maintenance workers.
 *   - `busyOccurrences == 0` does NOT exonerate contention. A statement that
 *     waited 220 ms for the slot and then got it returns successfully, with no
 *     error to count, and lands in the same bucket as a 220 ms cold read.
 *     SQLite does not expose its busy-handler invocations, so sub-timeout
 *     collisions are invisible here. Treat this counter as a LOWER BOUND on
 *     contention, never as a measurement of its absence.
 *
 * To settle the sub-timeout case you have to make the waits observable: set
 * the main connection's busy_timeout to 0 (or near it) so every collision
 * fails immediately and is counted, and let the adapter's async retry absorb
 * the correctness impact. That is a deliberate experiment, not a default.
 *
 * {@link LockContentionStats.drain} returns a snapshot and resets, so a
 * periodic reporter emits per-interval deltas that line up against
 * EventLoopMonitor WARNs in the same journal.
 */

/**
 * Upper bounds (exclusive) of the duration histogram, in ms. The 200/250/300
 * boundaries straddle MAIN_CONNECTION_BUSY_TIMEOUT_MS so the shape around the
 * timeout is visible.
 *
 * These separate DURATIONS, nothing more. A 220 ms cold read and a 220 ms
 * sub-timeout lock wait share a bucket and always will; only `busyOccurrences`
 * distinguishes cause, and only in the positive direction.
 */
export const LOCK_HISTOGRAM_BOUNDS_MS = [
	10, 50, 100, 200, 250, 300, 500, 1000,
] as const;

/** Operations at or above this are individually interesting. */
export const SLOW_OPERATION_MS = 200;

/**
 * Writer-slot hold at or above this is long enough to have exhausted a main
 * thread write's entire busy budget. Note "long enough to", not "did": a write
 * arriving near the END of such a hold waits only the remainder, so this
 * counts holds that COULD have caused a full park, not confirmed parks.
 * Confirmed parks are `busyOccurrences`.
 *
 * Kept equal to `MAIN_CONNECTION_BUSY_TIMEOUT_MS`; a test asserts they have
 * not drifted. It lives here rather than in database-operations.ts so the
 * payload write client can import it without pulling in the main connection
 * module.
 */
export const SLOT_HOLD_LONG_MS = 250;

export interface LockContentionSnapshot {
	/** Operations timed in this interval. */
	operations: number;
	/** Operations at or above {@link SLOW_OPERATION_MS}. */
	slowOperations: number;
	/** Summed duration of the slow operations only, ms. */
	slowMs: number;
	/** Longest single operation, ms. */
	maxMs: number;
	/** Name of the longest operation, if one was recorded. */
	maxOperation: string | null;
	/**
	 * SQLITE_BUSY occurrences observed inside the adapter, counted BEFORE the
	 * adapter swallows them and re-schedules. Nothing downstream ever sees
	 * these errors, so this is the only place they are observable at all.
	 *
	 * Each one proves a real lock collision. It does NOT prove a fixed 250 ms
	 * freeze: SQLite may return BUSY without running the busy handler to the
	 * full budget, and the budget itself is configurable (the diagnostic
	 * experiment described above sets it to 0). The paired duration sample is
	 * the authority on how long the loop was actually blocked.
	 */
	busyOccurrences: number;
	/** Busy operations that gave up at the adapter's 10-minute deadline. */
	busyExhausted: number;
	/**
	 * Errors the shared `isTransientLockError` classifier calls lock
	 * contention but the adapter's exact `code === "SQLITE_BUSY"` check does
	 * not. A non-zero value means
	 * the retry layer is failing to retry genuine contention (e.g. the
	 * extended `SQLITE_BUSY_SNAPSHOT` code), which surfaces to callers as a
	 * hard error instead of a retry.
	 */
	classifierGap: number;
	/**
	 * Duration histogram. One entry per bound in
	 * {@link LOCK_HISTOGRAM_BOUNDS_MS} plus a trailing overflow bucket, so
	 * `buckets.length === LOCK_HISTOGRAM_BOUNDS_MS.length + 1`.
	 */
	buckets: number[];
}

/** Human-readable label for bucket `i`, e.g. "200-250" or "1000+". */
export function bucketLabel(index: number): string {
	const bounds = LOCK_HISTOGRAM_BOUNDS_MS;
	if (index >= bounds.length) return `${bounds[bounds.length - 1]}+`;
	const lo = index === 0 ? 0 : bounds[index - 1];
	return `${lo}-${bounds[index]}`;
}

function emptyBuckets(): number[] {
	return new Array(LOCK_HISTOGRAM_BOUNDS_MS.length + 1).fill(0);
}

export class LockContentionStats {
	private operations = 0;
	private slowOperations = 0;
	private slowMs = 0;
	private maxMs = 0;
	private maxOperation: string | null = null;
	private busyOccurrences = 0;
	private busyExhausted = 0;
	private classifierGap = 0;
	private buckets = emptyBuckets();

	/** Record one completed operation's wall-clock duration. */
	recordOperation(durationMs: number, operationName?: string): void {
		// Guard against a non-finite duration poisoning the accumulator; a bad
		// clock reading must not make the whole interval unreadable.
		if (!Number.isFinite(durationMs) || durationMs < 0) return;

		this.operations++;
		this.buckets[this.bucketIndex(durationMs)]++;

		if (durationMs >= SLOW_OPERATION_MS) {
			this.slowOperations++;
			this.slowMs += durationMs;
		}
		if (durationMs > this.maxMs) {
			this.maxMs = durationMs;
			this.maxOperation = operationName ?? null;
		}
	}

	recordBusyOccurrence(): void {
		this.busyOccurrences++;
	}

	recordBusyExhausted(): void {
		this.busyExhausted++;
	}

	recordClassifierGap(): void {
		this.classifierGap++;
	}

	private bucketIndex(durationMs: number): number {
		const bounds = LOCK_HISTOGRAM_BOUNDS_MS;
		for (let i = 0; i < bounds.length; i++) {
			if (durationMs < bounds[i]) return i;
		}
		return bounds.length;
	}

	/** Read the accumulator without disturbing it. */
	snapshot(): LockContentionSnapshot {
		return {
			operations: this.operations,
			slowOperations: this.slowOperations,
			slowMs: Math.round(this.slowMs),
			maxMs: Math.round(this.maxMs),
			maxOperation: this.maxOperation,
			busyOccurrences: this.busyOccurrences,
			busyExhausted: this.busyExhausted,
			classifierGap: this.classifierGap,
			buckets: [...this.buckets],
		};
	}

	/** Read and reset, so the caller reports a per-interval delta. */
	drain(): LockContentionSnapshot {
		const snap = this.snapshot();
		this.reset();
		return snap;
	}

	reset(): void {
		this.operations = 0;
		this.slowOperations = 0;
		this.slowMs = 0;
		this.maxMs = 0;
		this.maxOperation = null;
		this.busyOccurrences = 0;
		this.busyExhausted = 0;
		this.classifierGap = 0;
		this.buckets = emptyBuckets();
	}
}

/**
 * Process-wide accumulator. The retry layer writes to it from every repository
 * call on the main connection, so a singleton keeps the instrumentation out of
 * every call signature.
 */
export const lockContentionStats = new LockContentionStats();

/**
 * Render a snapshot as one log line. Buckets with no samples are omitted so a
 * quiet interval stays short and a contended one is still complete.
 */
export function formatLockContention(snap: LockContentionSnapshot): string {
	const hist = snap.buckets
		.map((count, i) => (count > 0 ? `${bucketLabel(i)}=${count}` : null))
		.filter((part): part is string => part !== null)
		.join(" ");
	const worst =
		snap.maxOperation === null
			? ""
			: ` maxOp=${JSON.stringify(snap.maxOperation)}`;
	return (
		`ops=${snap.operations} slow=${snap.slowOperations} slowMs=${snap.slowMs} ` +
		`maxMs=${snap.maxMs}${worst} busyOccurrences=${snap.busyOccurrences} ` +
		`busyExhausted=${snap.busyExhausted} classifierGap=${snap.classifierGap}` +
		(hist.length > 0 ? ` | ${hist}` : "")
	);
}
