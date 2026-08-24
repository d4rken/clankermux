/**
 * Shared I/O guards for the offline analysis tools under `scripts/`.
 *
 * These are DEVELOPMENT tools that read the live ~9.6 GB database while the
 * proxy is serving from it. Everything here exists so that "read-only" is
 * enforced by the operating system and by SQLite rather than by a convention
 * each new script has to remember.
 *
 * Extracted from `scripts/prediction-backtest.ts`, which still re-exports these
 * names so its own tests and callers are unchanged.
 */

import { Database } from "bun:sqlite";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * The only kind of database handle these tools ever open, and it is read-only:
 * `bun:sqlite` opens the file with SQLITE_OPEN_READONLY, so a write is rejected
 * by SQLite itself rather than by a convention someone can forget.
 */
export function openReadOnlyDatabase(dbPath: string): Database {
	return new Database(dbPath, { readonly: true });
}

const DB_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

/** Canonical path of an EXISTING file, or null when it is not there. */
function canonicalExisting(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

/**
 * Canonical form of a path that need not exist yet: resolve the file itself
 * when it does, otherwise resolve its DIRECTORY and re-attach the basename, so
 * a symlinked parent cannot hide the real target either.
 */
function canonicalTarget(path: string): string {
	const existing = canonicalExisting(path);
	if (existing != null) return existing;
	const absolute = resolve(path);
	const parent = canonicalExisting(dirname(absolute));
	return parent != null ? join(parent, basename(absolute)) : absolute;
}

/** `dev:ino` of an existing file, or null. Two paths sharing one is an alias. */
function fileIdentity(path: string): string | null {
	try {
		const stats = statSync(path);
		return `${stats.dev}:${stats.ino}`;
	} catch {
		return null;
	}
}

/**
 * Refuse to write a report anywhere near the database file.
 *
 * A lexical comparison is not enough. `Bun.write` follows symlinks and truncates
 * whatever is on the other end, and a hard link gives one inode two paths that
 * never converge no matter how they are resolved. So this compares CANONICAL
 * paths (which defeats symlinks, including a symlinked parent directory) and,
 * when the target already exists, its `(dev, ino)` pair against the database and
 * every sidecar present (which defeats hard links).
 */
export function assertSafeOutPath(outPath: string, dbPath: string): void {
	const dbBases = [canonicalTarget(dbPath), resolve(dbPath)];
	const out = canonicalTarget(outPath);

	// Canonical path -> how the refusal should describe it.
	const forbidden = new Map<string, string>();
	for (const base of dbBases) {
		if (!forbidden.has(base)) forbidden.set(base, "the database path");
		for (const suffix of DB_SIDECAR_SUFFIXES) {
			// A sidecar may be absent right now (SQLite creates and removes them),
			// so guard the name next to the database as well as, when it IS there,
			// its own canonical path.
			forbidden.set(`${base}${suffix}`, "a database sidecar");
			const real = canonicalExisting(`${base}${suffix}`);
			if (real != null) forbidden.set(real, "a database sidecar");
		}
	}
	const named = forbidden.get(out);
	if (named != null) {
		throw new Error(`--out refuses to write to ${named}: ${out}`);
	}

	const outIdentity = fileIdentity(out);
	if (outIdentity == null) return;
	for (const base of dbBases) {
		if (fileIdentity(base) === outIdentity) {
			throw new Error(
				`--out refuses to write to a hard link of the database: ${out}`,
			);
		}
		for (const suffix of DB_SIDECAR_SUFFIXES) {
			if (fileIdentity(`${base}${suffix}`) === outIdentity) {
				throw new Error(
					`--out refuses to write to a hard link of a database sidecar: ${out}`,
				);
			}
		}
	}
}

const SHELL_SAFE_ARG = /^[A-Za-z0-9_./:=,@+-]+$/;

/**
 * Quote one argument for a POSIX shell so a recorded command can be pasted
 * back verbatim. Bare when it holds only characters no shell touches, otherwise
 * single-quoted, with each embedded quote closed and reopened.
 */
export function shellQuoteArg(arg: string): string {
	if (SHELL_SAFE_ARG.test(arg)) return arg;
	return `'${arg.replaceAll("'", "'\\''")}'`;
}
