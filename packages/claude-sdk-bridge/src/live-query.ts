import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
	SdkBridgeHistoryMode,
	SdkBridgeInnerOutcome,
	SdkBridgeLegKind,
	SdkBridgeTurnStatus,
} from "@clankermux/types";
import type { ConversationClaim } from "./conversation-store";
import {
	type BridgeError,
	bridgeErrors,
	type ClaudeCodeFailureCause,
	isContextOverflow,
	mapClaudeCodeFailure,
	sanitizeMessage,
} from "./errors";
import { messageDigests } from "./history";
import type { InnerRegistration } from "./inner-listener";
import type { PromptStream } from "./prompt-stream";
import type { TurnRecorder } from "./recorder";
import type {
	ReplyComposer,
	StreamEvent,
	UpstreamMessageEnd,
} from "./reply-composer";
import type { LegResponse } from "./sse";
import {
	abortedResult,
	type McpToolResult,
	type ParkedCalls,
	toMcpResult,
} from "./tool-server";
import type { Block, ClientMessage } from "./turn-request";
import type { BridgeLog, BridgeQuery, SdkBridgeTiming } from "./types";

export type TeardownReason =
	| "client_abort"
	| "parked_timeout"
	| "deadline"
	| "idle"
	| "shutdown"
	| "limit"
	| "superseded"
	| "error";

const TEARDOWN_STATUS: Record<TeardownReason, SdkBridgeTurnStatus> = {
	client_abort: "aborted",
	parked_timeout: "timed_out",
	deadline: "timed_out",
	idle: "failed",
	shutdown: "shutdown",
	limit: "failed",
	superseded: "aborted",
	error: "failed",
};

/** How long an error `result` waits for the proxy's report of the failed call. */
const OUTCOME_GRACE_MS = 250;
/** SIGTERM to SIGKILL, for a child that ignores the polite signal. */
const KILL_GRACE_MS = 2_000;
/** From a prompt message's read to the tool results that must follow it. */
const PROMPT_WRITE_MS = 20;
/** How long a release waits for the envelopes of the message that parked. */
const ENVELOPE_WAIT_MS = 2_000;
/** After the SIGKILL, how long a release waits for the child and the pump to end. */
const RELEASE_EXIT_WAIT_MS = 3_000;

/**
 * Whether `ids` answer exactly the calls in `awaiting`: each one once, and
 * nothing else. A missing, repeated or unknown id is a stale replay.
 *
 *   awaiting {a, b}: [a, b] → true; [a] → false; [a, b, b] → false; [a, b, c] → false
 */
export function answersExactly(
	awaiting: ReadonlySet<string>,
	ids: readonly string[],
): boolean {
	if (!awaiting.size || ids.length !== awaiting.size) return false;
	const seen = new Set<string>();
	for (const id of ids) {
		if (!awaiting.has(id) || seen.has(id)) return false;
		seen.add(id);
	}
	return true;
}

/** A parked query stopped for release: what the bridge needs to store it. */
export type ReleaseStop =
	| {
			ok: true;
			sessionId: string;
			/** Uuid of the transcript entry a resume continues from. */
			resumeAt: string;
			awaitedToolUseIds: string[];
			/** Active time used so far, the parked time excluded. */
			activeMs: number;
			parkedSince: number;
	  }
	| { ok: false; reason: string; stopped: boolean };

/** One top-level assistant message envelope Claude Code reported. */
interface AssistantEnvelope {
	uuid: string;
	messageId: string | null;
	toolUseIds: string[];
}

export interface Leg {
	id: string;
	kind: SdkBridgeLegKind;
	startedAt: number;
	response: LegResponse;
}

