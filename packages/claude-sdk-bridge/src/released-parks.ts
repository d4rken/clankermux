import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import type {
	EffortLevel,
	SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type {
	ProjectAttributionSource,
	SdkBridgeReleasedPark,
	SdkBridgeReleasedParkInsert,
	SdkBridgeRoutePlan,
	SdkBridgeTurnFinish,
} from "@clankermux/types";
import { type BridgeError, errorSummary } from "./errors";
import { logTurnFinished } from "./recorder";
import { type FileSessionStore, rewriteSessionId } from "./session-store";
import type { SystemPromptDecision } from "./system-prompt-policy";
import type { ClientTool } from "./turn-request";
import type {
	BridgeLog,
	SdkBridgeParkRepo,
	SdkBridgeTurnHistory,
} from "./types";
import {
	ensurePrivateDir,
	ownerRunning,
	processStartTime,
	publishFileAtomically,
	removeTree,
	writePrivateBytes,
} from "./work-dirs";

/**
 * Everything a resume needs that the late request must not change: the
 * turn's frozen route plan and the settings its Claude Code query ran with.
 */
export interface ResumeDescriptor {
	v: 1;
	plan: SdkBridgeRoutePlan;
	tools: ClientTool[];
	systemPrompt: SystemPromptDecision;
	effort: EffortLevel | null;
	maxOutputTokens: number | null;
	apiKeyName: string | null;
	clientHarness: string | null;
	project: string | null;
	projectAttributionSource: ProjectAttributionSource | null;
	turnStartedAt: number;
	/** The turn's own history decision; absent in parks stored before it was kept. */
	history?: SdkBridgeTurnHistory;
}

/** A transition the database has not confirmed yet, retried until it does. */
export type PendingParkWrite =
	/** Give back the claim of this generation, and only it. */
	| { kind: "unclaim"; claimId: string }
	| { kind: "forget" }
	| {
			kind: "close";
			error: BridgeError;
			status: SdkBridgeTurnFinish["status"];
	  }
	/** What the database holds is unknown (a failed claim): read it back. */
	| { kind: "resync" };

/** A released park as the bridge holds it in memory. */
export interface ReleasedEntry {
	park: SdkBridgeReleasedPark;
	descriptor: ResumeDescriptor;
	/**
	 * `released`: resumable. `claimed`: a resume holds it (from the
	 * synchronous claim on). `reconciling`: a transition failed or is not
	 * confirmed; not claimable until the background retry settles it.
	 */
	state: "released" | "claimed" | "reconciling";
	/** Set with `reconciling`: what the retry must get the database to agree to. */
	pending: PendingParkWrite | null;
	/** The resumed query made its first model call: the park is spent. */
	consumed: boolean;
	/** The consumed mark in flight; a close waits for it before deciding. */
	consuming: Promise<void> | null;
	/** The generation of this process's current claim of it. */
	claimId: string | null;
	/** The entry's park write running now; the next one waits for it. */
	work: Promise<unknown> | null;
	/** A new turn of the conversation arrived while it was being claimed. */
	superseded?: boolean;
	path: string;
}

const NAMESPACE = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_FILE = /^[0-9a-f-]{36}\.jsonl$/;

/**
 * The entry `resumeAt` of a transcript (JSONL bytes), when its chain,
 * walking parentUuid back from it to an entry whose parentUuid is null,
 * carries every awaited tool_use id; null otherwise. With it, the calls on
 * that chain, oldest first, a resume has to answer: every awaited one, and
 * every other one without a result of its own. A result is a call's own
 * when it descends from the entry holding the call or names that entry as
 * its `sourceToolAssistantUUID` (Claude Code writes a parallel call's
 * result as a child of its call, off the chain); one for the same id
 * elsewhere does not count. Each line is decoded on its own; an unparsable
 * line or a parent missing from the file fails the check.
 */
function resumePoint(
	bytes: Buffer,
	resumeAt: string,
	awaited: readonly string[],
): { entry: Record<string, unknown>; unanswered: string[] } | null {
	const byUuid = new Map<string, { parent: string | null; calls: string[] }>();
	/** For each tool_use id, the entries holding a result for it. */
	const results = new Map<string, Array<{ uuid: string; source: unknown }>>();
	let point: Record<string, unknown> | null = null;
	let start = 0;
	while (start < bytes.length) {
		let end = bytes.indexOf(0x0a, start);
		if (end === -1) end = bytes.length;
		if (end > start) {
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(bytes.toString("utf8", start, end)) as Record<
					string,
					unknown
				>;
			} catch {
				return null;
			}
			if (typeof entry.uuid === "string") {
				const content = (entry.message as { content?: unknown } | undefined)
					?.content;
				const blocks = Array.isArray(content)
					? (content as Array<{
							type?: unknown;
							id?: unknown;
							tool_use_id?: unknown;
						}>)
					: [];
				for (const b of blocks) {
					if (b?.type !== "tool_result") continue;
					const id = String(b.tool_use_id);
					const own = results.get(id) ?? [];
					own.push({ uuid: entry.uuid, source: entry.sourceToolAssistantUUID });
					results.set(id, own);
				}
				byUuid.set(entry.uuid, {
					parent:
						typeof entry.parentUuid === "string" ? entry.parentUuid : null,
					calls:
						entry.type === "assistant"
							? blocks
									.filter((b) => b?.type === "tool_use")
									.map((b) => String(b.id))
							: [],
				});
				if (entry.uuid === resumeAt) point = entry;
			}
		}
		start = end + 1;
	}
	if (!point) return null;
	const chain: Array<{ uuid: string; calls: string[] }> = [];
	const seen = new Set<string>();
	let at: string | null = resumeAt;
	while (at && !seen.has(at)) {
		seen.add(at);
		const entry = byUuid.get(at);
		// A parent the file does not hold: the chain Claude Code loads is not whole.
		if (!entry) return null;
		chain.push({ uuid: at, calls: entry.calls });
		at = entry.parent;
	}
	chain.reverse();
	const found = chain.flatMap((e) => e.calls);
	if (!awaited.every((id) => found.includes(id))) return null;
	const descends = (from: string, ancestor: string): boolean => {
		const walked = new Set<string>();
		let up = byUuid.get(from)?.parent ?? null;
		while (up && !walked.has(up)) {
			if (up === ancestor) return true;
			walked.add(up);
			up = byUuid.get(up)?.parent ?? null;
		}
		return false;
	};
	const answeredHere = (id: string, holder: string) =>
		(results.get(id) ?? []).some(
			(r) => r.source === holder || descends(r.uuid, holder),
		);
	return {
		entry: point,
		unanswered: chain.flatMap((e) =>
			e.calls.filter((id) => awaited.includes(id) || !answeredHere(id, e.uuid)),
		),
	};
}

