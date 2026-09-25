import { randomBytes } from "node:crypto";
import { Logger } from "@clankermux/logger";
import {
	SDK_BRIDGE_SIDE_REQUEST_FORK,
	type SdkBridgeAvailability,
	SdkBridgeCapacityError,
	type SdkBridgeCounters,
	type SdkBridgeHistoryMode,
	type SdkBridgeInnerContext,
	type SdkBridgeRouteCandidate,
	type SdkBridgeRoutePlan,
	type SdkBridgeStatus,
	type SdkBridgeSystemPromptDetail,
	type SdkBridgeTransport,
	type SdkBridgeTurnInsert,
	type SdkBridgeTurnKind,
	type SdkBridgeTurnMeta,
	SdkBridgeUnavailableError,
} from "@clankermux/types";
import {
	type AdmissionRejection,
	checkAdmission,
	checkBodySize,
} from "./admission";
import {
	type ConversationClaim,
	ConversationStore,
	conversationKey,
} from "./conversation-store";
import {
	type BridgeError,
	bridgeErrors,
	errorResponse,
	errorSummary,
} from "./errors";
import {
	type ApiMessage,
	answersFinalToolCalls,
	buildSyntheticTranscript,
	classifyRebuild,
	firstUserDigest,
	flattenBlocks,
	flattenHistory,
	messageDigests,
	messagesAfter,
	normalizeHistory,
	type RebuildReason,
	sameDigests,
	transcriptEligible,
} from "./history";
import { InnerListener, type InnerRegistration } from "./inner-listener";
import { type Leg, LiveQuery } from "./live-query";
import { buildQueryOptions, type WorkPaths, workPaths } from "./options";
import { PromptStream } from "./prompt-stream";
import { TurnRecorder } from "./recorder";
import { ReplyComposer } from "./reply-composer";
import { FileSessionStore, removeClaudeCodeTranscripts } from "./session-store";
import {
	ProcessGroupSpawner,
	readPeakRssBytes,
	resolveClaudeExecutable,
} from "./spawn";
import { LegResponse } from "./sse";
import {
	type SystemPromptDecision,
	selectSystemPromptPolicy,
} from "./system-prompt-policy";
import {
	createToolServer,
	loadMcpSdk,
	type McpSdk,
	ParkedCalls,
	ToolNames,
} from "./tool-server";
import {
	type Block,
	blocksOf,
	parseTurnRequest,
	type TurnRequest,
} from "./turn-request";
import {
	type BridgeLog,
	type ClaudeSdkBridgeDeps,
	DEFAULT_SDK_BRIDGE_LIMITS,
	DEFAULT_SDK_BRIDGE_TIMING,
	type QueryFn,
	type SdkBridgeLimits,
} from "./types";
import {
	claimGeneration,
	ensurePrivateDir,
	removeTree,
	sweepGenerations,
} from "./work-dirs";

/** Claude Code version the bundled binary reports; written into rebuilt transcripts. */
const CLAUDE_CODE_VERSION = "2.1.280";

export type { SdkBridgeCounters, SdkBridgeStatus };

/** The system-prompt policy a turn ran and what it made of the prompt. */
interface PromptRecord {
	policy: string;
	detail: SdkBridgeSystemPromptDetail | null;
}

export interface ClaudeSdkBridge extends SdkBridgeTransport {
	/** Refuse new turns and kill parked queries, now and whenever one parks later. */
	beginShutdown(): void;
	/** Abort everything left, stop the listener and SIGKILL leftover processes. */
	dispose(): Promise<void>;
	status(): SdkBridgeStatus;
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		value,
	);
}

function sdkResolvable(): string | null {
	for (const specifier of [
		"@anthropic-ai/claude-agent-sdk",
		"@modelcontextprotocol/sdk/server/mcp.js",
	])
		try {
			import.meta.resolve(specifier);
		} catch (error) {
			return `${specifier} cannot be loaded (${errorSummary(error)})`;
		}
	return null;
}

function toolResultIds(turn: TurnRequest): string[] {
	return turn.toolResults.map((b) => String(b.tool_use_id));
}

/** The final user message minus its tool results and empty text. */
function blocksAlongsideResults(turn: TurnRequest): Block[] {
	return normalizeHistory([turn.last])
		.flatMap((m) => m.content)
		.filter(
			(b) =>
				b.type !== "tool_result" &&
				!(b.type === "text" && !String(b.text ?? "").trim()),
		);
}

/** A stack overflow from serializing client content: the request's fault. */
function isNestingOverflow(error: unknown): boolean {
	return (
		error instanceof RangeError && /call stack/i.test(String(error.message))
	);
}