export interface LiveQueryInit {
	turnId: string;
	ownerApiKeyId: string | null;
	sessionId: string;
	accountId: string;
	/** The model the client asked for, as it named it. */
	requestedModel: string;
	historyMode: SdkBridgeHistoryMode;
	query: BridgeQuery;
	prompt: PromptStream;
	parked: ParkedCalls;
	composer: ReplyComposer;
	recorder: TurnRecorder;
	registration: InnerRegistration;
	/** Claude Code processes this query started; filled by the spawn hook. */
	pids: Set<number>;
	killProcessGroup: (pid: number, signal: NodeJS.Signals) => void;
	isAlive: (pid: number) => boolean;
	readPeakRss: (pid: number) => number | null;
	claim: ConversationClaim | null;
	/** The conversation as the client sent it with this leg. */
	clientMessages: ClientMessage[];
	timing: SdkBridgeTiming;
	parkedTimeoutMs: number;
	/** Active-time budget of the whole turn; parked and released time is not counted. */
	turnDeadlineMs: number;
	/** Active time the turn used before this query: a resumed release's. */
	priorActiveMs?: number;
	/**
	 * Parked this long, the query asks to be released ({@link onReleaseDue});
	 * null parks it until the parked timeout instead.
	 */
	parkReleaseMs?: number | null;
	/** Time to release this parked query: its timer fired, or the bridge is shutting down. */
	onReleaseDue?: (live: LiveQuery) => void;
	/** Whether a query parking now could be released rather than torn down. */
	canRelease?: () => boolean;
	/**
	 * At close, leave the turn row open (no finish written): a resumed
	 * release that ended before its first model call, whose park goes back.
	 */
	keepTurnOpen?: (status: SdkBridgeTurnStatus) => boolean;
	maxParkedCalls: number;
	startedAt: number;
	now: () => number;
	log: BridgeLog;
	isShuttingDown: () => boolean;
	/** The conversation this query holds a claim on, if any. */
	conversationKey: string | null;
	/**
	 * A side request: its reply is one model call's, and a tool call or a
	 * max_tokens stop ends it instead of reaching the client or continuing.
	 */
	sideRequest?: boolean;
	/** The session will never be resumed; its transcript can go. */
	discardSession: (sessionId: string) => void;
	/** Claude Code's own copy of the session, which nothing resumes from. */
	discardClaudeCodeTranscripts: (sessionId: string) => void;
	onPeakRss: (bytes: number) => void;
	onClosed: (live: LiveQuery) => void;
}

/**
 * One Claude Code query serving one logical turn, across the legs (outer HTTP
 * requests) that carry it: the start leg, then one continuation per round of
 * client tool calls.
 *
 * States: `running` (a leg is open or Claude Code is working), `awaiting_client`
 * (the reply ended in client tool calls, which are parked in MCP handlers),
 * `finishing` (the reply ended; waiting for Claude Code's `result`), `closed`.
 */
export class LiveQuery {
	state: "running" | "awaiting_client" | "releasing" | "finishing" | "closed" =
		"running";
	readonly turnId: string;
	readonly ownerApiKeyId: string | null;
	readonly sessionId: string;
	readonly startedAt: number;
	readonly conversationKey: string | null;
	readonly requestedModel: string;
	private leg: Leg | null = null;
	/** The tool calls the client must answer now: the last ended leg's. */
	private awaiting: ReadonlySet<string> = new Set();
	private readonly innerRequestsStarted = new Set<string>();
	private readonly innerOutcomesSeen = new Set<string>();
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private parkedTimer: ReturnType<typeof setTimeout> | null = null;
	private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
	private exitTimer: ReturnType<typeof setTimeout> | null = null;
	private releaseTimer: ReturnType<typeof setTimeout> | null = null;
	/** Active time used, excluding the stretch running since `activeSince`. */
	private activeMs: number;
	private activeSince: number | null = null;
	private parkedAt = 0;
	private readonly envelopes: AssistantEnvelope[] = [];
	private pumpFinished = false;
	/** A release is stopping the process: what it still reports is ignored. */
	private stopping = false;
	/** Set once a release has stored the session: the turn lives on without this query. */
	released = false;
	/** Closed without finishing the turn row ({@link LiveQueryInit.keepTurnOpen}). */
	keptOpen = false;
	private clientMessages: ClientMessage[];
	private lastOutcome: SdkBridgeInnerOutcome | null = null;
	private outcomeSeq = 0;
	private decisive: SdkBridgeInnerOutcome | null = null;
	private gaveUp = false;
	private claudeCodeErrorText: string | null = null;
	private claudeCodeCause: ClaudeCodeFailureCause | null = null;
	private resultSeen = false;
	private resultOk = false;
	/** A side request's reply is settled; nothing Claude Code does after counts. */
	private sideSettled = false;
	private registered = false;
	private pendingTeardown: {
		reason: TeardownReason;
		error: BridgeError;
	} | null = null;
	private resolveDone!: (ok: boolean) => void;
	/** Settles once the query is over: true when its session may be resumed. */
	readonly done: Promise<boolean>;
	private spawnMs: number | null = null;
	private firstEventMs: number | null = null;
	private stopReason: string | null = null;
	private sdkStats: {
		numTurns: number | null;
		input: number | null;
		output: number | null;
		cacheRead: number | null;
		cacheCreation: number | null;
	} = {
		numTurns: null,
		input: null,
		output: null,
		cacheRead: null,
		cacheCreation: null,
	};
	private finalError: BridgeError | null = null;
	private toolUsesThisLeg = 0;
	/** Set while `pump` runs, so the rebuild counter can tell. */
	sawFirstEvent = false;