/** The fields {@link answerEntry} takes from its resume point. */
const ANSWER_ENVELOPE = [
	"cwd",
	"userType",
	"entrypoint",
	"version",
	"gitBranch",
] as const;

/**
 * A user entry answering `calls`, as a child of the resume point `point`.
 * On resume Claude Code drops calls that have no result on the chain
 * before it looks for `resumeSessionAt`, and puts them back only in some
 * cases (not after a prompt it wrote nothing else for, nor after text in
 * the same message). With this entry after them, no call is unanswered; it
 * lies past the resume point, so Claude Code cuts it off before any model
 * call and the client's results are the prompt. Pinned by "resumes parks
 * released from resumed sessions and from a call after text" in
 * real-claude.integration.test.ts.
 */
function answerEntry(
	point: Record<string, unknown>,
	sessionId: string,
	calls: readonly string[],
): SessionStoreEntry {
	const envelope: Record<string, unknown> = {};
	for (const key of ANSWER_ENVELOPE)
		if (point[key] !== undefined) envelope[key] = point[key];
	return {
		type: "user",
		uuid: crypto.randomUUID(),
		parentUuid: point.uuid,
		sourceToolAssistantUUID: point.uuid,
		isSidechain: false,
		sessionId,
		timestamp: new Date().toISOString(),
		...envelope,
		message: {
			role: "user",
			content: calls.map((id) => ({
				type: "tool_result",
				tool_use_id: id,
				content: "",
			})),
		},
	};
}

