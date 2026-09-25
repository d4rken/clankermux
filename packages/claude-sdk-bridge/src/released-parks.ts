import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type {
	ProjectAttributionSource,
	SdkBridgeReleasedPark,
	SdkBridgeReleasedParkInsert,
	SdkBridgeRoutePlan,
	SdkBridgeTurnFinish,
} from "@clankermux/types";
import { type BridgeError, errorSummary } from "./errors";
import type { SystemPromptDecision } from "./system-prompt-policy";
import type { ClientTool } from "./turn-request";
import type { BridgeLog, SdkBridgeParkRepo } from "./types";
import {
	acquireOwnerLock,
	ensurePrivateDir,
	publishFileAtomically,
	releaseOwnerLock,
	removeTree,
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
}

/** A released park as the bridge holds it in memory. */
export interface ReleasedEntry {
	park: SdkBridgeReleasedPark;
	descriptor: ResumeDescriptor;
	/** `claimed` from the synchronous claim on, whatever the database says yet. */
	state: "released" | "claimed";
	/** The resumed query made its first model call: the park is spent. */
	consumed: boolean;
	path: string;
}

const LOCK_FILE = "owner.lock";
const SESSION_FILE = /^[0-9a-f-]{36}\.jsonl$/;

/**
 * Whether the transcript at `path` has an entry `resumeAt` whose chain
 * (walking parentUuid back from it) carries every awaited tool_use id.
 * Parses the whole file: for a release and for startup recovery, never on a
 * request's path.
 */
export function transcriptHoldsCalls(
	path: string,
	resumeAt: string,
	awaited: readonly string[],
): boolean {
	let text: string;
	try {
		if (!lstatSync(path).isFile()) return false;
		text = readFileSync(path, "utf8");
	} catch {
		return false;
	}
	const byUuid = new Map<string, { parent: string | null; calls: string[] }>();
	for (const line of text.split("\n")) {
		if (!line) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return false;
		}
		if (typeof entry.uuid !== "string") continue;
		const content = (entry.message as { content?: unknown } | undefined)
			?.content;
		byUuid.set(entry.uuid, {
			parent: typeof entry.parentUuid === "string" ? entry.parentUuid : null,
			calls:
				entry.type === "assistant" && Array.isArray(content)
					? (content as Array<{ type?: unknown; id?: unknown }>)
							.filter((b) => b?.type === "tool_use")
							.map((b) => String(b.id))
					: [],
		});
	}
	const found = new Set<string>();
	const seen = new Set<string>();
	let at: string | null = resumeAt;
	if (!byUuid.has(resumeAt)) return false;
	while (at && !seen.has(at)) {
		seen.add(at);
		const entry = byUuid.get(at);
		if (!entry) break;
		for (const id of entry.calls) found.add(id);
		at = entry.parent;
	}
	return awaited.every((id) => found.has(id));
}

/**
 * Released parks: session files under a directory of the work root that
 * generation cleanup never touches, and their records in the database. One
 * bridge process owns the directory at a time (a lock file); a bridge
 * without the lock releases nothing and resumes nothing.
 *
 * The in-memory index mirrors the records this process may act on. Claims
 * are taken here synchronously first, so two requests racing for one park
 * never both reach the database.
 */
export class ReleasedParkStore {
	readonly dir: string;
	private readonly lockPath: string;
	private readonly lockToken = randomBytes(12).toString("hex");
	private held = false;
	private readonly entries = new Map<string, ReleasedEntry>();
	private readonly byToolId = new Map<string, string>();

	constructor(
		private readonly opts: {
			workRoot: string;
			repo: SdkBridgeParkRepo;
			log: BridgeLog;
			now: () => number;
			/** This process's claim owner, fencing its claims from a later one's. */
			owner: string;
		},
	) {
		this.dir = join(opts.workRoot, "released-parks");
		this.lockPath = join(this.dir, LOCK_FILE);
	}

	/** Take the directory for this process; false when a live process holds it. */
	acquire(): boolean {
		ensurePrivateDir(this.dir);
		this.held = acquireOwnerLock(this.lockPath, this.lockToken);
		return this.held;
	}

	get owned(): boolean {
		return this.held;
	}

