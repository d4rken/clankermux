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
 */

export const TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_ENTRIES = 2048;

interface CacheEntry {
	project: string;
	expiresAt: number;
}

export class SessionProjectCache {
	private readonly entries = new Map<string, CacheEntry>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/**
	 * Seed (or refresh) the project for a session key. Re-anchors the TTL and
	 * moves the entry to the most-recent LRU position.
	 *
	 * @returns the PREVIOUS project for that key, or null if there was none —
	 *          lets the caller detect session→project transitions.
	 */
	set(key: string, project: string): string | null {
		const existing = this.entries.get(key);
		const previous = existing?.project ?? null;

		// Delete + re-insert moves the key to the most-recent Map position.
		this.entries.delete(key);
		this.entries.set(key, { project, expiresAt: this.now() + TTL_MS });

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
	 * report null. A fresh hit refreshes LRU recency WITHOUT touching the TTL
	 * (the TTL counts from the last anchored set, not the last read).
	 */
	get(key: string): string | null {
		const entry = this.entries.get(key);
		if (!entry) return null;

		if (this.now() >= entry.expiresAt) {
			this.entries.delete(key);
			return null;
		}

		// Recency refresh only — expiresAt is preserved.
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.project;
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