function lstatOrNull(path: string) {
	try {
		return lstatSync(path);
	} catch {
		return null;
	}
}

/** A regular file's bytes, opened without following a symlink; null otherwise. */
function readFileOrNull(path: string): Buffer | null {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		return null;
	}
	try {
		if (!fstatSync(fd).isFile()) return null;
		return readFileSync(fd);
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}

/**
 * Whether the transcript at `path` holds the parked calls on the chain
 * ending at `resumeAt`. Parses the whole file: for a release, which checks
 * what Claude Code stored before publishing it.
 */
export function transcriptHoldsCalls(
	path: string,
	resumeAt: string,
	awaited: readonly string[],
): boolean {
	const bytes = readFileOrNull(path);
	return bytes !== null && resumePoint(bytes, resumeAt, awaited) !== null;
}

/**
 * A resume's copy of a released session: read once, the chain checked,
 * then written under the new id with only `"sessionId":"<from>"` rewritten.
 * Returns the {@link answerEntry} the resumed query has to load after the
 * copy; null, writing nothing, when the file is gone or does not hold the
 * calls. Synchronous: the claimed park is copied with no await in between.
 */
export function forkVerifiedTranscript(
	from: string,
	to: string,
	fromId: string,
	toId: string,
	resumeAt: string,
	awaited: readonly string[],
): SessionStoreEntry | null {
	const bytes = readFileOrNull(from);
	const point = bytes ? resumePoint(bytes, resumeAt, awaited) : null;
	if (!bytes || !point) return null;
	writePrivateBytes(to, rewriteSessionId(bytes, fromId, toId));
	return answerEntry(point.entry, toId, point.unanswered);
}

/**
 * Whether a stored session looks whole without parsing it: a regular file of
 * the size its record names, holding the resume point's entry.
 */
function fileLooksWhole(
	path: string,
	bytes: number,
	resumeAt: string,
): boolean {
	const content = readFileOrNull(path);
	return (
		content !== null &&
		content.length === bytes &&
		content.includes(`"uuid":"${resumeAt}"`)
	);
}

/**
 * Released parks: session files in `<workRoot>/released-parks/<namespace>`
 * (the namespace names the database) and their records in the database.
 *
 * The database lease is the only authority. This store takes it under its
 * own token, and every durable write goes through a repository method that
 * applies only while that token holds the lease: once the lease has moved on
 * (this process declared dead) or been given up (dispose), whatever is
 * still in flight changes nothing. A refused or failed write leaves the
 * entry `reconciling` with the write pending, and {@link reconcile} retries
 * it until the database agrees; the entry turns `released` locally only
 * after a confirmed success.
 *
 * Records store the absolute path of their file, so the lease holder
 * recovers parks whose files another work root wrote; only paths inside a
 * released-parks directory of this database are accepted, never through a
 * symlink.
 */
export class ReleasedParkStore {
	readonly dir: string;
	/** The lease token, and the claim owner of this process's claims. */
	readonly token = randomBytes(16).toString("hex");
	private leased = false;
	private entries = new Map<string, ReleasedEntry>();
	private byToolId = new Map<string, string>();
	private readonly owner = {
		pid: process.pid,
		startTime: processStartTime(process.pid),
	};

	constructor(
		private readonly opts: {
			workRoot: string;
			repo: SdkBridgeParkRepo;
			/** The same repository with a short busy-retry budget, for startup. */
			recoveryRepo?: SdkBridgeParkRepo;
			log: BridgeLog;
			now: () => number;
			/** The database's own subdirectory ({@link ClaudeSdkBridgeDeps.parkNamespace}). */
			namespace: string;
		},
	) {
		if (!NAMESPACE.test(opts.namespace))
			throw new Error(`Invalid released-park namespace ${opts.namespace}`);
		this.dir = join(opts.workRoot, "released-parks", opts.namespace);
	}