export function createClaudeSdkBridge(
	deps: ClaudeSdkBridgeDeps,
): ClaudeSdkBridge {
	const log: BridgeLog = deps.log ?? new Logger("ClaudeSdkBridge");
	const now = deps.now ?? Date.now;
	const randomId = deps.randomId ?? (() => crypto.randomUUID());
	const timing = { ...DEFAULT_SDK_BRIDGE_TIMING, ...deps.timing };
	const limits = (): SdkBridgeLimits => ({
		...DEFAULT_SDK_BRIDGE_LIMITS,
		...deps.limits?.(),
	});

	let unavailableReason: string | null = null;
	let executablePath = "";
	if (deps.claudeExecutablePath === null)
		unavailableReason = "no Claude Code executable configured";
	else if (deps.claudeExecutablePath)
		executablePath = deps.claudeExecutablePath;
	else {
		const resolved = resolveClaudeExecutable();
		if ("error" in resolved) unavailableReason = resolved.error;
		else executablePath = resolved.path;
	}
	if (!unavailableReason && !deps.queryFn) unavailableReason = sdkResolvable();

	// This process's own directory under the work root. Earlier processes'
	// directories go now, unless their process still runs; this one goes at
	// dispose.
	let generationRoot: string | null = null;
	let paths: WorkPaths | null = null;
	if (!unavailableReason)
		try {
			generationRoot = claimGeneration(
				deps.workRoot,
				`${now().toString(36)}-${process.pid}-${randomBytes(4).toString("hex")}`,
			);
			const swept = sweepGenerations(deps.workRoot, generationRoot);
			if (swept.length)
				log.info(
					`SDK bridge: removed ${swept.length} work director${swept.length === 1 ? "y" : "ies"} earlier processes left`,
				);
			paths = workPaths(generationRoot);
		} catch (error) {
			unavailableReason = `its work directory ${deps.workRoot} is unusable (${errorSummary(error)})`;
		}

	let sdks: Promise<{ query: QueryFn; mcp: McpSdk }> | null = null;
	const loadSdks = async (): Promise<{ query: QueryFn; mcp: McpSdk }> => {
		sdks ??= Promise.all([
			deps.queryFn
				? deps.queryFn
				: import("@anthropic-ai/claude-agent-sdk").then(
						(sdk) => sdk.query as QueryFn,
					),
			loadMcpSdk(),
		]).then(([query, mcp]) => ({ query, mcp }));
		try {
			return await sdks;
		} catch (error) {
			unavailableReason = `the Agent SDK or the MCP SDK failed to load (${errorSummary(error)})`;
			throw new SdkBridgeUnavailableError(unavailableReason);
		}
	};

	let shuttingDown = false;
	let workDirsReady = false;
	let store: FileSessionStore | null = null;
	const workDirs = (): WorkPaths => {
		if (!paths) throw new SdkBridgeUnavailableError("no work directory");
		if (!workDirsReady) {
			for (const dir of Object.values(paths)) ensurePrivateDir(dir);
			workDirsReady = true;
		}
		return paths;
	};
	const sessionStore = (): FileSessionStore => {
		store ??= new FileSessionStore(workDirs().sessions);
		return store;
	};
	const discardSession = (sessionId: string) => store?.remove(sessionId);
	const discardClaudeCodeTranscripts = (sessionId: string) => {
		if (paths) removeClaudeCodeTranscripts(paths.configDir, sessionId);
	};

	const lives = new Map<string, LiveQuery>();
	/** The live query of each conversation that has one. */
	const liveByConversation = new Map<string, LiveQuery>();
	/** Every tool_use id a live query has handed out, in any round. */
	const toolIndex = new Map<string, string>();
	const turnToolIds = new Map<string, string[]>();
	const conversations = new ConversationStore({
		now,
		onDiscard: discardSession,
	});
	const counters: SdkBridgeCounters = {
		turnsStarted: 0,
		turnsCompleted: 0,
		turnsFailed: 0,
		continuations: 0,
		rejected: {},
		resumes: 0,
		rebuilds: 0,
		sideRequests: 0,
	};
	let peakRssBytes: number | null = null;
	const notePeakRss = (bytes: number) => {
		peakRssBytes = Math.max(peakRssBytes ?? 0, bytes);
	};

	const listener = new InnerListener({
		dispatchInner: deps.dispatchInner,
		log,
		maxBodyBytes: () => limits().maxHistoryBytes,
	});
	const spawner = new ProcessGroupSpawner((pid, text) =>
		log.debug(`[claude ${pid}] ${text.trimEnd()}`),
	);

	const availability = (): SdkBridgeAvailability => {
		if (shuttingDown) return { state: "shutting_down" };
		if (unavailableReason)
			return { state: "unavailable", reason: unavailableReason };
		return { state: "available" };
	};

	const assertAvailable = () => {
		const state = availability();
		if (state.state === "shutting_down")
			throw new SdkBridgeUnavailableError("shutting down");
		if (state.state === "unavailable")
			throw new SdkBridgeUnavailableError(state.reason);
	};

	/** A turn that ends before any Claude Code process: a rejected turn row plus its leg. */
	function reject(
		recorder: TurnRecorder,
		meta: SdkBridgeTurnMeta,
		plan: SdkBridgeRoutePlan | null,
		startedAt: number,
		prompt: PromptRecord,
		kind: SdkBridgeTurnKind,
		error: BridgeError,
		reason: string,
	): Response {
		counters.rejected[reason] = (counters.rejected[reason] ?? 0) + 1;
		void recorder.insertTurn({
			kind,
			startedAt,
			status: "rejected",
			historyMode: "fresh",
			systemPromptPolicy: prompt.policy,
			systemPromptDetail: prompt.detail,
			apiKeyId: meta.apiKeyId,
			apiKeyName: meta.apiKeyName,
			accountId: plan?.preferredAccountId ?? null,
			model: meta.model || null,
			clientHarness: meta.clientHarness,
			clientUserAgent: meta.clientUserAgent,
			project: meta.project,
		});
		void recorder.insertLeg(meta.legId, "start", startedAt);
		void recorder.finishLeg(meta.legId, {
			finishedAt: now(),
			httpStatus: error.status,
			errorPhase: "pre_head",
			errorType: error.type,
			errorMessage: error.message,
		});
		void recorder.finishTurn({
			finishedAt: now(),
			status: "rejected",
			httpStatus: error.status,
			errorType: error.type,
			errorMessage: error.message,
			durationMs: now() - startedAt,
		});
		return errorResponse(error);
	}

	/**
	 * A request that tried to continue `turnId` and was refused: one `continue`
	 * leg on that turn, whatever the reason. The only place such legs are written.
	 */
	function refuseContinuation(
		turnId: string,
		meta: SdkBridgeTurnMeta,
		startedAt: number,
		error: BridgeError,
	): Response {
		const recorder = new TurnRecorder(deps.turnRepo, log, turnId);
		void recorder.insertLeg(meta.legId, "continue", startedAt);
		void recorder.finishLeg(meta.legId, {
			finishedAt: now(),
			httpStatus: error.status,
			errorPhase: "pre_head",
			errorType: error.type,
			errorMessage: error.message,
		});
		return errorResponse(error);
	}

	async function readBody(
		request: Request,
	): Promise<{ bytes: number; json: unknown } | { error: AdmissionRejection }> {
		const buffer = await request.arrayBuffer();
		const size = checkBodySize(buffer.byteLength, limits());
		if (size) return { error: size };
		try {
			return {
				bytes: buffer.byteLength,
				json: JSON.parse(new TextDecoder().decode(buffer)),
			};
		} catch {
			return {
				error: {
					...bridgeErrors.invalid("Body is not valid JSON"),
					reason: "invalid",
				},
			};
		}
	}

	interface HistoryDecision {
		mode: SdkBridgeHistoryMode;
		reason: RebuildReason | null;
	}

	function rebuildMode(
		turn: TurnRequest,
	): "rebuild_transcript" | "rebuild_flattened" {
		return transcriptEligible(
			normalizeHistory(turn.history),
			new Set(turn.tools.map((t) => t.name)),
		)
			? "rebuild_transcript"
			: "rebuild_flattened";
	}

	function decideHistory(
		turn: TurnRequest,
		claim: ConversationClaim | null,
		accountId: string,
	): HistoryDecision {
		const normalized = normalizeHistory(turn.history);
		if (!normalized.length) return { mode: "fresh", reason: null };
		const digests = messageDigests(turn.history);
		const current = claim?.current ?? null;
		const reason = classifyRebuild(current, digests, accountId);
		if (
			current &&
			sameDigests(current.digests, digests) &&
			reason === "continuation"
		)
			return { mode: "resume", reason: null };
		return { mode: rebuildMode(turn), reason };
	}

	function rebuildsInFlight(): number {
		let n = 0;
		for (const live of lives.values())
			if (live.historyMode.startsWith("rebuild") && !live.sawFirstEvent) n++;
		return n;
	}

	/** A live query that handed out any of `ids`, in this round or an earlier one. */
	function liveIssuing(ids: readonly string[]): LiveQuery | null {
		for (const id of ids) {
			const turnId = toolIndex.get(id);
			const live = turnId ? lives.get(turnId) : undefined;
			if (live && !live.closed) return live;
		}
		return null;
	}

	function newLeg(
		id: string,
		kind: Leg["kind"],
		stream: boolean,
		signal: AbortSignal,
		bumpIdleTimeout: (() => void) | undefined,
		onGone: (leg: Leg) => void,
	): Leg {
		const leg: Leg = {
			id,
			kind,
			startedAt: now(),
			response: null as unknown as LegResponse,
		};
		leg.response = new LegResponse({
			stream,
			headHoldMs: timing.headHoldMs,
			pingIntervalMs: timing.pingIntervalMs,
			signal,
			onClientGone: () => onGone(leg),
			bumpIdleTimeout,
		});
		return leg;
	}

	type StartInput = Parameters<SdkBridgeTransport["startTurn"]>[0];

	/** What starting a query took, for its caller to give back if the start fails. */
	interface Launching {
		registration: InnerRegistration | null;
		prompt: PromptStream | null;
		query: ReturnType<QueryFn> | null;
		pids: Set<number>;
	}

	const launching = (): Launching => ({
		registration: null,
		prompt: null,
		query: null,
		pids: new Set(),
	});

	/** Give back everything a failed start took, and the new session's files. */
	function abandonLaunch(taken: Launching, sessionId: string | null): void {
		taken.registration?.revoke();
		taken.prompt?.end();
		try {
			taken.query?.close();
		} catch {}
		for (const pid of taken.pids) spawner.kill(pid, "SIGKILL");
		if (sessionId) {
			discardSession(sessionId);
			discardClaudeCodeTranscripts(sessionId);
		}
	}

	/**
	 * Start Claude Code on `sessionId` and make the query live. What it takes
	 * is recorded in `taken` as it goes; a throw leaves the rest to
	 * {@link abandonLaunch}.
	 */
	function launchQuery(
		taken: Launching,
		input: {
			start: StartInput;
			run: QueryFn;
			mcp: McpSdk;
			turn: TurnRequest;
			target: SdkBridgeRouteCandidate;
			toolNames: ToolNames;
			systemPrompt: SystemPromptDecision;
			sessionId: string;
			historyMode: SdkBridgeHistoryMode;
			promptContent: Block[];
			/** The conversation this query holds and may register with. */
			claim: ConversationClaim | null;
			convKey: string | null;
			recorder: TurnRecorder;
			startedAt: number;
		},
	): LiveQuery {
		const { plan, meta } = input.start;
		const { turn, toolNames } = input;
		const dirs = workDirs();
		let live: LiveQuery | null = null;
		const context: SdkBridgeInnerContext = {
			turnId: plan.turnId,
			plan,
			apiKeyId: meta.apiKeyId ?? plan.apiKeyId,
			apiKeyName: meta.apiKeyName ?? plan.apiKeyName,
			clientHarness: meta.clientHarness,
			project: meta.project,
			projectAttributionSource: meta.projectAttributionSource,
			deadlineAt: input.startedAt + limits().turnDeadlineMs,
			onInnerRequestStarted: (requestId) =>
				live?.onInnerRequestStarted(requestId),
			onInnerOutcome: (outcome) => live?.onInnerOutcome(outcome),
		};
		const registration = listener.register(context);
		taken.registration = registration;
		const baseUrl = listener.ensureStarted();
		const parked = new ParkedCalls();
		const toolServer = turn.tools.length
			? createToolServer(input.mcp, turn.tools, toolNames, (id) =>
					live ? live.onToolCall(id) : parked.wait(id),
				)
			: null;
		const abortController = new AbortController();
		const prompt = new PromptStream();
		taken.prompt = prompt;
		prompt.push(input.promptContent);
		const query = input.run({
			prompt,
			options: buildQueryOptions({
				paths: dirs,
				baseUrl,
				token: registration.token,
				model: input.target.upstreamModel,
				toolNames: toolNames.exposed,
				toolServer,
				systemPrompt: input.systemPrompt,
				effort: turn.effort,
				maxOutputTokens: turn.maxOutputTokens,
				sessionId: input.sessionId,
				resume:
					input.historyMode === "resume" ||
					input.historyMode === "rebuild_transcript",
				sessionStore: sessionStore(),
				executablePath,
				spawn: (options) =>
					spawner.spawn(options, (pid) => {
						taken.pids.add(pid);
					}),
				stderr: (text) =>
					log.debug(`[claude ${plan.turnId}] ${text.trimEnd()}`),
				abortController,
			}),
		});
		taken.query = query;

		const composer = new ReplyComposer({
			toolNames,
			onToolUse: (id) => {
				toolIndex.set(id, plan.turnId);
				const ids = turnToolIds.get(plan.turnId) ?? [];
				ids.push(id);
				turnToolIds.set(plan.turnId, ids);
				live?.onToolUseForwarded();
			},
			newMessageId: () => `msg_sdk_bridge_${randomId().replaceAll("-", "")}`,
		});
		const current = limits();
		live = new LiveQuery({
			turnId: plan.turnId,
			ownerApiKeyId: meta.apiKeyId,
			sessionId: input.sessionId,
			accountId: plan.preferredAccountId,
			requestedModel: meta.model,
			historyMode: input.historyMode,
			query,
			prompt,
			parked,
			composer,
			recorder: input.recorder,
			registration,
			pids: taken.pids,
			killProcessGroup: (pid, signal) => spawner.kill(pid, signal),
			isAlive: (pid) => spawner.isAlive(pid),
			readPeakRss: readPeakRssBytes,
			claim: input.claim,
			clientMessages: turn.messages,
			timing,
			parkedTimeoutMs: current.parkedTimeoutMs,
			turnDeadlineMs: current.turnDeadlineMs,
			maxParkedCalls: current.maxParkedCallsPerTurn,
			startedAt: input.startedAt,
			now,
			log,
			isShuttingDown: () => shuttingDown,
			conversationKey: input.convKey,
			discardSession,
			discardClaudeCodeTranscripts,
			onPeakRss: notePeakRss,
			onClosed: (closed) => {
				lives.delete(closed.turnId);
				if (
					closed.conversationKey &&
					liveByConversation.get(closed.conversationKey) === closed
				)
					liveByConversation.delete(closed.conversationKey);
				for (const id of turnToolIds.get(closed.turnId) ?? [])
					toolIndex.delete(id);
				turnToolIds.delete(closed.turnId);
				void closed.done.then((ok) => {
					if (ok) counters.turnsCompleted++;
					else counters.turnsFailed++;
				});
			},
		});
		lives.set(plan.turnId, live);
		if (input.convKey) liveByConversation.set(input.convKey, live);
		return live;
	}

	/** Record the started turn and open its first leg on the live query. */
	function openStartLeg(
		live: LiveQuery,
		recorder: TurnRecorder,
		row: Omit<SdkBridgeTurnInsert, "id">,
		turn: TurnRequest,
		start: StartInput,
	): Promise<Response> {
		const { plan, meta } = start;
		void recorder.insertTurn(row);
		if (turn.ignoredFields.length)
			log.info(
				`SDK bridge turn ${plan.turnId}: ignoring ${turn.ignoredFields.join(", ")}; Claude Code sets its own sampling`,
			);
		void recorder.insertLeg(meta.legId, "start", row.startedAt);
		const leg = newLeg(
			meta.legId,
			"start",
			turn.stream,
			start.signal,
			start.bumpIdleTimeout,
			(l) => live.onClientGone(l),
		);
		live.start(leg);
		return leg.response.response;
	}

	/** An admission refusal; thrown when it is capacity, which the proxy fails over on. */
	function refuseAdmission(
		rejection: AdmissionRejection,
		refuse: (error: BridgeError, reason: string) => Response,
	): Response {
		const response = refuse(rejection, rejection.reason);
		if (
			rejection.reason === "process_cap" ||
			rejection.reason === "rebuild_cap"
		)
			throw new SdkBridgeCapacityError({
				reason: rejection.reason,
				status: rejection.status,
				type: rejection.type,
				message: rejection.message,
				retryAfter: rejection.retryAfter,
			});
		return response;
	}

	async function startTurn(input: StartInput): Promise<Response> {
		assertAvailable();
		const { query: run, mcp } = await loadSdks();
		const { plan, meta } = input;
		const startedAt = now();
		const recorder = new TurnRecorder(deps.turnRepo, log, plan.turnId);
		const policy = selectSystemPromptPolicy(meta.clientHarness);
		const promptRecord: PromptRecord = { policy: policy.name, detail: null };
		const sideRequest = meta.sideRequest ?? null;
		const kind: SdkBridgeTurnKind =
			sideRequest === null ? "turn" : "side_request";
		const refuse = (error: BridgeError, reason: string) =>
			reject(
				recorder,
				meta,
				plan,
				startedAt,
				promptRecord,
				kind,
				error,
				reason,
			);
		if (sideRequest !== null && sideRequest !== SDK_BRIDGE_SIDE_REQUEST_FORK)
			return refuse(
				bridgeErrors.sideRequestUnknown(sideRequest),
				"side_request_unknown",
			);
		const body = await readBody(input.request);
		if ("error" in body) return refuse(body.error, body.error.reason);
		const parsed = parseTurnRequest(
			body.json,
			meta.reasoningEffort,
			body.bytes,
			meta.translationGaps,
			kind,
		);
		if (!parsed.ok) return refuse(parsed.error, "invalid");
		const turn = parsed.turn;

		// Tool results no parked query waits on. Ids a live query handed out in
		// an earlier round are a stale replay of that query; otherwise the query
		// is gone, and the history up to its tool calls rebuilds it.
		const resultIds = toolResultIds(turn);
		if (kind === "side_request" && resultIds.length)
			return refuse(
				bridgeErrors.invalid("A side request cannot carry tool results"),
				"invalid",
			);
		const deadContinuation = resultIds.length > 0;
		if (deadContinuation) {
			const issuer = liveIssuing(resultIds);
			if (issuer && issuer.ownerApiKeyId === meta.apiKeyId)
				return refuseContinuation(
					issuer.turnId,
					meta,
					startedAt,
					bridgeErrors.staleToolResults(),
				);
			if (!answersFinalToolCalls(normalizeHistory(turn.history), resultIds))
				return refuse(bridgeErrors.deadTurn(), "dead_turn");
		}
		const target =
			plan.candidates.find((c) => c.accountId === plan.preferredAccountId) ??
			plan.candidates[0];
		if (!target)
			return refuse(bridgeErrors.noEligibleAccount(), "no_eligible_account");
		let toolNames: ToolNames;
		try {
			toolNames = new ToolNames(turn.tools.map((t) => t.name));
		} catch (error) {
			return refuse(bridgeErrors.invalid(errorSummary(error)), "invalid");
		}

		// Before the conversation claim: a refused prompt supersedes nothing.
		const decided = policy.decide(turn.systemText, {
			model: target.upstreamModel,
			clientHarness: meta.clientHarness,
			piPromptVersion: meta.piPromptVersion,
		});
		promptRecord.detail = decided.detail;
		if (!decided.ok) return refuse(decided.error, decided.reason);
		const systemPrompt = decided.decision;
		let convKey: string | null = null;
		try {
			convKey = conversationKey({
				apiKeyId: meta.apiKeyId,
				affinityScope: meta.affinityScope,
				affinityKey: meta.affinityKey,
				firstUserDigest: firstUserDigest(turn.messages),
			});
		} catch (error) {
			// Without a key the turn is a fresh session, rebuilt from its history.
			log.warn(
				`SDK bridge turn ${plan.turnId}: no conversation key (${errorSummary(error)})`,
			);
		}
		if (kind === "side_request")
			return startSideRequest({
				start: input,
				run,
				mcp,
				turn,
				target,
				toolNames,
				systemPrompt,
				convKey,
				recorder,
				startedAt,
				promptRecord,
				refuse,
			});
		// A new turn replaces one of its conversation still waiting on tool
		// results; the old one could only ever be answered out of order now.
		// Synchronous, so a continuation for it arriving meanwhile finds it closed.
		const superseded = convKey ? liveByConversation.get(convKey) : undefined;
		if (superseded?.awaitingClient)
			superseded.teardown("superseded", bridgeErrors.superseded());
		const claim = convKey
			? await conversations.claim(convKey, timing.settleWaitMs)
			: null;

		// From the claim until the query is live, every exit gives back what it
		// took: the claim once, the token, and the new session's files. The
		// conversation's previous session is never touched.
		let claimReleased = false;
		const releaseClaim = () => {
			if (claimReleased) return;
			claimReleased = true;
			claim?.release();
		};
		const taken = launching();
		let sessionId: string | null = null;
		let live: LiveQuery;
		let history: HistoryDecision;
		try {
			if (shuttingDown) throw new SdkBridgeUnavailableError("shutting down");
			// The client may have left while the previous turn settled; spawn nothing.
			if (input.signal.aborted) {
				releaseClaim();
				return refuse(bridgeErrors.clientGone(), "client_gone");
			}
			try {
				// Always flattened (see answersFinalToolCalls).
				history = deadContinuation
					? { mode: "rebuild_flattened", reason: "dead_continuation" }
					: decideHistory(turn, claim, plan.preferredAccountId);
			} catch (error) {
				log.warn(
					`SDK bridge turn ${plan.turnId}: history not comparable (${errorSummary(error)}); flattening it`,
				);
				history = {
					mode: "rebuild_flattened",
					reason: deadContinuation ? "dead_continuation" : "unknown",
				};
			}
			const rejection = checkAdmission({
				turn,
				plan,
				limits: limits(),
				processes: lives.size,
				rebuilds: rebuildsInFlight(),
				needsRebuild: history.mode.startsWith("rebuild"),
			});
			if (rejection) {
				releaseClaim();
				return refuseAdmission(rejection, refuse);
			}

			const dirs = workDirs();
			const store = sessionStore();
			const newSessionId = randomId();
			if (!isUuid(newSessionId))
				throw new Error("randomId must produce UUIDs for session ids");
			sessionId = newSessionId;
			const normalized = normalizeHistory(turn.history);
			if (history.mode === "resume" && claim?.current) {
				if (!store.fork(claim.current.sessionId, newSessionId))
					history = { mode: rebuildMode(turn), reason: "unknown" };
			}
			if (history.mode === "rebuild_transcript")
				try {
					store.write(
						newSessionId,
						buildSyntheticTranscript(normalized, {
							sessionId: newSessionId,
							cwd: dirs.cwd,
							model: target.upstreamModel,
							// transcriptEligible admitted only this turn's own tools.
							upstreamToolName: (name) => toolNames.upstreamName(name) ?? name,
							version: CLAUDE_CODE_VERSION,
							randomId: () => crypto.randomUUID(),
							now,
						}),
					);
				} catch (error) {
					// Content nested past what serializes becomes text instead.
					if (!isNestingOverflow(error)) throw error;
					discardSession(newSessionId);
					history = { mode: "rebuild_flattened", reason: history.reason };
				}
			const lastBlocks = normalizeHistory([turn.last]).flatMap(
				(m) => m.content,
			);
			const promptContent: Block[] =
				history.mode === "rebuild_flattened"
					? [
							{
								type: "text",
								text: flattenHistory(
									normalized,
									(name) => toolNames.exposedName(name) ?? name,
								),
							},
							// Their calls are only text now, so the results are too.
							...flattenBlocks(lastBlocks),
						]
					: lastBlocks.length
						? lastBlocks
						: blocksOf(turn.last);

			live = launchQuery(taken, {
				start: input,
				run,
				mcp,
				turn,
				target,
				toolNames,
				systemPrompt,
				sessionId: newSessionId,
				historyMode: history.mode,
				promptContent,
				claim,
				convKey,
				recorder,
				startedAt,
			});
			// The query owns the claim from here.
			claimReleased = true;
		} catch (error) {
			releaseClaim();
			abandonLaunch(taken, sessionId);
			if (error instanceof SdkBridgeUnavailableError) throw error;
			if (isNestingOverflow(error))
				return refuse(bridgeErrors.tooDeep(), "invalid");
			log.warn(`SDK bridge turn ${plan.turnId}: could not start`, error);
			throw new SdkBridgeUnavailableError(
				`Claude Code could not start: ${errorSummary(error)}`,
			);
		}

		counters.turnsStarted++;
		if (history.mode === "resume") counters.resumes++;
		if (history.mode.startsWith("rebuild")) counters.rebuilds++;
		return openStartLeg(
			live,
			recorder,
			{
				kind,
				startedAt,
				historyMode: history.mode,
				systemPromptPolicy: policy.name,
				systemPromptDetail: promptRecord.detail,
				apiKeyId: meta.apiKeyId,
				apiKeyName: meta.apiKeyName,
				accountId: plan.preferredAccountId,
				model: target.upstreamModel,
				clientHarness: meta.clientHarness,
				clientUserAgent: meta.clientUserAgent,
				project: meta.project,
				conversationKeyHash: convKey,
				ccSessionId: live.sessionId,
				rebuildReason: history.reason,
				ignoredFields: turn.ignoredFields,
			},
			turn,
			input,
		);
	}

	/**
	 * A side request ({@link SDK_BRIDGE_SIDE_REQUEST_FORK}): the conversation's
	 * stored session plus one new user message, answered on a copy of that
	 * session with no tools. It takes no claim and registers nothing, so the
	 * conversation's next turn still resumes the stored session, and the copy
	 * goes when the query closes. A history the session does not match is
	 * refused, never rebuilt.
	 */
	async function startSideRequest(input: {
		start: StartInput;
		run: QueryFn;
		mcp: McpSdk;
		turn: TurnRequest;
		target: SdkBridgeRouteCandidate;
		toolNames: ToolNames;
		systemPrompt: SystemPromptDecision;
		convKey: string | null;
		recorder: TurnRecorder;
		startedAt: number;
		promptRecord: PromptRecord;
		refuse: (error: BridgeError, reason: string) => Response;
	}): Promise<Response> {
		const { turn, refuse, convKey } = input;
		const { plan, meta, signal } = input.start;
		const noSession = (why: string) =>
			refuse(bridgeErrors.sideRequestNoSession(why), "side_request_no_session");
		const mismatch = (why: string) =>
			refuse(
				bridgeErrors.sideRequestPrefixMismatch(why),
				"side_request_prefix_mismatch",
			);
		if (!convKey) return noSession("the request names no client session");
		const current = await conversations.peek(convKey, timing.settleWaitMs);
		if (!current) return noSession("no turn of it has completed");
		let tail: ApiMessage[] | null;
		try {
			tail = messagesAfter(turn.messages, current.digests);
		} catch {
			tail = null;
		}
		if (!tail) return mismatch("its history differs from the stored one");
		const [next] = tail;
		if (!next) return mismatch("nothing follows the stored history");
		if (next.role !== "user")
			return mismatch("an assistant message follows the stored history");
		if (tail.length > 1)
			return mismatch(
				`${tail.length} messages follow the stored history, not one user message`,
			);

		// From the copy until the query is live, a failed start deletes the copy.
		const taken = launching();
		let sessionId: string | null = null;
		let live: LiveQuery;
		try {
			if (shuttingDown) throw new SdkBridgeUnavailableError("shutting down");
			if (signal.aborted)
				return refuse(bridgeErrors.clientGone(), "client_gone");
			const rejection = checkAdmission({
				turn,
				plan,
				limits: limits(),
				processes: lives.size,
				rebuilds: rebuildsInFlight(),
				needsRebuild: false,
			});
			if (rejection) return refuseAdmission(rejection, refuse);
			const forkId = randomId();
			if (!isUuid(forkId))
				throw new Error("randomId must produce UUIDs for session ids");
			sessionId = forkId;
			// No await since the peek, so nothing can have discarded the session.
			if (!sessionStore().fork(current.sessionId, forkId))
				return noSession("its session files are gone");
			live = launchQuery(taken, {
				start: input.start,
				run: input.run,
				mcp: input.mcp,
				turn,
				target: input.target,
				toolNames: input.toolNames,
				systemPrompt: input.systemPrompt,
				sessionId: forkId,
				historyMode: "resume",
				promptContent: next.content,
				claim: null,
				convKey: null,
				recorder: input.recorder,
				startedAt: input.startedAt,
			});
		} catch (error) {
			abandonLaunch(taken, sessionId);
			if (error instanceof SdkBridgeUnavailableError) throw error;
			log.warn(
				`SDK bridge side request ${plan.turnId}: could not start`,
				error,
			);
			throw new SdkBridgeUnavailableError(
				`Claude Code could not start: ${errorSummary(error)}`,
			);
		}

		counters.turnsStarted++;
		counters.sideRequests++;
		return openStartLeg(
			live,
			input.recorder,
			{
				kind: "side_request",
				startedAt: input.startedAt,
				historyMode: "resume",
				systemPromptPolicy: input.promptRecord.policy,
				systemPromptDetail: input.promptRecord.detail,
				apiKeyId: meta.apiKeyId,
				apiKeyName: meta.apiKeyName,
				accountId: plan.preferredAccountId,
				model: input.target.upstreamModel,
				clientHarness: meta.clientHarness,
				clientUserAgent: meta.clientUserAgent,
				project: meta.project,
				conversationKeyHash: convKey,
				ccSessionId: live.sessionId,
				rebuildReason: null,
				ignoredFields: turn.ignoredFields,
			},
			turn,
			input.start,
		);
	}

	async function continueTurn(input: {
		turnId: string;
		request: Request;
		meta: SdkBridgeTurnMeta;
		signal: AbortSignal;
		bumpIdleTimeout?: () => void;
	}): Promise<Response> {
		const { meta } = input;
		const startedAt = now();
		const refuse = (error: BridgeError) =>
			refuseContinuation(input.turnId, meta, startedAt, error);
		try {
			if (shuttingDown) return refuse(bridgeErrors.shutdown());
			const live = lives.get(input.turnId);
			if (!live || live.closed || !live.awaitingClient)
				return refuse(bridgeErrors.deadTurn());
			if (live.ownerApiKeyId !== meta.apiKeyId)
				return refuse(bridgeErrors.otherOwner());
			const body = await readBody(input.request);
			if ("error" in body) return refuse(body.error);
			const parsed = parseTurnRequest(
				body.json,
				meta.reasoningEffort,
				body.bytes,
				meta.translationGaps,
			);
			if (!parsed.ok) return refuse(parsed.error);
			if (!parsed.turn.toolResults.length)
				return refuse(
					bridgeErrors.invalid("A continuation must carry tool_result blocks"),
				);
			// The body was read asynchronously; the query may have ended meanwhile.
			if (shuttingDown) return refuse(bridgeErrors.shutdown());
			if (live.closed || !live.awaitingClient)
				return refuse(bridgeErrors.deadTurn());
			// Parked state stays as it is unless every awaited call is answered.
			if (!live.answersAwaiting(toolResultIds(parsed.turn)))
				return refuse(bridgeErrors.staleToolResults());
			// findContinuation hands such results to a fresh turn; a caller that
			// skipped it gets the refusal, and its retry finds the turn gone.
			if (meta.model !== live.requestedModel) {
				live.teardown("superseded", bridgeErrors.superseded());
				return refuse(
					bridgeErrors.modelChanged(live.requestedModel, meta.model),
				);
			}
			counters.continuations++;
			const leg = newLeg(
				meta.legId,
				"continue",
				parsed.turn.stream,
				input.signal,
				input.bumpIdleTimeout,
				(l) => live.onClientGone(l),
			);
			live.continueWith(
				leg,
				parsed.turn.toolResults,
				parsed.turn.messages,
				blocksAlongsideResults(parsed.turn),
			);
			return leg.response.response;
		} catch (error) {
			log.error(
				`SDK bridge continuation of turn ${input.turnId} failed`,
				error,
			);
			return refuse(bridgeErrors.internal("SDK bridge turn failed"));
		}
	}

	function findContinuation(
		toolUseIds: readonly string[],
		caller: { apiKeyId: string | null; model: string },
	): { turnId: string; ownerApiKeyId: string | null } | null {
		for (const live of lives.values()) {
			if (live.closed) continue;
			const awaiting = live.awaitingToolUseIds;
			if (!toolUseIds.some((id) => awaiting.has(id))) continue;
			// The client moved to another model mid tool loop. Its query cannot
			// serve that model, so the results start a fresh turn instead;
			// stale or partial results still go on to their own refusal.
			if (
				live.ownerApiKeyId === caller.apiKeyId &&
				live.requestedModel !== caller.model &&
				live.answersAwaiting(toolUseIds)
			) {
				live.teardown("superseded", bridgeErrors.superseded());
				return null;
			}
			return { turnId: live.turnId, ownerApiKeyId: live.ownerApiKeyId };
		}
		return null;
	}

	function beginShutdown(): void {
		shuttingDown = true;
		for (const live of [...lives.values()])
			if (live.awaitingClient)
				live.teardown("shutdown", bridgeErrors.shutdown());
	}

	async function dispose(): Promise<void> {
		beginShutdown();
		const all = [...lives.values()];
		for (const live of all) live.teardown("shutdown", bridgeErrors.shutdown());
		listener.stop();
		await Promise.race([
			Promise.all(all.map((live) => live.done)),
			Bun.sleep(2_000),
		]);
		spawner.killAll("SIGKILL");
		if (generationRoot) removeTree(generationRoot);
	}

	function status(): SdkBridgeStatus {
		let parkedCount = 0;
		for (const live of lives.values()) {
			if (live.awaitingClient) parkedCount++;
			live.samplePeakRss();
		}
		return {
			availability: availability(),
			live: lives.size,
			parked: parkedCount,
			cap: limits().maxProcesses,
			counters: { ...counters, rejected: { ...counters.rejected } },
			peakRssBytes,
		};
	}

	return {
		availability,
		startTurn,
		continueTurn,
		findContinuation,
		beginShutdown,
		dispose,
		status,
	};
}