	dispose(): void {
		if (this.held) releaseOwnerLock(this.lockPath, this.lockToken);
		this.held = false;
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

	/** The park waiting on any of `ids`, claimed or not. */
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

	private pathOf(sessionFile: string): string {
		if (!SESSION_FILE.test(sessionFile))
			throw new Error(`Invalid released session file ${sessionFile}`);
		return join(this.dir, sessionFile);
	}

	/**
	 * Record, publish and release a park: a `preparing` record, the session
	 * copied to the directory atomically, then `released`. A failure at any
	 * step removes what it wrote and throws; the turn is then the caller's to
	 * end.
	 */
	async store(
		park: Omit<SdkBridgeReleasedParkInsert, "sessionFile" | "fileBytes">,
		descriptor: ResumeDescriptor,
		source: string,
	): Promise<ReleasedEntry> {
		if (!this.held) throw new Error("the released-parks directory is not ours");
		const sessionFile = `${park.sessionId}.jsonl`;
		const path = this.pathOf(sessionFile);
		await this.opts.repo.insertPreparing({
			...park,
			sessionFile,
			fileBytes: 0,
		});
		let fileBytes: number;
		try {
			fileBytes = publishFileAtomically(
				this.dir,
				sessionFile,
				readFileSync(source),
				`.tmp-${randomBytes(8).toString("hex")}`,
			);
			if (
				!(await this.opts.repo.markReleased(park.turnId, {
					sessionFile,
					fileBytes,
				}))
			)
				throw new Error("its record left the preparing state");
		} catch (error) {
			removeTree(path);
			await this.opts.repo.delete(park.turnId).catch((e) => {
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
				sessionFile,
				fileBytes,
				state: "released",
				claimOwner: null,
				claimedAt: null,
			},
			descriptor,
			state: "released",
			consumed: false,
			path,
		};
		this.index(entry);
		return entry;
	}

	/**
	 * Take a park for one resume. The in-memory claim is synchronous, so a
	 * second claimant in this process sees it taken at once; the database
	 * claim then fences it across processes. False when either was taken.
	 */
	takeLocal(entry: ReleasedEntry): boolean {
		if (entry.state !== "released" || !this.entries.has(entry.park.turnId))
			return false;
		entry.state = "claimed";
		return true;
	}

	async claim(entry: ReleasedEntry): Promise<boolean> {
		try {
			if (
				await this.opts.repo.claim(
					entry.park.turnId,
					this.opts.owner,
					this.opts.now(),
				)
			)
				return true;
		} catch (error) {
			entry.state = "released";
			throw error;
		}
		// Not in `released` any more in the database: nothing here can resume it.
		this.unindex(entry.park.turnId);
		return false;
	}

	/** A claim whose resume never made a model call goes back. */
	async unclaim(entry: ReleasedEntry): Promise<void> {
		if (entry.consumed) return;
		await this.opts.repo.unclaim(entry.park.turnId, this.opts.owner);
		entry.state = "released";
	}

	/** Before the resumed query's first model call: the park can never resume again. */
	async consume(entry: ReleasedEntry): Promise<void> {
		if (entry.consumed) return;
		if (
			!(await this.opts.repo.markConsumed(entry.park.turnId, this.opts.owner))
		)
			throw new Error("the park is no longer claimed by this process");
		entry.consumed = true;
	}

	/** Forget a park its resumed turn no longer needs: record and file. */
	async forget(entry: ReleasedEntry): Promise<void> {
		this.unindex(entry.park.turnId);
		removeTree(entry.path);
		await this.opts.repo.delete(entry.park.turnId);
	}

	/** End a park's turn (expiry, supersession, an unusable file) and forget it. */
	async close(
		entry: ReleasedEntry,
		error: BridgeError,
		status: SdkBridgeTurnFinish["status"],
	): Promise<void> {
		this.unindex(entry.park.turnId);
		removeTree(entry.path);
		const now = this.opts.now();
		await this.opts.repo.closeTurn(entry.park.turnId, {
			finishedAt: now,
			status,
			httpStatus: error.status,
			errorType: error.type,
			errorMessage: error.message,
			durationMs: now - entry.descriptor.turnStartedAt,
		});
	}

	/**
	 * Bring the directory and the records into agreement after a restart,
	 * before any request can see them: unfinished releases and spent resumes
	 * end their turns, stale claims go back to `released`, records whose file
	 * is missing or unusable end theirs, and files no record names go.
	 * Returns the parks kept.
	 */
	async recover(errors: {
		preparing: BridgeError;
		consumed: BridgeError;
		unusable: BridgeError;
		expired: BridgeError;
	}): Promise<number> {
		const repo = this.opts.repo;
		const now = this.opts.now();
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
			try {
				removeTree(this.pathOf(park.sessionFile));
			} catch {}
			await repo.closeTurn(park.turnId, {
				finishedAt: now,
				status,
				httpStatus: error.status,
				errorType: error.type,
				errorMessage: error.message,
				durationMs: now - startedAt,
			});
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
			// Claims are this lock's alone, and no model call followed them.
			if (park.state === "claimed") await repo.unclaim(park.turnId, null);
			if (park.expiresAt <= now) {
				await end(park, errors.expired, "timed_out");
				continue;
			}
			let path: string;
			let descriptor: ResumeDescriptor;
			try {
				path = this.pathOf(park.sessionFile);
				descriptor = JSON.parse(park.descriptor) as ResumeDescriptor;
				if (descriptor.v !== 1) throw new Error("unknown descriptor version");
			} catch (error) {
				this.opts.log.warn(
					`SDK bridge turn ${park.turnId}: released park unusable (${errorSummary(error)})`,
				);
				await end(park, errors.unusable, "failed");
				continue;
			}
			if (!transcriptHoldsCalls(path, park.resumeAt, park.awaitedToolUseIds)) {
				this.opts.log.warn(
					`SDK bridge turn ${park.turnId}: released session missing or corrupt`,
				);
				await end(park, errors.unusable, "failed");
				continue;
			}
			kept.add(park.sessionFile);
			this.index({
				park: { ...park, state: "released", claimOwner: null, claimedAt: null },
				descriptor,
				state: "released",
				consumed: false,
				path,
			});
		}
		for (const name of readdirSync(this.dir))
			if (name !== LOCK_FILE && !kept.has(name))
				removeTree(join(this.dir, name));
		return kept.size;
	}

	/** Whether the file still holds the resume point: a cheap check before a resume. */
	fileHolds(entry: ReleasedEntry): boolean {
		try {
			if (!lstatSync(entry.path).isFile()) return false;
			return readFileSync(entry.path, "latin1").includes(
				`"uuid":"${entry.park.resumeAt}"`,
			);
		} catch {
			return false;
		}
	}
}