	/**
	 * Take the lease (free, already ours, or its holder's process gone).
	 * False when another live process holds it.
	 */
	async takeLease(repo: SdkBridgeParkRepo = this.opts.repo): Promise<boolean> {
		this.leased = await repo.acquireLease(
			{
				dir: this.dir,
				pid: this.owner.pid,
				startTime: this.owner.startTime,
				token: this.token,
				at: this.opts.now(),
			},
			(held) => !ownerRunning(held),
		);
		return this.leased;
	}

	/** This process holds the lease, as far as it knows. */
	get usable(): boolean {
		return this.leased;
	}

	/** Give the lease up: from here every write of this store is refused. */
	async dispose(): Promise<void> {
		if (this.leased)
			await this.opts.repo.releaseLease(this.token).catch((error) => {
				this.opts.log.warn(
					"SDK bridge: could not give the park lease up",
					error,
				);
			});
		this.leased = false;
		this.entries.clear();
		this.byToolId.clear();
	}

	get size(): number {
		return this.entries.size;
	}

	all(): ReleasedEntry[] {
		return [...this.entries.values()];
	}

	get(turnId: string): ReleasedEntry | undefined {
		return this.entries.get(turnId);
	}

	/** The park waiting on any of `ids`, whatever its state. */
	lookup(ids: readonly string[]): ReleasedEntry | null {
		for (const id of ids) {
			const turnId = this.byToolId.get(id);
			const entry = turnId ? this.entries.get(turnId) : undefined;
			if (entry) return entry;
		}
		return null;
	}

	byConversation(key: string): ReleasedEntry[] {
		return this.all().filter((e) => e.park.conversationKeyHash === key);
	}

	totalBytes(): number {
		let total = 0;
		for (const entry of this.entries.values()) total += entry.park.fileBytes;
		return total;
	}

	private index(entry: ReleasedEntry): void {
		this.entries.set(entry.park.turnId, entry);
		for (const id of entry.park.awaitedToolUseIds)
			this.byToolId.set(id, entry.park.turnId);
	}

	private unindex(turnId: string): void {
		const entry = this.entries.get(turnId);
		if (!entry) return;
		this.entries.delete(turnId);
		for (const id of entry.park.awaitedToolUseIds)
			if (this.byToolId.get(id) === turnId) this.byToolId.delete(id);
	}

	/**
	 * Whether a recorded path is one of this database's park files:
	 * `<root>/released-parks/<namespace>/<uuid>.jsonl`, absolute and
	 * normalized, reached without any symlink. The root is this store's own
	 * work root (trusted as configured) or a directory whose whole path
	 * holds no symlink (its real path is itself); below it, `released-parks`,
	 * the namespace directory and the file are each checked with lstat.
	 */
	acceptsPath(path: string): boolean {
		if (!isAbsolute(path) || normalize(path) !== path) return false;
		if (!SESSION_FILE.test(basename(path))) return false;
		const ns = dirname(path);
		const parks = dirname(ns);
		const root = dirname(parks);
		if (basename(ns) !== this.opts.namespace) return false;
		if (basename(parks) !== "released-parks") return false;
		try {
			if (root !== this.opts.workRoot && realpathSync(root) !== root)
				return false;
			return (
				lstatSync(parks).isDirectory() &&
				lstatSync(ns).isDirectory() &&
				lstatSync(path).isFile()
			);
		} catch {
			return false;
		}
	}

