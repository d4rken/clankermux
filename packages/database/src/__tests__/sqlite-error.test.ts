/**
 * Tests for `isTransientLockError` — the classifier that decides whether a
 * SQLite error from a best-effort maintenance tick (the optimize/checkpoint
 * worker) is benign lock contention ("skip, retry next cycle") or a real
 * failure worth a WARN.
 *
 * Regression context: the optimize worker previously did an exact
 * `err.code === "SQLITE_BUSY"` match. Under WAL, a fresh connection running
 * `PRAGMA optimize` (which defers an ANALYZE write) can have its read snapshot
 * invalidated by a concurrent writer + checkpoint and fail with the EXTENDED
 * code `SQLITE_BUSY_SNAPSHOT` (errno 517, message "database is locked").
 * bun:sqlite surfaces that as `code: "SQLITE_BUSY_SNAPSHOT"`, so the exact
 * match missed it and the benign contention was logged at WARN every few
 * minutes on a busy DB. The classifier must match the whole BUSY/LOCKED family.
 */
import { describe, expect, it } from "bun:test";
import { isTransientLockError } from "../sqlite-error";

describe("isTransientLockError", () => {
	it("matches base SQLITE_BUSY (errno 5)", () => {
		expect(
			isTransientLockError({
				code: "SQLITE_BUSY",
				errno: 5,
				message: "database is locked",
			}),
		).toBe(true);
	});

	it("matches extended SQLITE_BUSY_SNAPSHOT (errno 517) — the production case", () => {
		expect(
			isTransientLockError({
				code: "SQLITE_BUSY_SNAPSHOT",
				errno: 517,
				message: "database is locked",
			}),
		).toBe(true);
	});

	it("matches other extended BUSY variants (RECOVERY 261, TIMEOUT 773)", () => {
		expect(
			isTransientLockError({ code: "SQLITE_BUSY_RECOVERY", errno: 261 }),
		).toBe(true);
		expect(
			isTransientLockError({ code: "SQLITE_BUSY_TIMEOUT", errno: 773 }),
		).toBe(true);
	});

	it("matches the SQLITE_LOCKED family (errno 6 and extended 262)", () => {
		expect(
			isTransientLockError({
				code: "SQLITE_LOCKED",
				errno: 6,
				message: "database table is locked",
			}),
		).toBe(true);
		expect(
			isTransientLockError({ code: "SQLITE_LOCKED_SHAREDCACHE", errno: 262 }),
		).toBe(true);
	});

	it("matches on message alone when no code/errno is present", () => {
		expect(isTransientLockError(new Error("database is locked"))).toBe(true);
		expect(isTransientLockError(new Error("database table is locked"))).toBe(
			true,
		);
	});

	it("matches on errno alone when code is missing (low 8 bits === 5)", () => {
		// Defensive: some surfaces carry only the numeric extended code.
		expect(isTransientLockError({ errno: 517 })).toBe(true);
	});

	it("does NOT match genuine, non-contention errors", () => {
		expect(
			isTransientLockError({
				code: "SQLITE_CORRUPT",
				errno: 11,
				message: "database disk image is malformed",
			}),
		).toBe(false);
		expect(
			isTransientLockError({
				code: "SQLITE_FULL",
				errno: 13,
				message: "database or disk is full",
			}),
		).toBe(false);
		expect(
			isTransientLockError({
				code: "SQLITE_IOERR",
				errno: 10,
				message: "disk I/O error",
			}),
		).toBe(false);
	});

	it("does NOT match a SQLITE_IOERR whose low byte collides with nothing relevant", () => {
		// SQLITE_IOERR_READ extended = 266 → low byte 10, not 5/6. Stays false.
		expect(
			isTransientLockError({ code: "SQLITE_IOERR_READ", errno: 266 }),
		).toBe(false);
	});

	it("handles non-object inputs without throwing", () => {
		expect(isTransientLockError(null)).toBe(false);
		expect(isTransientLockError(undefined)).toBe(false);
		expect(isTransientLockError("database is locked")).toBe(false);
		expect(isTransientLockError(42)).toBe(false);
	});
});
