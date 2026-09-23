import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
	SessionKey,
	SessionStore,
	SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBPATH = /^[A-Za-z0-9_./-]{1,200}$/;

/**
 * Claude Code session transcripts as JSONL files under one directory. With a
 * `sessionStore`, the SDK resumes from what `load()` returns and mirrors every
 * new transcript entry through `append()`, so this directory is the only
 * copy of a session the bridge relies on.
 */
export class FileSessionStore implements SessionStore {
	constructor(private readonly dir: string) {
		mkdirSync(dir, { recursive: true });
	}

	private path(key: Pick<SessionKey, "sessionId" | "subpath">): string {
		if (!UUID.test(key.sessionId))
			throw new Error(`Invalid session id ${JSON.stringify(key.sessionId)}`);
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
		appendFileSync(
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
		writeFileSync(
			this.path({ sessionId }),
			entries.length
				? `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`
				: "",
		);
	}

	/**
	 * Copy a session under a new id, so a turn that fails or is aborted leaves
	 * the conversation's last good session untouched.
	 */
	fork(fromId: string, toId: string): boolean {
		const entries = this.read(fromId);
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

	remove(sessionId: string): void {
		try {
			rmSync(this.path({ sessionId }), { force: true });
		} catch {}
	}
}
