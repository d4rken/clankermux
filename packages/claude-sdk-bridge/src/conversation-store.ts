import { createHash } from "node:crypto";

/** A Claude Code session a conversation's next turn may resume. */
export interface StoredSession {
	sessionId: string;
	/** Message digests of the conversation this session holds, as the client sees it. */
	digests: string[];
	/** The account the turn was planned on. */
	accountId: string | null;
}

interface ConversationRecord {
	current: StoredSession | null;
	/** Registration order of `current`, so a late settle never replaces a newer session. */
	currentSeq: number;
	nextSeq: number;
	pending: { session: StoredSession; done: Promise<boolean> } | null;
	/** Resolves when the turn holding the conversation registers or ends. */
	busy: Promise<void> | null;
	lastUsed: number;
}

/** Affinity scopes that come from a client session header. */
const SESSION_SCOPES = new Set([
	"claude_session",
	"codex_thread",
	"client_session",
]);

/**
 * The conversation a turn belongs to, or null without a session header: then
 * every turn is a fresh session, because matching histories alone never prove
 * two requests share a conversation. The first user message is part of the
 * key so a client's helper calls sharing the header (OpenCode's title and
 * summary requests) never resume the main conversation.
 */
export function conversationKey(input: {
	apiKeyId: string | null;
	affinityScope: string | null;
	affinityKey: string | null;
	firstUserDigest: string;
}): string | null {
	if (!input.affinityScope || !SESSION_SCOPES.has(input.affinityScope))
		return null;
	if (!input.affinityKey) return null;
	return createHash("sha256")
		.update(
			JSON.stringify([
				input.apiKeyId,
				input.affinityScope,
				input.affinityKey,
				input.firstUserDigest,
			]),
		)
		.digest("hex");
}

export interface ConversationClaim {
	/** The settled session to resume from, if any. */
	current: StoredSession | null;
	/** Register this turn's session once its reply has ended (`message_stop`). */
	register(session: StoredSession, done: Promise<boolean>): void;
	/** Give the conversation up without registering (failure, abort, rejection). */
	release(): void;
}

export class ConversationStore {
	private readonly records = new Map<string, ConversationRecord>();

	constructor(
		private readonly opts: {
			now: () => number;
			/** Called with a session id no conversation will resume again. */
			onDiscard: (sessionId: string) => void;
			maxEntries?: number;
			idleTtlMs?: number;
		},
	) {}

	get size(): number {
		return this.records.size;
	}

	/**
	 * Take the conversation for one turn. Waits, at most `waitMs` in total, for
	 * a turn already holding it and then for that turn's session to settle.
	 */
	async claim(key: string, waitMs: number): Promise<ConversationClaim> {
		this.prune();
		// Waits run on the real clock; `now` only dates records.
		const deadline = Date.now() + waitMs;
		let record = this.records.get(key);
		while (record?.busy) {
			const left = deadline - Date.now();
			if (left <= 0) break;
			await Promise.race([record.busy, Bun.sleep(left)]);
			record = this.records.get(key);
		}
		if (record?.pending) {
			const left = Math.max(0, deadline - Date.now());
			await Promise.race([record.pending.done, Bun.sleep(left)]);
			await Promise.resolve();
		}
		record = this.records.get(key) ?? {
			current: null,
			currentSeq: 0,
			nextSeq: 1,
			pending: null,
			busy: null,
			lastUsed: this.opts.now(),
		};
		this.records.set(key, record);
		record.lastUsed = this.opts.now();
		// A turn still unsettled after the wait is ignored, not resumed.
		const current = record.current;
		let releaseBusy!: () => void;
		const busy = new Promise<void>((resolve) => {
			releaseBusy = resolve;
		});
		record.busy = busy;
		const owned = record;
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			if (owned.busy === busy) owned.busy = null;
			releaseBusy();
		};
		return {
			current,
			register: (session, done) => {
				if (finished) return;
				owned.pending = { session, done };
				this.settle(owned, session, done, owned.nextSeq++);
				finish();
			},
			release: finish,
		};
	}

	private settle(
		record: ConversationRecord,
		session: StoredSession,
		done: Promise<boolean>,
		seq: number,
	): void {
		void done.then((ok) => {
			if (record.pending?.session === session) record.pending = null;
			if (!ok || seq < record.currentSeq) {
				this.opts.onDiscard(session.sessionId);
				return;
			}
			const replaced = record.current;
			record.current = session;
			record.currentSeq = seq;
			if (replaced && replaced.sessionId !== session.sessionId)
				this.opts.onDiscard(replaced.sessionId);
		});
	}

	private prune(): void {
		const ttl = this.opts.idleTtlMs ?? 24 * 60 * 60_000;
		const max = this.opts.maxEntries ?? 1000;
		const now = this.opts.now();
		const idle = [...this.records.entries()].filter(
			([, r]) => !r.busy && !r.pending,
		);
		const expired = idle.filter(([, r]) => now - r.lastUsed > ttl);
		const overflow = Math.max(0, this.records.size - expired.length - max);
		const oldest = idle
			.filter(([, r]) => now - r.lastUsed <= ttl)
			.sort((a, b) => a[1].lastUsed - b[1].lastUsed)
			.slice(0, overflow);
		for (const [key, record] of [...expired, ...oldest]) {
			this.records.delete(key);
			if (record.current) this.opts.onDiscard(record.current.sessionId);
		}
	}
}
