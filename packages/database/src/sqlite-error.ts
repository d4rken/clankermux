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

/**
 * `isCorruptionError` answers the opposite-but-adjacent question: "does this
 * thrown error prove the database is CORRUPT?" — the SQLITE_CORRUPT /
 * SQLITE_NOTADB family.
 *
 * Why it matters: severe corruption frequently *throws* rather than returning
 * PRAGMA rows. `new Database(path)` on a malformed file, or the first query
 * against it, can raise `SQLITE_CORRUPT` ("database disk image is malformed")
 * or `SQLITE_NOTADB` ("file is not a database" / "file is encrypted"). The
 * integrity worker's `catch` must classify these as a real `corrupt` verdict —
 * treating them as a generic operational "error" (→ `skipped`, amber) would
 * mask genuine corruption, the dangerous false-negative direction.
 *
 * Same 3-way match style as {@link isTransientLockError} (any one sufficient):
 *   1. primary result code (low 8 bits of `errno`): 11 = SQLITE_CORRUPT,
 *      26 = SQLITE_NOTADB,
 *   2. symbolic `code` prefix: `SQLITE_CORRUPT*` / `SQLITE_NOTADB*`,
 *   3. message fallback (lowercased) — ONLY the specific canonical corruption
 *      phrases, never a bare "malformed", so an unrelated operational error
 *      ("malformed request" etc.) can't be misclassified as DB corruption (a
 *      new false-positive). Reached only when neither structured field
 *      matched; canonical bun `SQLiteError`s always carry `errno`, so this is
 *      a defensive last resort.
 */
export function isCorruptionError(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const e = err as { code?: unknown; errno?: unknown; message?: unknown };

	// 1. Primary result code = low 8 bits of the extended code. Catches every
	//    CORRUPT variant (base 11 or extended like SQLITE_CORRUPT_VTAB = 267,
	//    low byte 11) and SQLITE_NOTADB (26) in one check.
	if (typeof e.errno === "number") {
		const primary = e.errno & 0xff;
		if (primary === 11 || primary === 26) return true;
	}

	// 2. Symbolic code prefix, in case a surface carries `code` but not `errno`.
	if (typeof e.code === "string") {
		if (
			e.code.startsWith("SQLITE_CORRUPT") ||
			e.code.startsWith("SQLITE_NOTADB")
		) {
			return true;
		}
	}

	// 3. Message fallback for errors that carry neither structured field.
	//    Match only the specific canonical corruption phrases — a bare
	//    "malformed" or "not a database" would over-match unrelated
	//    operational errors. "is not a database" covers both
	//    "file is not a database" and "file is encrypted or is not a database".
	if (typeof e.message === "string") {
		const m = e.message.toLowerCase();
		return (
			m.includes("disk image is malformed") ||
			m.includes("malformed database schema") ||
			m.includes("database schema is corrupt") ||
			m.includes("is not a database")
		);
	}

	return false;
}