	constructor(private readonly init: LiveQueryInit) {
		this.turnId = init.turnId;
		this.ownerApiKeyId = init.ownerApiKeyId;
		this.sessionId = init.sessionId;
		this.startedAt = init.startedAt;
		this.conversationKey = init.conversationKey;
		this.requestedModel = init.requestedModel;
		this.clientMessages = init.clientMessages;
		this.activeMs = init.priorActiveMs ?? 0;
		let settled = false;
		this.done = new Promise((resolve) => {
			this.resolveDone = (ok) => {
				if (settled) return;
				settled = true;
				resolve(ok);
			};
		});
	}

	get closed(): boolean {
		return this.state === "closed";
	}

	get awaitingClient(): boolean {
		return this.state === "awaiting_client";
	}

	get releasing(): boolean {
		return this.state === "releasing";
	}

	/**
	 * Ids of the tool calls the client must answer now; empty unless parked.
	 * A query being released still names them: its results wait for the
	 * release and then resume the stored session.
	 */
	get awaitingToolUseIds(): ReadonlySet<string> {
		return this.state === "awaiting_client" || this.state === "releasing"
			? this.awaiting
			: new Set();
	}

	/** Whether `ids` answer every call the query waits on now, each exactly once. */
	answersAwaiting(ids: readonly string[]): boolean {
		return answersExactly(this.awaitingToolUseIds, ids);
	}

	/** Active time used so far; parked and released time is not counted. */
	activeTime(): number {
		return (
			this.activeMs +
			(this.activeSince === null ? 0 : this.init.now() - this.activeSince)
		);
	}

	/** What is left of the turn's active-time budget. */
	remainingBudget(): number {
		return Math.max(0, this.init.turnDeadlineMs - this.activeTime());
	}

	private resumeActive(): void {
		if (this.activeSince !== null) return;
		const now = this.init.now();
		this.activeSince = now;
		const remaining = this.remainingBudget();
		this.init.registration.setDeadline(now + remaining);
		if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
		this.deadlineTimer = setTimeout(
			() =>
				this.teardown(
					"deadline",
					bridgeErrors.deadline(this.init.turnDeadlineMs),
				),
			remaining,
		);
	}

	private pauseActive(): void {
		if (this.activeSince !== null)
			this.activeMs += this.init.now() - this.activeSince;
		this.activeSince = null;
		if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
		this.deadlineTimer = null;
	}

	get historyMode(): SdkBridgeHistoryMode {
		return this.init.historyMode;
	}

	/** Start the query with its first leg's response already created. */
	start(leg: Leg): void {
		this.attach(leg);
		this.resumeActive();
		void this.pump();
	}

	private attach(leg: Leg): void {
		this.leg = leg;
		this.toolUsesThisLeg = 0;
		// A failure answers the leg it happens in; an earlier leg's inner
		// outcome or wording must not decide it.
		this.lastOutcome = null;
		this.decisive = null;
		this.gaveUp = false;
		this.claudeCodeErrorText = null;
		this.claudeCodeCause = null;
		this.init.composer.attach((event) => leg.response.send(event));
		this.armIdle();
	}

	private armIdle(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
		if (
			this.state === "closed" ||
			this.state === "awaiting_client" ||
			this.state === "releasing"
		)
			return;
		const waitingOnClient = this.init.parked.size > 0;
		const ms = waitingOnClient
			? this.init.parkedTimeoutMs
			: this.init.timing.idleTimeoutMs;
		this.idleTimer = setTimeout(() => {
			if (this.init.parked.size > 0 && !waitingOnClient) {
				this.armIdle();
				return;
			}
			if (waitingOnClient)
				this.teardown("parked_timeout", bridgeErrors.parkedTimeout(ms));
			else this.teardown("idle", bridgeErrors.idle(ms));
		}, ms);
	}

	/** The inner call Claude Code gave up on decides the error; later calls do not. */
	private noteGiveUp(): void {
		if (this.gaveUp) return;
		this.gaveUp = true;
		this.decisive =
			this.lastOutcome && this.lastOutcome.status >= 400
				? this.lastOutcome
				: null;
	}

	/** An inner call's `requests` row began: that is what `inner_call_count` counts. */
	onInnerRequestStarted(requestId: string): void {
		if (!requestId || this.innerRequestsStarted.has(requestId)) return;
		this.innerRequestsStarted.add(requestId);
		void this.init.recorder.bump({ innerCalls: 1 });
	}

	/**
	 * How an inner call ended. A refusal before dispatch has no request id and
	 * no row, so it counts as an error only.
	 */
	onInnerOutcome(outcome: SdkBridgeInnerOutcome): void {
		if (outcome.requestId) {
			if (this.innerOutcomesSeen.has(outcome.requestId)) return;
			this.innerOutcomesSeen.add(outcome.requestId);
		}
		this.lastOutcome = outcome;
		this.outcomeSeq++;
		if (outcome.status >= 400) void this.init.recorder.bump({ innerErrors: 1 });
	}

