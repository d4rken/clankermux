import type {
	SdkBridgeLegFinish,
	SdkBridgeLegKind,
	SdkBridgeTurnCounterDelta,
	SdkBridgeTurnFinish,
	SdkBridgeTurnInsert,
} from "@clankermux/types";
import { errorSummary } from "./errors";
import {
	logTurnFinished,
	type ModelCallUsage,
	type TurnLogCounts,
	type TurnLogIdentity,
	type TurnLogWebSearch,
} from "./turn-log";
import type { BridgeLog, SdkBridgeTurnRepo } from "./types";
import { processStartTime } from "./work-dirs";

/** This process, as turn rows name their owner. */
const OWNER = { pid: process.pid, startTime: processStartTime(process.pid) };

function tokenCount(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Turn and leg rows. Writes are chained per turn so a finish never overtakes
 * its insert, and a failed write is logged, never thrown: accounting must not
 * break a reply that is already streaming.
 */
export class TurnRecorder {
	private chain: Promise<void> = Promise.resolve();
	private readonly finishedLegs = new Set<string>();
	private turnFinished = false;
	/** Whether this process inserted the turn: only then are its counters whole. */
	private inserted = false;
	private identity: TurnLogIdentity | null = null;
	/** Counted when the write lands, so a finish reports what preceded it. */
	private readonly counts: TurnLogCounts = {
		legs: 0,
		toolRounds: 0,
		innerCalls: 0,
		innerErrors: 0,
	};
	/** WebSearch calls Claude Code made, and the searches their results report. */
	private readonly webSearch: TurnLogWebSearch = { calls: 0, requests: 0 };
	/** The query's first top-level model call, by its message id. */
	private firstCall: {
		messageId: string | null;
		usage: ModelCallUsage;
	} | null = null;

	constructor(
		private readonly repo: SdkBridgeTurnRepo,
		private readonly log: BridgeLog,
		readonly turnId: string,
		/**
		 * The park lease token, for a turn a released park owns: every write,
		 * queued ones included, applies only while it holds the lease.
		 */
		private fence?: string,
	) {}

	/**
	 * Fence this turn's writes from now on: the turn is becoming a park's.
	 * Each write reads the token when it runs, so writes already queued are
	 * fenced too.
	 */
	setFence(token: string): void {
		this.fence = token;
	}

	private enqueue(what: string, write: () => Promise<void>): Promise<void> {
		this.chain = this.chain.then(write).catch((error) => {
			this.log.warn(`SDK bridge turn ${this.turnId}: ${what} failed`, error);
		});
		return this.chain;
	}

	/** The row names this process as the turn's owner (pid and start time). */
	insertTurn(turn: Omit<SdkBridgeTurnInsert, "id">): Promise<void> {
		this.inserted = true;
		this.identity = {
			kind: turn.kind ?? "turn",
			model: turn.model ?? null,
			accountId: turn.accountId ?? null,
			clientHarness: turn.clientHarness ?? null,
			historyMode: turn.historyMode,
			rebuildReason: turn.rebuildReason ?? null,
			systemPromptPolicy: turn.systemPromptPolicy,
		};
		return this.enqueue("insertTurn", () =>
			this.repo.insertTurn({
				...turn,
				id: this.turnId,
				ownerPid: OWNER.pid,
				ownerStartTime: OWNER.startTime,
			}),
		);
	}

	/**
	 * The identity of a turn inserted elsewhere (a released park's), for its
	 * journal line. Its counters stay unreported: this process saw only part.
	 */
	adoptIdentity(identity: TurnLogIdentity | null): void {
		if (!this.inserted) this.identity = identity;
	}

	insertLeg(
		id: string,
		kind: SdkBridgeLegKind,
		startedAt: number,
	): Promise<void> {
		return this.enqueue("insertLeg", async () => {
			if (
				await this.repo.insertLeg(
					{ id, turnId: this.turnId, kind, startedAt },
					this.fence,
				)
			)
				this.counts.legs++;
		});
	}

	/** Each leg is finished exactly once, whichever exit path gets there first. */
	finishLeg(id: string, finish: SdkBridgeLegFinish): Promise<void> {
		if (this.finishedLegs.has(id)) return this.chain;
		this.finishedLegs.add(id);
		return this.enqueue("finishLeg", () =>
			this.repo.finishLeg(id, finish, this.fence),
		);
	}

	/**
	 * Write the finish and, in the same queued step, log the turn's journal
	 * line if the write finished the row. The line counts the writes queued
	 * before this call that landed, and none queued after it.
	 */
	finishTurn(finish: SdkBridgeTurnFinish): Promise<void> {
		if (this.turnFinished) return this.chain;
		this.turnFinished = true;
		const source = this.inserted ? "live" : "resumed_park";
		const identity = this.identity;
		const firstCall = this.firstCall && { ...this.firstCall.usage };
		const webSearch = this.webSearch.calls ? { ...this.webSearch } : null;
		this.chain = this.chain.then(async () => {
			let applied: boolean;
			try {
				applied = await this.repo.finishTurn(this.turnId, finish, this.fence);
			} catch (error) {
				this.log.warn(`SDK bridge turn ${this.turnId}: finish write failed`, {
					event: "sdk_bridge_turn_finish_failed",
					turnId: this.turnId,
					status: finish.status,
					error: errorSummary(error),
				});
				return;
			}
			if (!applied) {
				this.log.debug(
					`SDK bridge turn ${this.turnId}: ${finish.status} not written; the row was already finished or is no longer this process's`,
				);
				return;
			}
			logTurnFinished(this.log, this.turnId, finish, {
				source,
				identity,
				counts: source === "live" ? { ...this.counts } : null,
				firstCall,
				webSearch,
			});
		});
		return this.chain;
	}

	/**
	 * A top-level model call's `usage`, from its `message_start`, its
	 * `message_delta`s or its assistant envelope. The first call seen is the
	 * one kept, even before it reports any count; later reports of the same
	 * message fill it in (a number overwrites, a missing value does not), and
	 * other messages are ignored. On a resumed session that call shows
	 * whether the conversation came back from the cache.
	 */
	noteModelCall(messageId: string | null, usage: unknown): void {
		if (!this.firstCall)
			this.firstCall = {
				messageId,
				usage: { input: null, cacheRead: null, cacheCreation: null },
			};
		else if (messageId === null || messageId !== this.firstCall.messageId)
			return;
		if (!usage || typeof usage !== "object") return;
		const u = usage as Record<string, unknown>;
		const call = this.firstCall.usage;
		call.input = tokenCount(u.input_tokens) ?? call.input;
		call.cacheRead = tokenCount(u.cache_read_input_tokens) ?? call.cacheRead;
		call.cacheCreation =
			tokenCount(u.cache_creation_input_tokens) ?? call.cacheCreation;
	}

	/** Claude Code started a WebSearch call for the client's hosted search. */
	noteWebSearchCall(): void {
		this.webSearch.calls++;
	}

	/** A WebSearch call's result, reporting `searchCount` searches. */
	noteWebSearchResult(searchCount: number): void {
		this.webSearch.requests += searchCount;
	}

	bump(delta: SdkBridgeTurnCounterDelta): Promise<void> {
		return this.enqueue("bumpTurnCounters", async () => {
			await this.repo.bumpTurnCounters(this.turnId, delta, this.fence);
			this.counts.toolRounds += delta.toolRounds ?? 0;
			this.counts.innerCalls += delta.innerCalls ?? 0;
			this.counts.innerErrors += delta.innerErrors ?? 0;
		});
	}

	/** Resolves once every write queued so far has landed (or failed). */
	flushed(): Promise<void> {
		return this.chain;
	}
}