	/**
	 * Delete a park's file, only through a path that passes
	 * {@link acceptsPath}: removal must never follow a symlink an ancestor
	 * was replaced with. A refused path is logged and left alone; a missing
	 * file has nothing to delete.
	 */
	private removeParkFile(path: string): void {
		if (this.acceptsPath(path)) {
			removeTree(path);
			return;
		}
		try {
			lstatSync(path);
		} catch {
			return;
		}
		this.opts.log.warn(
			`SDK bridge: not deleting ${path}: its path is not a released-parks file of this database reached without a symlink`,
		);
	}

	/**
	 * Whether this store's own directory is reached without a symlink below
	 * the work root: the orphan sweep only lists and deletes inside it then.
	 */
	private ownDirIsSafe(): boolean {
		try {
			return (
				lstatSync(dirname(this.dir)).isDirectory() &&
				lstatSync(this.dir).isDirectory()
			);
		} catch {
			return false;
		}
	}

	/**
	 * A resume's copy of a park in `sessions`: the path checked again as at
	 * recovery, then read once, the chain verified and written under the new
	 * id, with the calls' answer queued for the resumed query's load.
	 */
	forkForResume(
		entry: ReleasedEntry,
		sessions: FileSessionStore,
		toId: string,
	): boolean {
		if (!this.acceptsPath(entry.path)) return false;
		const answer = forkVerifiedTranscript(
			entry.path,
			sessions.pathOf(toId),
			entry.park.sessionId,
			toId,
			entry.park.resumeAt,
			entry.park.awaitedToolUseIds,
		);
		if (!answer) return false;
		sessions.appendOnLoad(toId, [answer]);
		return true;
	}

	/**
	 * Run `write` after the entry's park write in flight, if any: an entry
	 * never has two writes racing (a retry against an unclaim, say).
	 */
	private serial<T>(entry: ReleasedEntry, write: () => Promise<T>): Promise<T> {
		const previous = entry.work ?? Promise.resolve();
		const next = previous.catch(() => {}).then(write);
		entry.work = next;
		void next
			.catch(() => {})
			.finally(() => {
				if (entry.work === next) entry.work = null;
			});
		return next;
	}

	private reconcileLater(entry: ReleasedEntry, pending: PendingParkWrite) {
		entry.state = "reconciling";
		entry.pending = pending;
	}

	/**
	 * Record, publish and release a park: a `preparing` record, the session
	 * copied into this store's directory atomically, then `released`. Each
	 * write is refused without the lease; a refusal or failure at any step
	 * removes what was written and throws, and the turn is the caller's to
	 * end.
	 */
	async store(
		park: Omit<SdkBridgeReleasedParkInsert, "sessionPath" | "fileBytes">,
		descriptor: ResumeDescriptor,
		source: string,
		/** Checked between the steps: the release was given up (dispose). */
		abandoned: () => boolean = () => false,
	): Promise<ReleasedEntry> {
		if (!this.leased) throw new Error("the park lease is not this process's");
		const repo = this.opts.repo;
		const path = join(this.dir, `${park.sessionId}.jsonl`);
		if (
			!(await repo.insertPreparing(
				{ ...park, sessionPath: path, fileBytes: 0 },
				this.token,
			))
		)
			throw new Error("the park lease is not this process's");
		let fileBytes: number;
		try {
			if (abandoned()) throw new Error("the release was given up");
			ensurePrivateDir(this.dir);
			fileBytes = publishFileAtomically(
				this.dir,
				basename(path),
				readFileSync(source),
				`.tmp-${randomBytes(8).toString("hex")}`,
			);
			if (abandoned()) throw new Error("the release was given up");
			if (
				!(await repo.markReleased(
					park.turnId,
					{ sessionPath: path, fileBytes },
					this.token,
				))
			)
				throw new Error(
					"its record could not be released (the lease or the turn moved on)",
				);
		} catch (error) {
			this.removeParkFile(path);
			await repo.delete(park.turnId, this.token).catch((e) => {
				this.opts.log.warn(
					`SDK bridge turn ${park.turnId}: could not delete its preparing record`,
					e,
				);
			});
			throw error;
		}
		const entry: ReleasedEntry = {
			park: {
				...park,
				sessionPath: path,
				fileBytes,
				state: "released",
				claimOwner: null,
				claimId: null,
				claimedAt: null,
			},
			descriptor,
			state: "released",
			pending: null,
			consumed: false,
			consuming: null,
			claimId: null,
			work: null,
			path,
		};
		this.index(entry);
		return entry;
	}