	/** A forwarded client tool_use: counted against the per-turn parked-call limit. */
	onToolUseForwarded(): void {
		this.toolUsesThisLeg++;
		if (
			this.toolUsesThisLeg > this.init.maxParkedCalls &&
			!this.pendingTeardown
		)
			this.pendingTeardown = {
				reason: "limit",
				error: bridgeErrors.limit(
					"maxParkedCallsPerTurn",
					this.toolUsesThisLeg,
					this.init.maxParkedCalls,
				),
			};
	}

	/** Claude Code called one of the client's tools; park it until the client answers. */
	onToolCall(toolUseId: string): Promise<McpToolResult> {
		if (this.state === "closed")
			return Promise.resolve(abortedResult("turn closed"));
		// A reply Claude Code fetched without streaming carries no message_stop;
		// its tool call is the sign that the reply is complete. During a
		// streamed message it is not: Claude Code starts each tool as soon as
		// its block is complete, before the message's other blocks.
		if (
			this.leg &&
			this.state === "running" &&
			!this.init.composer.streamingMessage &&
			this.init.composer.legToolUseIds.includes(toolUseId)
		)
			this.endLeg("tool_use");
		this.armIdle();
		return this.init.parked.wait(toolUseId);
	}

	/**
	 * A continuation leg delivering the client's tool results, which the caller
	 * checked answer every call awaited ({@link answersAwaiting}). `alongside`
	 * is the rest of the same user message (text the user typed with the
	 * results, images), sent to Claude Code as one user message.
	 *
	 * It goes first, while Claude Code still waits on the tool calls, which
	 * makes Claude Code send it after the results in the same model request
	 * (real-claude.integration.test.ts pins this).
	 */
	continueWith(
		leg: Leg,
		toolResults: Block[],
		clientMessages: ClientMessage[],
		alongside: Block[] = [],
	): void {
		if (this.parkedTimer) clearTimeout(this.parkedTimer);
		this.parkedTimer = null;
		if (this.releaseTimer) clearTimeout(this.releaseTimer);
		this.releaseTimer = null;
		const awaiting = this.awaiting;
		this.awaiting = new Set();
		this.state = "running";
		this.resumeActive();
		this.clientMessages = clientMessages;
		void this.init.recorder.insertLeg(leg.id, leg.kind, leg.startedAt);
		this.attach(leg);
		void this.init.recorder.bump({ toolRounds: 1 });
		const parked = this.init.parked;
		const deliver = () => {
			for (const block of toolResults) {
				const id = String(block.tool_use_id);
				if (awaiting.has(id)) parked.deliver(id, toMcpResult(block));
			}
		};
		if (!alongside.length) {
			deliver();
			return;
		}
		// Read off the prompt stream, the message is still to be written to
		// Claude Code's stdin; a macrotask lets the SDK write it before the
		// MCP answers travel the same pipe.
		void this.prompt()
			.enqueue(alongside)
			.then(() => Bun.sleep(PROMPT_WRITE_MS))
			.then(deliver);
	}

	onClientGone(leg: Leg): void {
		if (this.leg !== leg) return;
		this.teardown("client_abort", bridgeErrors.clientGone());
	}

	private finishLeg(
		leg: Leg,
		finish: {
			httpStatus: number;
			error?: BridgeError | null;
			stopReason?: string | null;
			toolUseIds?: string[] | null;
			committed?: boolean;
		},
	): void {
		void this.init.recorder.finishLeg(leg.id, {
			finishedAt: this.init.now(),
			httpStatus: finish.httpStatus,
			errorPhase: finish.error
				? finish.committed
					? "mid_stream"
					: "pre_head"
				: null,
			stopReason: finish.stopReason ?? null,
			errorType: finish.error?.type ?? null,
			errorMessage: finish.error?.message ?? null,
			toolUseIds: finish.toolUseIds?.length ? finish.toolUseIds : null,
		});
	}

