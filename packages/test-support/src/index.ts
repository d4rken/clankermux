import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempDbTracker {
	/**
	 * Returns a fresh, unique database path inside this tracker's own temporary
	 * directory. The directory is created lazily on first use.
	 */
	next(): string;
	/**
	 * Removes the tracker's temporary directory and everything inside it,
	 * including SQLite sidecars (`-wal`, `-shm`, `-journal`). Idempotent: a
	 * later `next()` re-arms the tracker with a fresh directory.
	 */
	cleanup(): void;
}

/**
 * Tracks temporary SQLite fixture databases for a test file.
 *
 * All fixtures handed out by one tracker live in a single directory under the
 * OS temporary directory, so removing that directory removes the database
 * files and any sidecars SQLite created next to them.
 */
export function tempDbTracker(prefix: string): TempDbTracker {
	let dir: string | null = null;

	return {
		next(): string {
			dir ??= mkdtempSync(join(tmpdir(), `${prefix}-`));
			return join(dir, `${prefix}-${randomBytes(6).toString("hex")}.db`);
		},
		cleanup(): void {
			if (dir === null) return;
			rmSync(dir, { recursive: true, force: true });
			dir = null;
		},
	};
}