	/**
	 * Take a park for one resume. The in-memory claim is synchronous, so a
	 * second claimant in this process sees it taken at once; the database
	 * claim then fences it. False when it is not resumable here now.
	 */
	takeLocal(entry: ReleasedEntry): boolean {
		if (entry.state !== "released" || !this.entries.has(entry.park.turnId))
			return false;
		entry.state = "claimed";
		entry.claimId = randomBytes(12).toString("hex");
		return true;
	}

	/**
	 * The database claim. False (or a throw) leaves the entry reconciling:
	 * what the database holds is read back before it is claimable again.
	 */
	async claim(entry: ReleasedEntry): Promise<boolean> {
		let ok: boolean;
		try {
			ok = await this.opts.repo.claim(
				entry.park.turnId,
				this.token,
				String(entry.claimId),
				this.opts.now(),
				this.owner,
			);
		} catch (error) {
			this.reconcileLater(entry, { kind: "resync" });
			throw error;
		}
		if (!ok) this.reconcileLater(entry, { kind: "resync" });
		return ok;
	}

	/**
	 * Give a claim back. Released locally only once the database agrees;
	 * otherwise it stays reconciling and the retry keeps trying.
	 */
	async unclaim(entry: ReleasedEntry): Promise<boolean> {
		if (entry.consumed || !entry.claimId) return false;
		const claimId = entry.claimId;
		return this.serial(entry, async () => {
			let ok = false;
			try {
				ok = await this.opts.repo.unclaim(entry.park.turnId, this.token, {
					claimId,
				});
			} catch (error) {
				this.opts.log.warn(
					`SDK bridge turn ${entry.park.turnId}: could not give its claim back`,
					error,
				);
			}
			if (ok) {
				entry.state = "released";
				entry.pending = null;
				entry.claimId = null;
			} else this.reconcileLater(entry, { kind: "unclaim", claimId });
			return ok;
		});
	}

	/**
	 * Before the resumed query's first model call: the park can never resume
	 * again. The promise stays on the entry while it runs, so a close can
	 * wait for it before deciding the park's fate.
	 */
	consume(entry: ReleasedEntry): Promise<void> {
		if (entry.consumed) return Promise.resolve();
		const claimId = String(entry.claimId);
		const consuming = (async () => {
			if (
				!(await this.opts.repo.markConsumed(
					entry.park.turnId,
					this.token,
					claimId,
				))
			)
				throw new Error("the park is no longer this process's claim");
			entry.consumed = true;
		})();
		entry.consuming = consuming;
		return consuming;
	}

	/**
	 * Forget a park its resumed turn no longer needs: the record, then the
	 * file (only once the record is gone).
	 */
	forget(entry: ReleasedEntry): Promise<boolean> {
		return this.serial(entry, () => this.forgetNow(entry));
	}

	private async forgetNow(entry: ReleasedEntry): Promise<boolean> {
		let ok = false;
		try {
			ok = await this.opts.repo.delete(entry.park.turnId, this.token);
		} catch (error) {
			this.opts.log.warn(
				`SDK bridge turn ${entry.park.turnId}: could not delete its park`,
				error,
			);
		}
		if (!ok) {
			this.reconcileLater(entry, { kind: "forget" });
			return false;
		}
		this.unindex(entry.park.turnId);
		this.removeParkFile(entry.path);
		return true;
	}

	/**
	 * End a park's turn (expiry, supersession, an unusable file) and forget
	 * it. It stops being claimable at once; the file goes only after the
	 * close is confirmed, and a refused close is retried.
	 */
	async close(
		entry: ReleasedEntry,
		error: BridgeError,
		status: SdkBridgeTurnFinish["status"],
	): Promise<boolean> {
		this.reconcileLater(entry, { kind: "close", error, status });
		return this.serial(entry, () => this.runPending(entry));
	}