	/** The leg's reply is complete. */
	private endLeg(stopReason: string | null): void {
		const leg = this.leg;
		if (!leg) return;
		const composer = this.init.composer;
		const toolUseIds = [...composer.legToolUseIds];
		const content = composer.legContent();
		const finalReason = stopReason ?? composer.lastStopReason ?? "end_turn";
		const parks = finalReason === "tool_use" && toolUseIds.length > 0;
		// Tool calls handed out now could never be answered: the query dies
		// with the bridge. The leg fails instead, with the shutdown 503 while
		// nothing went out, or a closing SSE error once the stream is open.
		// Unless the query can be released: then the calls go out, and their
		// results resume the stored session after the restart.
		if (
			parks &&
			this.init.isShuttingDown() &&
			!(this.init.canRelease?.() ?? false)
		) {
			this.teardown("shutdown", bridgeErrors.shutdown());
			return;
		}
		composer.finish(stopReason);
		this.stopReason = finalReason;
		leg.response.end();
		this.finishLeg(leg, {
			httpStatus: 200,
			stopReason: finalReason,
			toolUseIds,
		});
		this.leg = null;
		if (parks) {
			this.state = "awaiting_client";
			this.awaiting = new Set(toolUseIds);
			this.parkedAt = this.init.now();
			this.pauseActive();
			if (this.idleTimer) clearTimeout(this.idleTimer);
			this.idleTimer = null;
			const release = this.init.onReleaseDue;
			if (this.init.parkReleaseMs != null && release)
				this.releaseTimer = setTimeout(
					() => release(this),
					this.init.parkReleaseMs,
				);
			else this.armParkedTimeout();
			if (this.init.isShuttingDown() && release)
				queueMicrotask(() => release(this));
			return;
		}
		this.state = "finishing";
		this.register([...this.clientMessages, { role: "assistant", content }]);
	}

	private armParkedTimeout(): void {
		if (this.parkedTimer || this.state !== "awaiting_client") return;
		const parkedFor = this.init.now() - this.parkedAt;
		this.parkedTimer = setTimeout(
			() =>
				this.teardown(
					"parked_timeout",
					bridgeErrors.parkedTimeout(this.init.parkedTimeoutMs),
				),
			Math.max(0, this.init.parkedTimeoutMs - parkedFor),
		);
	}

	/**
	 * The bridge will not release this query (at its byte ceiling, without
	 * ownership of the released-parks directory): it stays parked, and the
	 * parked timeout, counted from when it parked, ends it.
	 */
	keepParked(): void {
		if (this.releaseTimer) clearTimeout(this.releaseTimer);
		this.releaseTimer = null;
		this.armParkedTimeout();
	}

	/**
	 * Where a resume continues: the last envelope of the upstream message that
	 * made the awaited calls. Claude Code reports one envelope per content
	 * block, sometimes after the leg's `message_stop`.
	 */
	private resumePoint(): string | null {
		const awaited = this.awaiting;
		const issuing = this.envelopes.findLast((e) =>
			e.toolUseIds.some((id) => awaited.has(id)),
		);
		if (!issuing) return null;
		if (issuing.messageId === null) return issuing.uuid;
		return (
			this.envelopes.findLast((e) => e.messageId === issuing.messageId)?.uuid ??
			null
		);
	}

	/**
	 * Stop a parked query so its session can be stored and resumed later.
	 * Not the teardown path: the parked MCP calls are never answered and
	 * nothing is interrupted or closed while the child lives, since either
	 * writes a synthetic result into the transcript that poisons later
	 * resumes. The token goes first, then SIGTERM (SIGKILL after the grace);
	 * only once the child has exited are the parked handlers cleaned up.
	 *
	 * The query then waits in `releasing` for the bridge to store the session
	 * and call {@link completeRelease} or {@link failRelease}. With no resume
	 * point it refuses and stays parked (`stopped: false`).
	 */
	async release(): Promise<ReleaseStop> {
		if (this.state !== "awaiting_client")
			return { ok: false, reason: "the query is not parked", stopped: false };
		// From here continuations and teardowns wait for the release's outcome.
		this.state = "releasing";
		for (const timer of [
			this.idleTimer,
			this.parkedTimer,
			this.releaseTimer,
			this.deadlineTimer,
			this.exitTimer,
		])
			if (timer) clearTimeout(timer);
		this.idleTimer = null;
		this.parkedTimer = null;
		this.releaseTimer = null;
		this.deadlineTimer = null;
		this.exitTimer = null;
		// Claude Code reports a message's envelopes after its message_stop,
		// so a query released as it parks (at shutdown) may not have them yet.
		let resumeAt = this.resumePoint();
		const envelopesBy = Date.now() + ENVELOPE_WAIT_MS;
		while (!resumeAt && Date.now() < envelopesBy) {
			await Bun.sleep(20);
			resumeAt = this.resumePoint();
		}
		if (!resumeAt) {
			// Still whole: it stays parked, or the caller tears it down.
			this.state = "awaiting_client";
			return {
				ok: false,
				reason: "Claude Code reported no message for the parked calls",
				stopped: false,
			};
		}
		this.stopping = true;
		this.init.registration.revoke();
		this.killProcesses();
		const until = Date.now() + KILL_GRACE_MS + RELEASE_EXIT_WAIT_MS;
		while (
			(!this.pumpFinished ||
				[...this.init.pids].some((pid) => this.init.isAlive(pid))) &&
			Date.now() < until
		)
			await Bun.sleep(20);
		const stopped = ![...this.init.pids].some((pid) => this.init.isAlive(pid));
		try {
			this.init.query.close();
		} catch {}
		this.init.parked.close("released");
		this.prompt().end();
		this.init.composer.detach();
		if (!stopped)
			return {
				ok: false,
				reason: "Claude Code did not exit",
				stopped: true,
			};
		return {
			ok: true,
			sessionId: this.sessionId,
			resumeAt,
			awaitedToolUseIds: [...this.awaiting],
			activeMs: this.activeTime(),
			parkedSince: this.parkedAt,
		};
	}

