/**
 * Shared SQLite error classification.
 *
 * `isTransientLockError` answers: "is this error just lock contention?" — the
 * BUSY/LOCKED family — as opposed to a genuine failure (corruption, I/O error,
 * disk full). Best-effort maintenance ticks (the optimize/checkpoint worker)
 * use it to decide between a benign "skip, retry next cycle" and a real WARN.
 *
 * Why not an exact `code === "SQLITE_BUSY"` check: SQLite has EXTENDED result
 * codes whose low 8 bits are the primary code. Under WAL, a fresh connection
 * running `PRAGMA optimize` (which defers an ANALYZE write) can have its read
 * snapshot invalidated by a concurrent writer + checkpoint and fail with
 * `SQLITE_BUSY_SNAPSHOT` — extended code 517 (`517 & 0xff === 5`), message
 * "database is locked". bun:sqlite surfaces that as
 * `{ code: "SQLITE_BUSY_SNAPSHOT", errno: 517 }`, so an exact `=== "SQLITE_BUSY"`
 * match misses it and the benign contention gets logged at WARN every few
 * minutes on a busy DB. We match the whole family three ways (any one is
 * sufficient), mirroring the convention already in `retry.ts`:
 *   1. primary result code (low 8 bits of `errno`): 5 = BUSY, 6 = LOCKED,
 *   2. symbolic `code` prefix: `SQLITE_BUSY*` / `SQLITE_LOCKED*`,
 *   3. message substring: "database is locked" / "database table is locked".
 */
export function isTransientLockError(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const e = err as { code?: unknown; errno?: unknown; message?: unknown };

	// 1. Primary result code = low 8 bits of the extended code. This catches
	//    every BUSY/LOCKED variant (base or extended) in one check, including
	//    SQLITE_BUSY_SNAPSHOT (517), _RECOVERY (261), _TIMEOUT (773), and
	//    SQLITE_LOCKED_SHAREDCACHE (262).
	if (typeof e.errno === "number") {
		const primary = e.errno & 0xff;
		if (primary === 5 || primary === 6) return true;
	}

	// 2. Symbolic code prefix, in case a surface carries `code` but not `errno`.
	if (typeof e.code === "string") {
		if (
			e.code.startsWith("SQLITE_BUSY") ||
			e.code.startsWith("SQLITE_LOCKED")
		) {
			return true;
		}
	}

	// 3. Message fallback for errors that carry neither structured field.
	if (typeof e.message === "string") {
		return (
			e.message.includes("database is locked") ||
			e.message.includes("database table is locked")
		);
	}

	return false;
}