	private finishOf(
		entry: ReleasedEntry,
		error: BridgeError,
		status: SdkBridgeTurnFinish["status"],
	): SdkBridgeTurnFinish {
		const now = this.opts.now();
		return {
			finishedAt: now,
			status,
			httpStatus: error.status,
			errorType: error.type,
			errorMessage: error.message,
			durationMs: now - entry.descriptor.turnStartedAt,
		};
	}

	/** One attempt at an entry's pending write; true once it is settled. */
	private async runPending(entry: ReleasedEntry): Promise<boolean> {
		const pending = entry.pending;
		if (!pending) return true;
		const repo = this.opts.repo;
		const turnId = entry.park.turnId;
		try {
			switch (pending.kind) {
				case "unclaim": {
					if (
						await repo.unclaim(turnId, this.token, {
							claimId: pending.claimId,
						})
					) {
						entry.state = "released";
						entry.pending = null;
						entry.claimId = null;
						return true;
					}
					// Refused: read back what the database holds instead.
					entry.pending = { kind: "resync" };
					return this.runPending(entry);
				}
				case "forget":
					if (!(await repo.delete(turnId, this.token))) {
						if (!(await repo.holdsLease(this.token))) this.unindex(turnId);
						return !this.entries.has(turnId);
					}
					this.unindex(turnId);
					this.removeParkFile(entry.path);
					return true;
				case "close": {
					const finish = this.finishOf(entry, pending.error, pending.status);
					const outcome = await repo.closeTurn(turnId, finish, this.token);
					if (outcome === "refused") {
						// Without the lease the park is not this process's to end.
						if (!(await repo.holdsLease(this.token))) this.unindex(turnId);
						return !this.entries.has(turnId);
					}
					if (outcome === "closed")
						logTurnFinished(this.opts.log, turnId, finish, null);
					this.unindex(turnId);
					this.removeParkFile(entry.path);
					return true;
				}
				case "resync": {
					if (!(await repo.holdsLease(this.token))) {
						this.unindex(turnId);
						return true;
					}
					const row = await repo.find(turnId);
					if (!row) {
						this.unindex(turnId);
						return true;
					}
					if (row.state === "released") {
						entry.state = "released";
						entry.pending = null;
						entry.claimId = null;
						return true;
					}
					if (
						row.state === "claimed" &&
						row.claimOwner === this.token &&
						row.claimId &&
						row.claimId === entry.claimId
					) {
						entry.pending = { kind: "unclaim", claimId: row.claimId };
						return this.runPending(entry);
					}
					// Claimed elsewhere or spent: not this process's to resume.
					this.unindex(turnId);
					return true;
				}
			}
		} catch (error) {
			this.opts.log.warn(
				`SDK bridge turn ${turnId}: park write still pending (${errorSummary(error)})`,
			);
			return false;
		}
	}

	/**
	 * Retry every pending write (the maintenance pass). Entries a resume is
	 * using right now are left alone.
	 */
	async reconcile(): Promise<void> {
		for (const entry of this.all())
			if (entry.state === "reconciling" && !entry.work)
				await this.serial(entry, () => this.runPending(entry));
	}