	/** The session is stored: the turn lives on in its released park, not here. */
	completeRelease(): void {
		if (this.state !== "releasing") return;
		this.released = true;
		this.state = "closed";
		this.resolveDone(false);
		this.init.claim?.release();
		this.init.discardSession(this.sessionId);
		this.discardClaudeCodeTranscripts();
		this.init.onClosed(this);
	}

	/** The release could not be completed: the turn ends here. */
	failRelease(error: BridgeError): void {
		if (this.state !== "releasing") return;
		this.finalError = error;
		this.close("failed", false);
	}

	/**
	 * Offer this query's session to the conversation's next turn now, not at
	 * `result`: the client's next request can arrive before Claude Code
	 * reports it, and waits on `done` instead of rebuilding.
	 */
	private register(conversation: ClientMessage[]): void {
		if (this.registered || !this.init.claim) return;
		let digests: string[];
		try {
			digests = messageDigests(conversation);
		} catch (error) {
			// Unregistered, the session is discarded at close and the next turn rebuilds.
			this.init.log.warn(
				`SDK bridge turn ${this.turnId}: conversation not digestible`,
				error,
			);
			return;
		}
		this.registered = true;
		this.init.claim.register(
			{
				sessionId: this.sessionId,
				digests,
				accountId: this.init.accountId,
			},
			this.done,
		);
	}

	private handleEnd(end: UpstreamMessageEnd | null): void {
		if (!end) return;
		if (this.init.sideRequest && this.leg) this.endSideRequest(end);
		else if (end.kind === "end") this.endLeg(end.stopReason);
	}

	/**
	 * A side request's reply is its first model call's. A tool call (refused
	 * by the tool server, left unanswered by maxTurns) ends it with the text
	 * before it, or fails it when there is none; a max_tokens stop ends it
	 * truncated. The token goes at once, so Claude Code's recovery calls
	 * never spend output past the client's cap.
	 */
	private endSideRequest(end: UpstreamMessageEnd): void {
		const toolCall = end.stopReason === "tool_use";
		if (end.kind !== "end" && !toolCall && end.stopReason !== "max_tokens")
			return;
		this.sideSettled = true;
		this.init.registration.revoke();
		this.scheduleExit();
		if (!toolCall) {
			this.endLeg(end.stopReason);
			return;
		}
		const text = this.init.composer
			.legContent()
			.some((b) => b.type === "text" && String(b.text ?? "").trim());
		if (text) this.endLeg("end_turn");
		else this.failTurn(bridgeErrors.sideRequestToolCall());
	}

	private async pump(): Promise<void> {
		try {
			for await (const message of this.init
				.query as AsyncIterable<SDKMessage>) {
				if (this.state === "closed") break;
				// A query being stopped for release is left to exit on its signal.
				if (this.stopping) continue;
				this.armIdle();
				this.onMessage(message);
				if (this.pendingTeardown) {
					const { reason, error } = this.pendingTeardown;
					this.teardown(reason, error);
					break;
				}
				if (this.resultSeen) {
					this.prompt().end();
					this.scheduleExit();
				}
			}
		} catch (error) {
			if (this.state !== "closed" && this.state !== "releasing") {
				this.init.log.warn(
					`SDK bridge turn ${this.turnId}: query failed`,
					error,
				);
				const text = error instanceof Error ? error.message : String(error);
				this.claudeCodeErrorText ??= text;
				if (isContextOverflow({ text }))
					this.claudeCodeCause ??= "context_overflow";
			}
		}
		await this.afterPump();
	}

	private prompt(): PromptStream {
		return this.init.prompt;
	}

