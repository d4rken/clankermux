/**
 * In-memory session → project LRU cache backing tier-4 project attribution
 * (session inheritance, see `project-extraction.ts`).
 *
 * When an anchored signal (header / working-directory label / codex <cwd>)
 * resolves a project for a request that also carries a Claude Code session id,
 * the caller seeds this cache. Signal-less requests from the same session
 * (sidechains, title generation, count_tokens) then inherit that project.
 *
 * Keys are `${apiKeyId ?? "anon"}:${sessionId}` so sessions never leak across
 * API-key boundaries. Entries expire TTL_MS after the LAST ANCHORED SET —
 * reads refresh LRU recency only, never the TTL — and the map is bounded by
 * MAX_ENTRIES with oldest-first eviction. Inline constants per repo rule
 * (no env feature gates / tuning knobs).
 *
 * AMBIGUITY: a session that seeds a DIFFERENT project while its previous seed
 * is still live is a session whose identity we cannot trust (one Claude Code
 * session id reused across working directories). Such a key is stamped
 * `ambiguousUntil = now + TTL_MS` and `lookup()` withholds its project until
 * that deadline passes, so signal-less siblings fall back to "no project"
 * instead of inheriting a coin-flip. The deadline is a decaying timestamp, not
 * a sticky flag: a same-project re-seed re-anchors the entry TTL but never
 * extends the ambiguity window, so an actively-used session that conflicted
 * once recovers attribution after TTL_MS instead of losing it forever.
 *
 * LIMITATION: this cache is in-memory only. A service restart, `clear()`, or
 * LRU eviction at MAX_ENTRIES forgets the recorded conflict, and the session
 * looks clean again until it next conflicts. That is a bounded best-effort
 * reduction of mis-attribution, NOT a guarantee — deliberately so: persisted
 * conflict tombstones and an eviction metric were both considered and declined.
 */

export const TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_ENTRIES = 2048;

interface CacheEntry {
	project: string;
	expiresAt: number;
	/**
	 * Timestamp until which this session is considered ambiguous (stamped at
	 * conflict time, reusing TTL_MS), or null when it has never conflicted /
	 * the window has been cleared.
	 */
	ambiguousUntil: number | null;
}

/** Result of {@link SessionProjectCache.lookup}. */
export interface SessionProjectLookup {
	/** The inheritable project, or null when absent/expired/ambiguous. */
	project: string | null;
	/** True while a recorded seed conflict makes inheritance untrustworthy. */
	ambiguous: boolean;
}

export class SessionProjectCache {
	private readonly entries = new Map<string, CacheEntry>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/**
	 * Seed (or refresh) the project for a session key. Re-anchors the TTL and
	 * moves the entry to the most-recent LRU position. A seed that conflicts
	 * with a still-live different project stamps the ambiguity window.
	 *
	 * @returns the PREVIOUS project for that key, or null if there was none —
	 *          lets the caller detect session→project transitions. An entry
	 *          that had already EXPIRED reports null: a seed after the window
	 *          closed is a fresh start, not a transition.
	 */
	set(key: string, project: string): string | null {
		const now = this.now();

		// Evict first: without this, "seed A → wait out the TTL → seed B" would
		// register a bogus conflict against an entry nothing could have read.
		let existing = this.entries.get(key);
		if (existing && now >= existing.expiresAt) {
			this.entries.delete(key);
			existing = undefined;
		}
		const previous = existing?.project ?? null;

		// Carry the ambiguity deadline over untouched (a same-project re-seed
		// must NOT extend it), dropping it once it has passed. A genuine
		// conflict re-stamps a fresh window from now.
		let ambiguousUntil =
			existing?.ambiguousUntil != null && now < existing.ambiguousUntil
				? existing.ambiguousUntil
				: null;
		if (previous !== null && previous !== project) {
			ambiguousUntil = now + TTL_MS;
		}

		// Delete + re-insert moves the key to the most-recent Map position.
		this.entries.delete(key);
		this.entries.set(key, {
			project,
			expiresAt: now + TTL_MS,
			ambiguousUntil,
		});

		if (this.entries.size > MAX_ENTRIES) {
			// First Map key is the least-recently-used entry.
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) {
				this.entries.delete(oldest);
			}
		}

		return previous;
	}

	/**
	 * Look up the project for a session key. Expired entries are removed and
	 * report a clean miss. A fresh hit refreshes LRU recency WITHOUT touching
	 * the TTL (the TTL counts from the last anchored set, not the last read).
	 *
	 * While the key is inside its ambiguity window the stored project is
	 * WITHHELD (`project: null`, `ambiguous: true`) so no caller can inherit
	 * it; the value stays in the entry internally so the next conflict is still
	 * detectable.
	 */
	lookup(key: string): SessionProjectLookup {
		const entry = this.entries.get(key);
		if (!entry) return { project: null, ambiguous: false };

		const now = this.now();
		if (now >= entry.expiresAt) {
			this.entries.delete(key);
			return { project: null, ambiguous: false };
		}

		// Recency refresh only — expiresAt is preserved.
		this.entries.delete(key);
		this.entries.set(key, entry);

		const ambiguous =
			entry.ambiguousUntil != null && now < entry.ambiguousUntil;
		return { project: ambiguous ? null : entry.project, ambiguous };
	}

	clear(): void {
		this.entries.clear();
	}

	size(): number {
		return this.entries.size;
	}
}

/** Process-wide singleton used by the proxy request path. */
export const sessionProjectCache = new SessionProjectCache();
