import { mkdirSync } from "node:fs";
import { Logger } from "@clankermux/logger";
import {
	type SdkBridgeAvailability,
	type SdkBridgeCounters,
	type SdkBridgeHistoryMode,
	type SdkBridgeInnerContext,
	type SdkBridgeRoutePlan,
	type SdkBridgeStatus,
	type SdkBridgeTransport,
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
	buildSyntheticTranscript,
	classifyRebuild,
	firstUserDigest,
	flattenHistory,
	messageDigests,
	normalizeHistory,
	type RebuildReason,
	sameDigests,
	transcriptEligible,
} from "./history";
import { InnerListener } from "./inner-listener";
import { type Leg, LiveQuery } from "./live-query";
import { buildQueryOptions, workPaths } from "./options";
import { PromptStream } from "./prompt-stream";
import { TurnRecorder } from "./recorder";
import { ReplyComposer } from "./reply-composer";
import { FileSessionStore } from "./session-store";
import {
	ProcessGroupSpawner,
	readPeakRssBytes,
	resolveClaudeExecutable,
} from "./spawn";
import { LegResponse } from "./sse";
import { getSystemPromptPolicy } from "./system-prompt-policy";
import {
	createToolServer,
	loadMcpSdk,
	MCP_TOOL_PREFIX,
	type McpSdk,
	ParkedCalls,
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

/** Claude Code version the bundled binary reports; written into rebuilt transcripts. */
const CLAUDE_CODE_VERSION = "2.1.280";
const SYSTEM_PROMPT_POLICY = "drop";

export type { SdkBridgeCounters, SdkBridgeStatus };

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
	const paths = workPaths(deps.workRoot);

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
	const sessionStore = (): FileSessionStore => {
		if (!workDirsReady) {
			for (const dir of Object.values(paths))
				mkdirSync(dir, { recursive: true });
			workDirsReady = true;
		}
		store ??= new FileSessionStore(paths.sessions);
		return store;
	};
	const discardSession = (sessionId: string) => store?.remove(sessionId);

	const lives = new Map<string, LiveQuery>();
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
	};
	let peakRssBytes: number | null = null;
	const notePeakRss = (bytes: number) => {
		peakRssBytes = Math.max(peakRssBytes ?? 0, bytes);
	};

	const listener = new InnerListener({
		dispatchInner: deps.dispatchInner,
		log,
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
		error: BridgeError,
		reason: string,
	): Response {
		counters.rejected[reason] = (counters.rejected[reason] ?? 0) + 1;
		void recorder.insertTurn({
			startedAt,
			status: "rejected",
			historyMode: "fresh",
			systemPromptPolicy: SYSTEM_PROMPT_POLICY,
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
		const tools = new Set(turn.tools.map((t) => t.name));
		return {
			mode: transcriptEligible(normalized, tools)
				? "rebuild_transcript"
				: "rebuild_flattened",
			reason,
		};
	}

	function rebuildsInFlight(): number {
		let n = 0;
		for (const live of lives.values())
			if (live.historyMode.startsWith("rebuild") && !live.sawFirstEvent) n++;
		return n;
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

	async function startTurn(input: {
		request: Request;
		plan: SdkBridgeRoutePlan;
		meta: SdkBridgeTurnMeta;
		signal: AbortSignal;
		bumpIdleTimeout?: () => void;
	}): Promise<Response> {
		assertAvailable();
		const { query: run, mcp } = await loadSdks();
		const { plan, meta } = input;
		const startedAt = now();
		const recorder = new TurnRecorder(deps.turnRepo, log, plan.turnId);
		const body = await readBody(input.request);
		if ("error" in body)
			return reject(
				recorder,
				meta,
				plan,
				startedAt,
				body.error,
				body.error.reason,
			);
		const parsed = parseTurnRequest(
			body.json,
			meta.reasoningEffort,
			body.bytes,
		);
		if (!parsed.ok)
			return reject(recorder, meta, plan, startedAt, parsed.error, "invalid");
		const turn = parsed.turn;
		if (turn.toolResults.length)
			return reject(
				recorder,
				meta,
				plan,
				startedAt,
				bridgeErrors.deadTurn(),
				"dead_turn",
			);
		const target =
			plan.candidates.find((c) => c.accountId === plan.preferredAccountId) ??
			plan.candidates[0];
		if (!target)
			return reject(
				recorder,
				meta,
				plan,
				startedAt,
				bridgeErrors.noEligibleAccount(),
				"no_eligible_account",
			);

		const policy = getSystemPromptPolicy(SYSTEM_PROMPT_POLICY);
		const systemPrompt = policy.decide(turn.systemText, {
			model: target.upstreamModel,
			clientHarness: meta.clientHarness,
		});
		const convKey = conversationKey({
			apiKeyId: meta.apiKeyId,
			affinityScope: meta.affinityScope,
			affinityKey: meta.affinityKey,
			firstUserDigest: firstUserDigest(turn.messages),
		});
		const claim = convKey
			? await conversations.claim(convKey, timing.settleWaitMs)
			: null;
		if (shuttingDown) {
			claim?.release();
			throw new SdkBridgeUnavailableError("shutting down");
		}
		// The client may have left while the previous turn settled; spawn nothing.
		if (input.signal.aborted) {
			claim?.release();
			return reject(
				recorder,
				meta,
				plan,
				startedAt,
				bridgeErrors.clientGone(),
				"client_gone",
			);
		}
		let history = decideHistory(turn, claim, plan.preferredAccountId);
		const rejection = checkAdmission({
			turn,
			plan,
			limits: limits(),
			processes: lives.size,
			rebuilds: rebuildsInFlight(),
			needsRebuild: history.mode.startsWith("rebuild"),
		});
		if (rejection) {
			claim?.release();
			return reject(
				recorder,
				meta,
				plan,
				startedAt,
				rejection,
				rejection.reason,
			);
		}

		const store = sessionStore();
		const sessionId = randomId();
		if (!isUuid(sessionId))
			throw new Error("randomId must produce UUIDs for session ids");
		const normalized = normalizeHistory(turn.history);
		if (history.mode === "resume" && claim?.current) {
			if (!store.fork(claim.current.sessionId, sessionId))
				history = {
					mode: transcriptEligible(
						normalized,
						new Set(turn.tools.map((t) => t.name)),
					)
						? "rebuild_transcript"
						: "rebuild_flattened",
					reason: "unknown",
				};
		}
		if (history.mode === "rebuild_transcript")
			store.write(
				sessionId,
				buildSyntheticTranscript(normalized, {
					sessionId,
					cwd: paths.cwd,
					model: target.upstreamModel,
					toolPrefix: MCP_TOOL_PREFIX,
					version: CLAUDE_CODE_VERSION,
					randomId: () => crypto.randomUUID(),
					now,
				}),
			);
		const lastBlocks = normalizeHistory([turn.last]).flatMap((m) => m.content);
		const promptContent: Block[] =
			history.mode === "rebuild_flattened"
				? [{ type: "text", text: flattenHistory(normalized) }, ...lastBlocks]
				: lastBlocks.length
					? lastBlocks
					: blocksOf(turn.last);

		let live: LiveQuery | null = null;
		const context: SdkBridgeInnerContext = {
			turnId: plan.turnId,
			plan,
			apiKeyId: meta.apiKeyId ?? plan.apiKeyId,
			apiKeyName: meta.apiKeyName ?? plan.apiKeyName,
			clientHarness: meta.clientHarness,
			project: meta.project,
			projectAttributionSource: meta.projectAttributionSource,
			deadlineAt: startedAt + limits().turnDeadlineMs,
			onInnerOutcome: (outcome) => live?.onInnerOutcome(outcome),
		};
		const registration = listener.register(context);
		const baseUrl = listener.ensureStarted();
		const parked = new ParkedCalls();
		const toolNames = turn.tools.map((t) => t.name);
		const toolServer = turn.tools.length
			? createToolServer(mcp, turn.tools, (id) =>
					live ? live.onToolCall(id) : parked.wait(id),
				)
			: null;
		const pids = new Set<number>();
		const abortController = new AbortController();
		const prompt = new PromptStream();
		prompt.push(promptContent);
		let query: ReturnType<QueryFn>;
		try {
			query = run({
				prompt,
				options: buildQueryOptions({
					paths,
					baseUrl,
					token: registration.token,
					model: target.upstreamModel,
					toolNames,
					toolServer,
					systemPrompt,
					effort: turn.effort,
					sessionId,
					resume:
						history.mode === "resume" || history.mode === "rebuild_transcript",
					sessionStore: store,
					executablePath,
					spawn: (options) =>
						spawner.spawn(options, (pid) => {
							pids.add(pid);
						}),
					stderr: (text) =>
						log.debug(`[claude ${plan.turnId}] ${text.trimEnd()}`),
					abortController,
				}),
			});
		} catch (error) {
			registration.revoke();
			claim?.release();
			store.remove(sessionId);
			throw new SdkBridgeUnavailableError(
				`Claude Code could not start: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const composer = new ReplyComposer({
			knownTools: new Set(toolNames),
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
			sessionId,
			accountId: plan.preferredAccountId,
			historyMode: history.mode,
			query,
			prompt,
			parked,
			composer,
			recorder,
			registration,
			pids,
			killProcessGroup: (pid, signal) => spawner.kill(pid, signal),
			isAlive: (pid) => spawner.isAlive(pid),
			readPeakRss: readPeakRssBytes,
			claim,
			clientMessages: turn.messages,
			timing,
			parkedTimeoutMs: current.parkedTimeoutMs,
			turnDeadlineMs: current.turnDeadlineMs,
			maxParkedCalls: current.maxParkedCallsPerTurn,
			startedAt,
			now,
			log,
			isShuttingDown: () => shuttingDown,
			discardSession,
			onPeakRss: notePeakRss,
			onClosed: (closed) => {
				lives.delete(closed.turnId);
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
		counters.turnsStarted++;
		if (history.mode === "resume") counters.resumes++;
		if (history.mode.startsWith("rebuild")) counters.rebuilds++;
		void recorder.insertTurn({
			startedAt,
			historyMode: history.mode,
			systemPromptPolicy: policy.name,
			apiKeyId: meta.apiKeyId,
			apiKeyName: meta.apiKeyName,
			accountId: plan.preferredAccountId,
			model: target.upstreamModel,
			clientHarness: meta.clientHarness,
			clientUserAgent: meta.clientUserAgent,
			project: meta.project,
			conversationKeyHash: convKey,
			ccSessionId: sessionId,
			rebuildReason: history.reason,
		});
		void recorder.insertLeg(meta.legId, "start", startedAt);
		const owner = live;
		const leg = newLeg(
			meta.legId,
			"start",
			turn.stream,
			input.signal,
			input.bumpIdleTimeout,
			(l) => owner.onClientGone(l),
		);
		live.start(leg);
		return leg.response.response;
	}

	async function continueTurn(input: {
		turnId: string;
		request: Request;
		meta: SdkBridgeTurnMeta;
		signal: AbortSignal;
		bumpIdleTimeout?: () => void;
	}): Promise<Response> {
		const { meta } = input;
		const live = lives.get(input.turnId);
		if (shuttingDown && !live)
			throw new SdkBridgeUnavailableError("shutting down");
		const recorder = new TurnRecorder(deps.turnRepo, log, input.turnId);
		const startedAt = now();
		const refuse = (error: BridgeError) => {
			void recorder.insertLeg(meta.legId, "continue", startedAt);
			void recorder.finishLeg(meta.legId, {
				finishedAt: now(),
				httpStatus: error.status,
				errorPhase: "pre_head",
				errorType: error.type,
				errorMessage: error.message,
			});
			return errorResponse(error);
		};
		if (!live || live.closed || !live.awaitingClient)
			return refuse(bridgeErrors.deadTurn());
		if (live.ownerApiKeyId !== meta.apiKeyId)
			return errorResponse({
				status: 409,
				type: "invalid_request_error",
				message:
					"These tool results answer a turn that belongs to another API key",
				retryAfter: null,
			});
		const body = await readBody(input.request);
		if ("error" in body) return refuse(body.error);
		const parsed = parseTurnRequest(
			body.json,
			meta.reasoningEffort,
			body.bytes,
		);
		if (!parsed.ok) return refuse(parsed.error);
		if (!parsed.turn.toolResults.length)
			return refuse(
				bridgeErrors.invalid("A continuation must carry tool_result blocks"),
			);
		// The body was read asynchronously; the query may have ended meanwhile.
		if (live.closed || !live.awaitingClient)
			return refuse(bridgeErrors.deadTurn());
		counters.continuations++;
		const leg = newLeg(
			meta.legId,
			"continue",
			parsed.turn.stream,
			input.signal,
			input.bumpIdleTimeout,
			(l) => live.onClientGone(l),
		);
		live.continueWith(leg, parsed.turn.toolResults, parsed.turn.messages);
		return leg.response.response;
	}

	function findContinuation(
		toolUseIds: readonly string[],
	): { turnId: string; ownerApiKeyId: string | null } | null {
		for (const id of toolUseIds) {
			const turnId = toolIndex.get(id);
			const live = turnId ? lives.get(turnId) : undefined;
			if (live && !live.closed)
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