	private onMessage(message: SDKMessage): void {
		switch (message.type) {
			case "system":
				if (message.subtype === "init" && this.spawnMs === null)
					this.spawnMs = this.init.now() - this.startedAt;
				return;
			case "stream_event": {
				if (message.parent_tool_use_id !== null) return;
				if (this.firstEventMs === null)
					this.firstEventMs = this.init.now() - this.startedAt;
				this.sawFirstEvent = true;
				if (!this.leg) {
					this.init.log.debug(
						`SDK bridge turn ${this.turnId}: stream event ${message.event.type} with no open leg`,
					);
					return;
				}
				this.handleEnd(
					this.init.composer.onStreamEvent(
						message.event as unknown as StreamEvent,
					),
				);
				return;
			}
			case "assistant": {
				if (message.parent_tool_use_id !== null) return;
				if (
					!message.error &&
					message.message.model !== "<synthetic>" &&
					!message.aborted
				)
					this.envelopes.push({
						uuid: message.uuid,
						messageId:
							typeof message.message.id === "string"
								? message.message.id
								: null,
						toolUseIds: (Array.isArray(message.message.content)
							? (message.message.content as unknown as Block[])
							: []
						)
							.filter((b) => b.type === "tool_use")
							.map((b) => String(b.id)),
					});
				if (message.error) {
					this.noteGiveUp();
					const text = textOf(message.message.content as unknown as Block[]);
					this.claudeCodeErrorText = text;
					if (isContextOverflow({ text }))
						this.claudeCodeCause ??= "context_overflow";
					return;
				}
				if (message.message.model === "<synthetic>" || message.aborted) return;
				if (!this.leg) return;
				this.handleEnd(
					this.init.composer.onAssistantMessage(
						message.message as unknown as Record<string, unknown>,
					),
				);
				return;
			}
			case "result":
				this.onResult(message);
				return;
			default:
				return;
		}
	}

	private onResult(message: Extract<SDKMessage, { type: "result" }>): void {
		this.resultSeen = true;
		const usage = message.usage as unknown as
			| Record<string, number | undefined>
			| undefined;
		this.sdkStats = {
			numTurns: message.num_turns ?? null,
			input: usage?.input_tokens ?? null,
			output: usage?.output_tokens ?? null,
			cacheRead: usage?.cache_read_input_tokens ?? null,
			cacheCreation: usage?.cache_creation_input_tokens ?? null,
		};
		// Whatever ended Claude Code after a side request's reply settled
		// (maxTurns, a refused recovery call) does not change that reply.
		if (this.sideSettled) {
			this.resultOk = this.finalError === null;
			return;
		}
		const failed = message.is_error || message.subtype !== "success";
		if (!failed) {
			this.resultOk = true;
			if (this.leg) this.endLeg(this.init.composer.lastStopReason);
			return;
		}
		this.noteGiveUp();
		const text =
			message.subtype === "success"
				? message.result
				: (message.errors ?? []).join("; ") || message.subtype;
		this.claudeCodeErrorText = this.claudeCodeErrorText ?? text;
		if (isContextOverflow({ text, terminalReason: message.terminal_reason }))
			this.claudeCodeCause ??= "context_overflow";
		void this.failAfterGrace();
	}

	/**
	 * The proxy reports a failed call's body after handing the response back,
	 * so a give-up can overtake its report; wait briefly for it.
	 */
	private async failAfterGrace(): Promise<void> {
		if (!this.decisive) {
			const seq = this.outcomeSeq;
			const until = Date.now() + OUTCOME_GRACE_MS;
			while (this.outcomeSeq === seq && Date.now() < until) await Bun.sleep(10);
			if (this.lastOutcome && this.lastOutcome.status >= 400)
				this.decisive = this.lastOutcome;
		}
		this.failTurn(this.claudeCodeFailure());
	}

	private claudeCodeFailure(fallbackText: string | null = null): BridgeError {
		return mapClaudeCodeFailure(this.decisive, {
			text: this.claudeCodeErrorText ?? fallbackText,
			cause: this.claudeCodeCause,
		});
	}

	private failTurn(error: BridgeError): void {
		this.finalError = error;
		const leg = this.leg;
		if (!leg) return;
		const committed = leg.response.committed;
		leg.response.fail(error);
		this.finishLeg(leg, { httpStatus: error.status, error, committed });
		this.leg = null;
		this.init.composer.detach();
	}

	private scheduleExit(): void {
		if (this.exitTimer) return;
		this.exitTimer = setTimeout(() => {
			try {
				this.init.query.close();
			} catch {}
			this.killProcesses();
		}, this.init.timing.exitGraceMs);
	}

	private killProcesses(): void {
		for (const pid of this.init.pids) {
			if (!this.init.isAlive(pid)) continue;
			const peak = this.init.readPeakRss(pid);
			if (peak !== null) this.init.onPeakRss(peak);
			this.init.killProcessGroup(pid, "SIGTERM");
			setTimeout(() => {
				if (this.init.isAlive(pid)) this.init.killProcessGroup(pid, "SIGKILL");
			}, KILL_GRACE_MS).unref?.();
		}
	}

