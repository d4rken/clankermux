import type {
	SdkBridgeLegFinish,
	SdkBridgeLegKind,
	SdkBridgeTurn,
	SdkBridgeTurnCounterDelta,
	SdkBridgeTurnFinish,
	SdkBridgeTurnInsert,
} from "@clankermux/types";
import type { BridgeLog, SdkBridgeTurnRepo } from "./types";
import { processStartTime } from "./work-dirs";

/** This process, as turn rows name their owner. */
const OWNER = { pid: process.pid, startTime: processStartTime(process.pid) };

/** What the turn's insert and its counter writes told this process. */
export interface TurnTally {
	turn: Pick<
		SdkBridgeTurn,
		| "kind"
		| "model"
		| "accountId"
		| "clientHarness"
		| "historyMode"
		| "rebuildReason"
		| "systemPromptPolicy"
	>;
	legs: number;
	toolRounds: number;
	innerCalls: number;
	innerErrors: number;
}

/** Token counts of one model call; null where Claude Code reported none. */
export interface ModelCallUsage {
	input: number | null;
	cacheRead: number | null;
	cacheCreation: number | null;
}

/**
 * The journal's line for a finished turn: one per turn, from whichever path
 * wrote its final status. Without a `tally` the turn's insert happened
 * elsewhere (a released park, maybe in another process), so the identity
 * and counters are left out rather than reported partially.
 *
 * `SDK bridge turn <id> completed {"event":"sdk_bridge_turn","turnId":…,
 * "status":"completed","httpStatus":200,…,"historyMode":"resume",…,
 * "firstCall":{"input":3,"cacheRead":41000,"cacheCreation":250}}`
 */
export function logTurnFinished(
	log: BridgeLog,
	turnId: string,
	finish: SdkBridgeTurnFinish,
	tally: TurnTally | null,
	firstCall: ModelCallUsage | null = null,
): void {
	const tokens = [
		finish.sdkInputTokens,
		finish.sdkOutputTokens,
		finish.sdkCacheReadInputTokens,
		finish.sdkCacheCreationInputTokens,
	].some((n) => n != null)
		? {
				input: finish.sdkInputTokens ?? null,
				output: finish.sdkOutputTokens ?? null,
				cacheRead: finish.sdkCacheReadInputTokens ?? null,
				cacheCreation: finish.sdkCacheCreationInputTokens ?? null,
			}
		: undefined;
	const data: Record<string, unknown> = {
		event: "sdk_bridge_turn",
		turnId,
		kind: tally?.turn.kind,
		status: finish.status,
		httpStatus: finish.httpStatus ?? null,
		errorType: finish.errorType ?? null,
		errorMessage: finish.errorMessage ?? null,
		stopReason: finish.stopReason,
		model: tally?.turn.model,
		accountId: tally?.turn.accountId,
		clientHarness: tally?.turn.clientHarness,
		historyMode: tally?.turn.historyMode,
		rebuildReason: tally?.turn.rebuildReason,
		systemPromptPolicy: tally?.turn.systemPromptPolicy,
		legs: tally?.legs,
		toolRounds: tally?.toolRounds,
		innerCalls: tally?.innerCalls,
		innerErrors: tally?.innerErrors,
		spawnMs: finish.spawnMs,
		firstEventMs: finish.firstEventMs,
		durationMs: finish.durationMs,
		sdkNumTurns: finish.sdkNumTurns,
		tokens,
		firstCall: firstCall ?? undefined,
		resumedFromRelease: tally ? undefined : true,
	};
	for (const key of Object.keys(data))
		if (data[key] === undefined) delete data[key];
	const warn = WARN_STATUSES.has(finish.status);
	log[warn ? "warn" : "info"](
		`SDK bridge turn ${turnId} ${finish.status}`,
		data,
	);
}

const WARN_STATUSES = new Set<SdkBridgeTurnFinish["status"]>([
	"failed",
	"timed_out",
	"expired",
]);

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
	/** Null until this process inserts the turn. */
	private identity: TurnTally["turn"] | null = null;
	private legsInserted = 0;
	private readonly counts = { toolRounds: 0, innerCalls: 0, innerErrors: 0 };
	private firstCall: ModelCallUsage | null = null;

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

	insertLeg(
		id: string,
		kind: SdkBridgeLegKind,
		startedAt: number,
	): Promise<void> {
		this.legsInserted++;
		return this.enqueue("insertLeg", () =>
			this.repo.insertLeg(
				{ id, turnId: this.turnId, kind, startedAt },
				this.fence,
			),
		);
	}

	/** Each leg is finished exactly once, whichever exit path gets there first. */
	finishLeg(id: string, finish: SdkBridgeLegFinish): Promise<void> {
		if (this.finishedLegs.has(id)) return this.chain;
		this.finishedLegs.add(id);
		return this.enqueue("finishLeg", () =>
			this.repo.finishLeg(id, finish, this.fence),
		);
	}

	/** Logged once the write has run, whether or not it landed. */
	finishTurn(finish: SdkBridgeTurnFinish): Promise<void> {
		if (this.turnFinished) return this.chain;
		this.turnFinished = true;
		void this.enqueue("finishTurn", () =>
			this.repo.finishTurn(this.turnId, finish, this.fence),
		);
		return this.enqueue("logTurnFinished", async () =>
			logTurnFinished(
				this.log,
				this.turnId,
				finish,
				this.identity && {
					turn: this.identity,
					legs: this.legsInserted,
					...this.counts,
				},
				this.firstCall,
			),
		);
	}

	/**
	 * A model call's `usage` as Claude Code reported it. Only the first call
	 * that reports token counts is kept: on a resumed session it is the one
	 * that shows whether the conversation came back from the cache.
	 */
	noteModelCall(usage: unknown): void {
		if (this.firstCall || !usage || typeof usage !== "object") return;
		const u = usage as Record<string, unknown>;
		const call: ModelCallUsage = {
			input: tokenCount(u.input_tokens),
			cacheRead: tokenCount(u.cache_read_input_tokens),
			cacheCreation: tokenCount(u.cache_creation_input_tokens),
		};
		if (Object.values(call).some((n) => n !== null)) this.firstCall = call;
	}

	bump(delta: SdkBridgeTurnCounterDelta): Promise<void> {
		this.counts.toolRounds += delta.toolRounds ?? 0;
		this.counts.innerCalls += delta.innerCalls ?? 0;
		this.counts.innerErrors += delta.innerErrors ?? 0;
		return this.enqueue("bumpTurnCounters", () =>
			this.repo.bumpTurnCounters(this.turnId, delta, this.fence),
		);
	}

	/** Resolves once every write queued so far has landed (or failed). */
	flushed(): Promise<void> {
		return this.chain;
	}
}
