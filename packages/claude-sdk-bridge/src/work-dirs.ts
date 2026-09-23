import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
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
	try {
		const path = join(dir, OWNER_FILE);
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