	/**
	 * Delete Claude Code's own transcript now, and once more after the kill
	 * grace: a child still exiting can write it again.
	 */
	private discardClaudeCodeTranscripts(): void {
		const discard = () => {
			try {
				this.init.discardClaudeCodeTranscripts(this.sessionId);
			} catch (error) {
				this.init.log.warn(
					`SDK bridge turn ${this.turnId}: could not delete Claude Code's transcript`,
					error,
				);
			}
		};
		discard();
		if ([...this.init.pids].some((pid) => this.init.isAlive(pid)))
			setTimeout(discard, KILL_GRACE_MS + 500).unref?.();
	}

	/** Peak RSS of this query's live Claude Code processes. */
	samplePeakRss(): void {
		for (const pid of this.init.pids) {
			const peak = this.init.readPeakRss(pid);
			if (peak !== null) this.init.onPeakRss(peak);
		}
	}

	private async afterPump(): Promise<void> {
		this.pumpFinished = true;
		if (this.exitTimer) clearTimeout(this.exitTimer);
		this.exitTimer = null;
		// A released query's exit without a result is the release, not a failure.
		if (this.state === "closed" || this.state === "releasing") return;
		if (this.sideSettled) {
			this.samplePeakRss();
			this.close(this.finalError ? "failed" : "completed", !this.finalError);
			return;
		}
		if (!this.resultSeen) {
			this.noteGiveUp();
			this.failTurn(
				this.claudeCodeFailure("Claude Code exited without a result"),
			);
		} else if (!this.resultOk) {
			// failAfterGrace may still be waiting on the proxy's report.
			const until = Date.now() + OUTCOME_GRACE_MS + 50;
			while (this.leg && Date.now() < until) await Bun.sleep(10);
			if (this.leg) this.failTurn(this.claudeCodeFailure());
		}
		this.samplePeakRss();
		this.close(this.resultOk ? "completed" : "failed", this.resultOk);
	}

	/** Tear the query down. The token goes first, so an orphaned child's calls fail. */
	teardown(reason: TeardownReason, error: BridgeError): void {
		// A release in progress ends through completeRelease or failRelease.
		if (this.state === "closed" || this.state === "releasing") return;
		this.init.registration.revoke();
		this.init.parked.close(reason);
		this.prompt().end();
		const leg = this.leg;
		if (leg) {
			const committed = leg.response.committed;
			// A no-op for a client that is already gone.
			leg.response.fail(error);
			this.finishLeg(leg, { httpStatus: error.status, error, committed });
			this.leg = null;
		}
		this.finalError = error;
		this.init.composer.detach();
		const query = this.init.query;
		void query.interrupt().catch(() => {});
		try {
			query.close();
		} catch {}
		this.samplePeakRss();
		this.killProcesses();
		this.close(TEARDOWN_STATUS[reason], false);
	}

	private close(status: SdkBridgeTurnStatus, ok: boolean): void {
		if (this.state === "closed") return;
		this.state = "closed";
		for (const timer of [
			this.idleTimer,
			this.parkedTimer,
			this.deadlineTimer,
			this.exitTimer,
			this.releaseTimer,
		])
			if (timer) clearTimeout(timer);
		this.init.registration.revoke();
		this.init.parked.close(status);
		this.prompt().end();
		this.resolveDone(ok);
		// A registered session belongs to its conversation, which discards it
		// once a later one replaces it or it fails to settle.
		if (!this.registered) {
			this.init.claim?.release();
			this.init.discardSession(this.sessionId);
		}
		this.discardClaudeCodeTranscripts();
		if (this.init.keepTurnOpen?.(status)) {
			this.keptOpen = true;
			this.init.onClosed(this);
			return;
		}
		const now = this.init.now();
		const error = ok ? null : this.finalError;
		void this.init.recorder.finishTurn({
			finishedAt: now,
			status,
			httpStatus: error ? error.status : 200,
			errorType: error?.type ?? null,
			errorMessage: error ? sanitizeMessage(error.message) : null,
			stopReason: this.stopReason,
			ccSessionId: this.sessionId,
			spawnMs: this.spawnMs,
			firstEventMs: this.firstEventMs,
			durationMs: now - this.startedAt,
			sdkNumTurns: this.sdkStats.numTurns,
			sdkInputTokens: this.sdkStats.input,
			sdkOutputTokens: this.sdkStats.output,
			sdkCacheReadInputTokens: this.sdkStats.cacheRead,
			sdkCacheCreationInputTokens: this.sdkStats.cacheCreation,
		});
		this.init.onClosed(this);
	}
}

function textOf(content: Block[] | string | undefined): string {
	if (typeof content === "string") return content;
	return (content ?? [])
		.filter((b) => b.type === "text")
		.map((b) => String(b.text ?? ""))
		.join("\n");
}
