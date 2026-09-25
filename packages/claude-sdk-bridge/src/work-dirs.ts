import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	type Stats,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

// Everything the bridge writes (session transcripts, Claude Code's config
// dir, its TMPDIR) holds conversation content, so it is private to the
// server's user, and nothing here follows a symlink it did not create.

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

function lstatOrNull(path: string): Stats | null {
	try {
		return lstatSync(path);
	} catch {
		return null;
	}
}

/**
 * Create `path` and its missing parents as private directories, and make an
 * existing one private. A symlink or a file at `path` is refused.
 */
export function ensurePrivateDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
	const stat = lstatSync(path);
	if (!stat.isDirectory())
		throw new Error(`${path} is not a directory (a symlink or a file)`);
	if ((stat.mode & 0o777) !== PRIVATE_DIR_MODE)
		chmodSync(path, PRIVATE_DIR_MODE);
}

function writeAll(fd: number, data: string): void {
	const bytes = Buffer.from(data, "utf8");
	let offset = 0;
	while (offset < bytes.length)
		offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

function openPrivate(path: string, flags: number): number {
	const fd = openSync(
		path,
		flags | constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
		PRIVATE_FILE_MODE,
	);
	try {
		// The mode above applies only to a file this call created.
		if ((fstatSync(fd).mode & 0o777) !== PRIVATE_FILE_MODE)
			fchmodSync(fd, PRIVATE_FILE_MODE);
	} catch (error) {
		closeSync(fd);
		throw error;
	}
	return fd;
}

/** Replace a file's content; the file is private and never a symlink's target. */
export function writePrivateFile(path: string, data: string): void {
	const fd = openPrivate(path, constants.O_TRUNC);
	try {
		writeAll(fd, data);
	} finally {
		closeSync(fd);
	}
}

/** Replace a file's content with `bytes`; private, never through a symlink. */
export function writePrivateBytes(path: string, bytes: Uint8Array): void {
	const fd = openPrivate(path, constants.O_TRUNC);
	try {
		let offset = 0;
		while (offset < bytes.length)
			offset += writeSync(fd, bytes, offset, bytes.length - offset);
	} finally {
		closeSync(fd);
	}
}

/** Append to a private file, creating it. */
export function appendPrivateFile(path: string, data: string): void {
	const fd = openPrivate(path, constants.O_APPEND);
	try {
		writeAll(fd, data);
	} finally {
		closeSync(fd);
	}
}

/**
 * Delete a file or a directory tree without following symlinks: a link is
 * removed, never what it points to. Iterative, so depth costs no stack.
 * Missing paths and entries that vanish meanwhile are ignored.
 */
export function removeTree(path: string): void {
	const root = lstatOrNull(path);
	if (!root) return;
	if (!root.isDirectory()) {
		try {
			unlinkSync(path);
		} catch {}
		return;
	}
	const stack: Array<{ path: string; listed: boolean }> = [
		{ path, listed: false },
	];
	while (stack.length) {
		const top = stack[stack.length - 1] as { path: string; listed: boolean };
		if (top.listed) {
			stack.pop();
			try {
				rmdirSync(top.path);
			} catch {}
			continue;
		}
		top.listed = true;
		// Checked again right before listing: it was a directory when pushed.
		if (!lstatOrNull(top.path)?.isDirectory()) continue;
		let names: string[] = [];
		try {
			names = readdirSync(top.path);
		} catch {}
		for (const name of names) {
			const child = join(top.path, name);
			const stat = lstatOrNull(child);
			if (!stat) continue;
			if (stat.isDirectory()) stack.push({ path: child, listed: false });
			else
				try {
					unlinkSync(child);
				} catch {}
		}
	}
}

const GENERATION_DIR = /^gen-[A-Za-z0-9_-]{1,100}$/;
const OWNER_FILE = "owner.json";
/** A generation with no readable owner is left alone this long (mid-creation). */
const OWNERLESS_GRACE_MS = 60_000;

interface GenerationOwner {
	pid: number;
	/** /proc start time of `pid`, so a recycled pid does not keep a dead generation. */
	startTime: string | null;
}

/** Field 22 of /proc/<pid>/stat, or null where /proc is unreadable. */
export function processStartTime(pid: number): string | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// The command name may hold spaces and parentheses; fields follow the last ")".
		const fields = stat
			.slice(stat.lastIndexOf(")") + 2)
			.trim()
			.split(/\s+/);
		return fields[19] ?? null;
	} catch {
		return null;
	}
}

function ownerAlive(owner: GenerationOwner): boolean {
	try {
		process.kill(owner.pid, 0);
	} catch {
		// ESRCH, or EPERM: a pid another user holds now is no bridge of ours.
		return false;
	}
	if (owner.startTime === null) return true;
	const now = processStartTime(owner.pid);
	return now === null || now === owner.startTime;
}

function readOwner(dir: string): GenerationOwner | null {
	return readOwnerFile(join(dir, OWNER_FILE));
}

function readOwnerFile(path: string): GenerationOwner | null {
	try {
		if (!lstatSync(path).isFile()) return null;
		const parsed = JSON.parse(
			readFileSync(path, "utf8"),
		) as Partial<GenerationOwner>;
		if (typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid))
			return null;
		return {
			pid: parsed.pid,
			startTime: typeof parsed.startTime === "string" ? parsed.startTime : null,
		};
	} catch {
		return null;
	}
}

