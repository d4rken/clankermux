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
	| "error";

const TEARDOWN_STATUS: Record<TeardownReason, SdkBridgeTurnStatus> = {
	client_abort: "aborted",
	parked_timeout: "timed_out",
	deadline: "timed_out",
	idle: "failed",
	shutdown: "shutdown",
	limit: "failed",
	error: "failed",
};

/** How long an error `result` waits for the proxy's report of the failed call. */
const OUTCOME_GRACE_MS = 250;
/** SIGTERM to SIGKILL, for a child that ignores the polite signal. */
const KILL_GRACE_MS = 2_000;

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
	turnDeadlineMs: number;
	maxParkedCalls: number;
	startedAt: number;
	now: () => number;
	log: BridgeLog;
	isShuttingDown: () => boolean;
	/** The session will never be resumed; its transcript can go. */
	discardSession: (sessionId: string) => void;
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
	state: "running" | "awaiting_client" | "finishing" | "closed" = "running";
	readonly turnId: string;
	readonly ownerApiKeyId: string | null;
	readonly sessionId: string;
	readonly startedAt: number;
	private leg: Leg | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private parkedTimer: ReturnType<typeof setTimeout> | null = null;
	private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
	private exitTimer: ReturnType<typeof setTimeout> | null = null;
	private clientMessages: ClientMessage[];
	private lastOutcome: SdkBridgeInnerOutcome | null = null;
	private outcomeSeq = 0;
	private decisive: SdkBridgeInnerOutcome | null = null;
	private gaveUp = false;
	private claudeCodeErrorText: string | null = null;
	private resultSeen = false;
	private resultOk = false;
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
		this.clientMessages = init.clientMessages;
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

	get historyMode(): SdkBridgeHistoryMode {
		return this.init.historyMode;
	}

	/** Start the query with its first leg's response already created. */
	start(leg: Leg): void {
		this.attach(leg);
		this.deadlineTimer = setTimeout(
			() =>
				this.teardown(
					"deadline",
					bridgeErrors.deadline(this.init.turnDeadlineMs),
				),
			Math.max(0, this.startedAt + this.init.turnDeadlineMs - this.init.now()),
		);
		void this.pump();
	}

	private attach(leg: Leg): void {
		this.leg = leg;
		this.toolUsesThisLeg = 0;
		this.init.composer.attach((event) => leg.response.send(event));
		this.armIdle();
	}

	private armIdle(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
		if (this.state === "closed" || this.state === "awaiting_client") return;
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

	onInnerOutcome(outcome: SdkBridgeInnerOutcome): void {
		this.lastOutcome = outcome;
		this.outcomeSeq++;
		void this.init.recorder.bump({
			innerCalls: 1,
			innerErrors: outcome.status >= 400 ? 1 : 0,
		});
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

	/** A continuation leg delivering the client's tool results. */
	continueWith(
		leg: Leg,
		toolResults: Block[],
		clientMessages: ClientMessage[],
	): void {
		if (this.parkedTimer) clearTimeout(this.parkedTimer);
		this.parkedTimer = null;
		this.state = "running";
		this.clientMessages = clientMessages;
		void this.init.recorder.insertLeg(leg.id, leg.kind, leg.startedAt);
		this.attach(leg);
		void this.init.recorder.bump({ toolRounds: 1 });
		for (const block of toolResults)
			this.init.parked.deliver(String(block.tool_use_id), toMcpResult(block));
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
		composer.finish(stopReason);
		const finalReason = stopReason ?? composer.lastStopReason ?? "end_turn";
		this.stopReason = finalReason;
		leg.response.end();
		this.finishLeg(leg, {
			httpStatus: 200,
			stopReason: finalReason,
			toolUseIds,
		});
		this.leg = null;
		if (finalReason === "tool_use" && toolUseIds.length) {
			this.state = "awaiting_client";
			if (this.idleTimer) clearTimeout(this.idleTimer);
			this.idleTimer = null;
			if (this.init.isShuttingDown()) {
				queueMicrotask(() =>
					this.teardown("shutdown", bridgeErrors.shutdown()),
				);
				return;
			}
			this.parkedTimer = setTimeout(
				() =>
					this.teardown(
						"parked_timeout",
						bridgeErrors.parkedTimeout(this.init.parkedTimeoutMs),
					),
				this.init.parkedTimeoutMs,
			);
			return;
		}
		this.state = "finishing";
		this.register([...this.clientMessages, { role: "assistant", content }]);
	}

	/**
	 * Offer this query's session to the conversation's next turn now, not at
	 * `result`: the client's next request can arrive before Claude Code
	 * reports it, and waits on `done` instead of rebuilding.
	 */
	private register(conversation: ClientMessage[]): void {
		if (this.registered || !this.init.claim) return;
		this.registered = true;
		this.init.claim.register(
			{
				sessionId: this.sessionId,
				digests: messageDigests(conversation),
				accountId: this.init.accountId,
			},
			this.done,
		);
	}

	private handleEnd(end: UpstreamMessageEnd | null): void {
		if (end?.kind === "end") this.endLeg(end.stopReason);
	}

	private async pump(): Promise<void> {
		try {
			for await (const message of this.init
				.query as AsyncIterable<SDKMessage>) {
				if (this.state === "closed") break;
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
			if (this.state !== "closed") {
				this.init.log.warn(
					`SDK bridge turn ${this.turnId}: query failed`,
					error,
				);
				this.claudeCodeErrorText ??=
					error instanceof Error ? error.message : String(error);
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
				if (message.error) {
					this.noteGiveUp();
					this.claudeCodeErrorText = textOf(
						message.message.content as unknown as Block[],
					);
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
		this.failTurn(
			mapClaudeCodeFailure(this.decisive, this.claudeCodeErrorText),
		);
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

	/** Peak RSS of this query's live Claude Code processes. */
	samplePeakRss(): void {
		for (const pid of this.init.pids) {
			const peak = this.init.readPeakRss(pid);
			if (peak !== null) this.init.onPeakRss(peak);
		}
	}

	private async afterPump(): Promise<void> {
		if (this.exitTimer) clearTimeout(this.exitTimer);
		this.exitTimer = null;
		if (this.state === "closed") return;
		if (!this.resultSeen) {
			this.noteGiveUp();
			this.failTurn(
				mapClaudeCodeFailure(
					this.decisive,
					this.claudeCodeErrorText ?? "Claude Code exited without a result",
				),
			);
		} else if (!this.resultOk) {
			// failAfterGrace may still be waiting on the proxy's report.
			const until = Date.now() + OUTCOME_GRACE_MS + 50;
			while (this.leg && Date.now() < until) await Bun.sleep(10);
			if (this.leg)
				this.failTurn(
					mapClaudeCodeFailure(this.decisive, this.claudeCodeErrorText),
				);
		}
		this.samplePeakRss();
		this.close(this.resultOk ? "completed" : "failed", this.resultOk);
	}

	/** Tear the query down. The token goes first, so an orphaned child's calls fail. */
	teardown(reason: TeardownReason, error: BridgeError): void {
		if (this.state === "closed") return;
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
