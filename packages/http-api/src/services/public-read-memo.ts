/**
 * The shared memo every `/public/v1/*` reader is built on.
 *
 * ONE implementation, deliberately. Every route on this surface is
 * unauthenticated and every consumer polls, so each reader needs the same two
 * properties — serve one computed answer for a TTL, and collapse concurrent
 * cold callers onto a single computation — and a per-reader copy of that logic
 * is how one of them ends up subtly different from the rest. Three readers had
 * hand-written copies of it and three had none at all; this is the one they all
 * use now.
 *
 * What it is NOT is a response cache. The value it holds is a MEASUREMENT that
 * carries its own instant, and a memo hit re-serves that instant rather than
 * restamping it: a client seeing the same `generatedAt` twice is looking at the
 * same measurement twice, which is the truth. The route handlers still answer
 * `Cache-Control: no-store`, because an intermediary caching the payload would
 * be presenting one instant as another.
 */

/** How long one computed answer is served before another read is allowed. */
export const PUBLIC_READ_TTL_MS = 60_000;

/**
 * How long a FAILED read is remembered before another is attempted.
 *
 * A separate decision from {@link PUBLIC_READ_TTL_MS} and much shorter, because
 * the two say different things. A cached answer is served for a minute because
 * it is a real measurement that has not gone stale; a remembered failure is not
 * an answer at all, it is only a reason to stop asking for a moment. Without
 * one the TTL bounded the success path alone, so a reader whose database read
 * was failing re-ran the whole computation for every anonymous poll — the exact
 * load the memo exists to cap, arriving when the process can least absorb it.
 */
export const PUBLIC_READ_FAILURE_TTL_MS = 5_000;

export interface PublicReadMemoOptions<T> {
	/**
	 * The instant the value describes, read off the value itself.
	 *
	 * The TTL is measured against THIS rather than against when the memo stored
	 * it, so an answer is retired a fixed time after it was MEASURED. Passed in
	 * because the readers spell it differently (`generatedAtMs`, `nowMs`) and
	 * inventing a second timestamp here would let the memo age a snapshot by a
	 * clock the snapshot does not report.
	 */
	computedAtMs: (value: T) => number;
	/** Clock seam. Defaults to `Date.now`; tests pin it to a fixed instant. */
	now?: () => number;
	/** Memo lifetime. */
	ttlMs?: number;
	/** Negative-cache lifetime. See {@link PUBLIC_READ_FAILURE_TTL_MS}. */
	failureTtlMs?: number;
}

/**
 * Wrap `read` in a shared-TTL, single-flight, negative-caching memo.
 *
 * `read` receives the memo's own clock reading, so the value it produces can
 * stamp itself with the instant the memo will then age it against.
 */
export function createPublicReadMemo<T>(
	read: (nowMs: number) => Promise<T>,
	options: PublicReadMemoOptions<T>,
): () => Promise<T> {
	const now = options.now ?? (() => Date.now());
	const ttlMs = options.ttlMs ?? PUBLIC_READ_TTL_MS;
	const failureTtlMs = options.failureTtlMs ?? PUBLIC_READ_FAILURE_TTL_MS;
	const { computedAtMs } = options;

	let cached: T | null = null;
	let failure: { error: unknown; atMs: number } | null = null;
	let inFlight: Promise<T> | null = null;

	return async (): Promise<T> => {
		const nowMs = now();
		if (cached !== null && nowMs - computedAtMs(cached) < ttlMs) return cached;
		// A remembered failure does NOT resurrect an expired answer: past its TTL
		// the memo either has a fresh measurement or it has none, and serving an
		// hour-old snapshot under a fresh-looking timestamp is the one thing this
		// surface must not do.
		if (failure !== null && nowMs - failure.atMs < failureTtlMs) {
			throw failure.error;
		}
		// Single flight, checked BEFORE starting a read: a burst of concurrent
		// polls costs one computation rather than one each.
		if (inFlight) return await inFlight;

		const pending = read(nowMs);
		inFlight = pending;
		try {
			cached = await pending;
			// A success retires the failure record outright rather than letting it
			// expire on its own clock.
			failure = null;
			return cached;
		} catch (error) {
			failure = { error, atMs: now() };
			throw error;
		} finally {
			// Cleared whether the read resolved or threw: a rejected promise left
			// here would be handed to every later caller for the life of the
			// process, which the bounded negative cache above replaces.
			inFlight = null;
		}
	};
}
