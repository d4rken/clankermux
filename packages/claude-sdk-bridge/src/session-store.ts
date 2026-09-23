import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	SessionKey,
	SessionStore,
	SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import {
	appendPrivateFile,
	ensurePrivateDir,
	removeTree,
	writePrivateFile,
} from "./work-dirs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBPATH = /^[A-Za-z0-9_./-]{1,200}$/;

function assertSessionId(sessionId: string): void {
	if (!UUID.test(sessionId))
		throw new Error(`Invalid session id ${JSON.stringify(sessionId)}`);
}

/**
 * Claude Code session transcripts as JSONL files under one directory. With a
 * `sessionStore`, the SDK resumes from what `load()` returns and mirrors every
 * new transcript entry through `append()`, so this directory is the only
 * copy of a session the bridge relies on.
 */
export class FileSessionStore implements SessionStore {
	constructor(private readonly dir: string) {
		ensurePrivateDir(dir);
	}

	private path(key: Pick<SessionKey, "sessionId" | "subpath">): string {
		assertSessionId(key.sessionId);
		if (key.subpath === undefined)
			return join(this.dir, `${key.sessionId}.jsonl`);
		if (!SUBPATH.test(key.subpath) || key.subpath.includes(".."))
			throw new Error(`Invalid session subpath ${JSON.stringify(key.subpath)}`);
		return join(
			this.dir,
			`${key.sessionId}.${key.subpath.replaceAll("/", "__")}.jsonl`,
		);
	}

	async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
		if (!entries.length) return;
		appendPrivateFile(
			this.path(key),
			`${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
		);
	}

	async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
		return this.read(key.sessionId, key.subpath);
	}

	read(sessionId: string, subpath?: string): SessionStoreEntry[] | null {
		const path = this.path({ sessionId, subpath });
		if (!existsSync(path)) return null;
		return readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as SessionStoreEntry);
	}

	write(sessionId: string, entries: SessionStoreEntry[]): void {
		writePrivateFile(
			this.path({ sessionId }),
			entries.length
				? `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`
				: "",
		);
	}

	/**
	 * Copy a session under a new id, so a turn that fails or is aborted leaves
	 * the conversation's last good session untouched. False when there is no
	 * readable session to copy; the turn then rebuilds instead.
	 */
	fork(fromId: string, toId: string): boolean {
		let entries: SessionStoreEntry[] | null;
		try {
			entries = this.read(fromId);
		} catch {
			return false;
		}
		if (!entries) return false;
		this.write(
			toId,
			entries.map((entry) =>
				"sessionId" in entry ? { ...entry, sessionId: toId } : entry,
			),
		);
		return true;
	}

	async delete(key: SessionKey): Promise<void> {
		this.remove(key.sessionId);
	}

	/** The session's main transcript and every subpath transcript beside it. */
	remove(sessionId: string): void {
		try {
			assertSessionId(sessionId);
		} catch {
			return;
		}
		let names: string[] = [];
		try {
			names = readdirSync(this.dir);
		} catch {
			return;
		}
		for (const name of names)
			if (
				name === `${sessionId}.jsonl` ||
				(name.startsWith(`${sessionId}.`) && name.endsWith(".jsonl"))
			)
				removeTree(join(this.dir, name));
	}
}

/**
 * Claude Code keeps its own copy of every session under
 * `<configDir>/projects/<project>/`: `<id>.jsonl`, and a `<id>/` directory for
 * sub-agent transcripts. The bridge resumes only from its session store, so
 * these copies are dead weight once the query is over.
 */
export function removeClaudeCodeTranscripts(
	configDir: string,
	sessionId: string,
): void {
	try {
		assertSessionId(sessionId);
	} catch {
		return;
	}
	const projects = join(configDir, "projects");
	let names: string[] = [];
	try {
		names = readdirSync(projects);
	} catch {
		return;
	}
	for (const name of names) {
		const project = join(projects, name);
		try {
			if (!lstatSync(project).isDirectory()) continue;
		} catch {
			continue;
		}
		removeTree(join(project, `${sessionId}.jsonl`));
		removeTree(join(project, sessionId));
	}
}