	/**
	 * Bring the directory and the records into agreement after a restart,
	 * before any request can see them, under the lease. The index is built
	 * privately and published only when every row was handled: preparing and
	 * consumed records end their turns, stale claims go back to `released`,
	 * unusable records (no calls, a bad descriptor, a file that is missing,
	 * the wrong size or without its resume point) end theirs, and files in
	 * this store's directory that no record names go. A file is deleted only
	 * after its turn's close is confirmed. Any database failure or refusal
	 * fails the attempt, leaving everything for the next one. Returns the
	 * parks kept.
	 */
	async recover(errors: {
		preparing: BridgeError;
		consumed: BridgeError;
		unusable: BridgeError;
		expired: BridgeError;
	}): Promise<number> {
		const repo = this.opts.recoveryRepo ?? this.opts.repo;
		if (!(await this.takeLease(repo))) throw new LeaseHeldElsewhere();
		const now = this.opts.now();
		const entries = new Map<string, ReleasedEntry>();
		const byToolId = new Map<string, string>();
		const kept = new Set<string>();
		const end = async (
			park: SdkBridgeReleasedPark,
			error: BridgeError,
			status: SdkBridgeTurnFinish["status"],
		) => {
			let startedAt = park.createdAt;
			try {
				startedAt = (JSON.parse(park.descriptor) as ResumeDescriptor)
					.turnStartedAt;
			} catch {}
			const finish: SdkBridgeTurnFinish = {
				finishedAt: now,
				status,
				httpStatus: error.status,
				errorType: error.type,
				errorMessage: error.message,
				durationMs: now - startedAt,
			};
			const outcome = await repo.closeTurn(park.turnId, finish, this.token);
			if (outcome === "refused")
				throw new Error("the park lease moved on during recovery");
			if (outcome === "closed")
				logTurnFinished(this.opts.log, park.turnId, finish, null);
			this.removeParkFile(park.sessionPath);
		};
		for (const park of await repo.list()) {
			if (park.state === "preparing") {
				await end(park, errors.preparing, "failed");
				continue;
			}
			if (park.state === "consumed") {
				await end(park, errors.consumed, "failed");
				continue;
			}
			// Claims found at startup are stale: no model call followed them.
			if (park.state === "claimed")
				if (
					!(await repo.unclaim(park.turnId, this.token, { anyClaimant: true }))
				)
					throw new Error(`the stale claim of turn ${park.turnId} was refused`);
			if (park.expiresAt <= now) {
				await end(park, errors.expired, "expired");
				continue;
			}
			let descriptor: ResumeDescriptor | null = null;
			try {
				descriptor = JSON.parse(park.descriptor) as ResumeDescriptor;
				if (descriptor.v !== 1) descriptor = null;
			} catch {}
			// Cheap at startup: the whole chain is checked when a resume claims it.
			if (
				!descriptor ||
				!park.awaitedToolUseIds.length ||
				!this.acceptsPath(park.sessionPath) ||
				!fileLooksWhole(park.sessionPath, park.fileBytes, park.resumeAt)
			) {
				this.opts.log.warn(
					`SDK bridge turn ${park.turnId}: released park unusable`,
				);
				await end(park, errors.unusable, "failed");
				continue;
			}
			kept.add(park.sessionPath);
			entries.set(park.turnId, {
				park: {
					...park,
					state: "released",
					claimOwner: null,
					claimId: null,
					claimedAt: null,
				},
				descriptor,
				state: "released",
				pending: null,
				consumed: false,
				consuming: null,
				claimId: null,
				work: null,
				path: park.sessionPath,
			});
			for (const id of park.awaitedToolUseIds) byToolId.set(id, park.turnId);
		}
		// Files no record names, in this store's own directory only, and only
		// when it is reached without a symlink (a symlinked entry is unlinked,
		// never followed).
		let names: string[] = [];
		if (this.ownDirIsSafe())
			try {
				names = readdirSync(this.dir);
			} catch {}
		else if (lstatOrNull(this.dir))
			this.opts.log.warn(
				`SDK bridge: not sweeping ${this.dir}: it is not reached without a symlink`,
			);
		for (const name of names) {
			const path = join(this.dir, name);
			if (!kept.has(path)) removeTree(path);
		}
		this.entries = entries;
		this.byToolId = byToolId;
		return entries.size;
	}
}

/** Another live process holds the park lease: this one releases nothing. */
export class LeaseHeldElsewhere extends Error {
	constructor() {
		super("another running process on this database holds the park lease");
		this.name = "LeaseHeldElsewhere";
	}
}