/**
 * This bridge's own directory under `workRoot`, marked with the owning pid so
 * another bridge process sharing the root never deletes it while it runs.
 */
export function claimGeneration(workRoot: string, id: string): string {
	const name = `gen-${id}`;
	if (!GENERATION_DIR.test(name))
		throw new Error(`Invalid generation id ${JSON.stringify(id)}`);
	ensurePrivateDir(workRoot);
	const dir = join(workRoot, name);
	ensurePrivateDir(dir);
	const owner: GenerationOwner = {
		pid: process.pid,
		startTime: processStartTime(process.pid),
	};
	writePrivateFile(join(dir, OWNER_FILE), JSON.stringify(owner));
	return dir;
}

/**
 * Remove the generations earlier bridge processes left under `workRoot`:
 * every `gen-*` directory other than `keep` whose owner is no longer running.
 * Returns the names removed.
 */
export function sweepGenerations(
	workRoot: string,
	keep: string,
	now: number = Date.now(),
): string[] {
	let names: string[];
	try {
		names = readdirSync(workRoot);
	} catch {
		return [];
	}
	const removed: string[] = [];
	for (const name of names) {
		if (!GENERATION_DIR.test(name)) continue;
		const dir = join(workRoot, name);
		if (dir === keep) continue;
		const stat = lstatOrNull(dir);
		if (!stat?.isDirectory()) continue;
		const owner = readOwner(dir);
		if (owner ? ownerAlive(owner) : now - stat.mtimeMs < OWNERLESS_GRACE_MS)
			continue;
		removeTree(dir);
		removed.push(name);
	}
	return removed;
}

/** Whether the process a lock or generation names still runs (same start time). */
export function ownerRunning(owner: {
	pid: number;
	startTime: string | null;
}): boolean {
	return ownerAlive(owner);
}

/**
 * Take the lock file at `path` for this process, marked with `token` so only
 * its taker releases it. The lock is written complete under a temp name and
 * hard-linked into place, which fails if a lock exists: there is never an
 * empty or half-written lock to misread. A lock whose owner is gone (or
 * unreadable) is renamed aside, and taken over only if what was moved is the
 * file that was inspected (same inode); one held by a live process, this
 * one included, is not taken.
 */
export function acquireOwnerLock(path: string, token: string): boolean {
	const content = JSON.stringify({
		pid: process.pid,
		startTime: processStartTime(process.pid),
		token,
	});
	for (let attempt = 0; attempt < 3; attempt++) {
		const temp = `${path}.${token}.${attempt}.tmp`;
		removeTree(temp);
		writePrivateFile(temp, content);
		try {
			linkSync(temp, path);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		} finally {
			removeTree(temp);
		}
		let inode: number;
		let owner: (GenerationOwner & { token?: unknown }) | null = null;
		try {
			const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				inode = fstatSync(fd).ino;
				const parsed = JSON.parse(readFileSync(fd, "utf8")) as Record<
					string,
					unknown
				>;
				if (typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid))
					owner = {
						pid: parsed.pid,
						startTime:
							typeof parsed.startTime === "string" ? parsed.startTime : null,
						token: parsed.token,
					};
			} catch {
				inode = fstatSync(fd).ino;
			} finally {
				closeSync(fd);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (owner?.token === token) return true;
		if (owner && ownerAlive(owner)) return false;
		const aside = `${path}.stale-${token}-${attempt}`;
		try {
			renameSync(path, aside);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		let moved: number | null = null;
		try {
			moved = lstatSync(aside).ino;
		} catch {}
		if (moved !== inode) {
			// Someone replaced the stale lock between the look and the rename:
			// put theirs back unless yet another took the place, and yield.
			try {
				linkSync(aside, path);
			} catch {}
			removeTree(aside);
			return false;
		}
		removeTree(aside);
	}
	return false;
}

/** Give up a lock this `token` took; anyone else's is left alone. */
export function releaseOwnerLock(path: string, token: string): void {
	try {
		if (!lstatSync(path).isFile()) return;
		const held = JSON.parse(readFileSync(path, "utf8")) as { token?: unknown };
		if (held.token === token) unlinkSync(path);
	} catch {}
}

/**
 * Write `bytes` to `dir/name` so that a crash leaves either nothing or the
 * whole file: a private temp file in the same directory, synced, then
 * renamed over the name. Returns the bytes written.
 */
export function publishFileAtomically(
	dir: string,
	name: string,
	bytes: Uint8Array,
	tempName: string,
): number {
	const temp = join(dir, tempName);
	const fd = openSync(
		temp,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_NOFOLLOW,
		PRIVATE_FILE_MODE,
	);
	try {
		let offset = 0;
		while (offset < bytes.length)
			offset += writeSync(fd, bytes, offset, bytes.length - offset);
		fsyncSync(fd);
	} catch (error) {
		closeSync(fd);
		removeTree(temp);
		throw error;
	}
	closeSync(fd);
	try {
		renameSync(temp, join(dir, name));
	} catch (error) {
		removeTree(temp);
		throw error;
	}
	try {
		const dirFd = openSync(dir, constants.O_RDONLY);
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
	} catch {}
	return bytes.length;
}
