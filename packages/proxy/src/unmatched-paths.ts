/**
 * Recent working directories that matched no project rule.
 *
 * Attribution now returns nothing rather than guessing when a path fits no
 * configured root, which is correct but silent: without this list an operator
 * on an unrecognized layout sees an empty project filter and no indication
 * that a two-line config change would fill it. This turns "we do not know"
 * into "here is what to name".
 *
 * In-memory and bounded on purpose. The alternative — a column on `requests` —
 * would mean a migration, a retention policy and a second copy of paths the
 * payload table already holds, to answer a question that is only ever about
 * what is happening NOW. Losing the list on restart costs nothing: the next
 * request from the same client re-adds it within seconds.
 */

/** A distinct unmatched path and how often it has been seen since startup. */
export interface UnmatchedPath {
	path: string;
	count: number;
	/** Epoch ms of the most recent sighting. */
	lastSeenAt: number;
}

/**
 * Distinct paths retained. Small because the list is a prompt to act, not a
 * dataset: a deployment with more than this many unrecognized layouts has a
 * missing root, not fifty missing roots.
 */
const MAX_ENTRIES = 50;

/** Longest path retained, to bound memory against a pathological client. */
const MAX_PATH_LENGTH = 512;

export class UnmatchedPathTracker {
	// Insertion-ordered, so the oldest key is the first one `keys()` yields.
	private entries = new Map<string, UnmatchedPath>();

	constructor(private readonly now: () => number = Date.now) {}

	/**
	 * Record one sighting. A repeat sighting refreshes recency as well as the
	 * count, so a path still in active use cannot be evicted by a burst of
	 * one-off paths.
	 */
	record(path: string): void {
		if (!path || path.length > MAX_PATH_LENGTH) return;

		const existing = this.entries.get(path);
		if (existing) {
			this.entries.delete(path);
			this.entries.set(path, {
				path,
				count: existing.count + 1,
				lastSeenAt: this.now(),
			});
			return;
		}

		if (this.entries.size >= MAX_ENTRIES) {
			const oldest = this.entries.keys().next();
			if (!oldest.done) this.entries.delete(oldest.value);
		}
		this.entries.set(path, { path, count: 1, lastSeenAt: this.now() });
	}

	/** Most recently seen first, which is the order the operator wants to read. */
	list(): UnmatchedPath[] {
		return [...this.entries.values()].sort(
			(a, b) => b.lastSeenAt - a.lastSeenAt,
		);
	}

	/**
	 * Drop everything. Called when the rules change: a path that was unmatched
	 * under the old rules may well be matched under the new ones, and showing
	 * the operator a stale complaint about a path they just fixed is worse than
	 * showing nothing until the next request arrives.
	 */
	clear(): void {
		this.entries.clear();
	}
}

/** Process-wide tracker. Injected at call sites so tests can supply their own. */
export const unmatchedPathTracker = new UnmatchedPathTracker();
