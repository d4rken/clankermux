import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "@clankermux/logger";
import {
	SDK_BRIDGE_HISTORY_HEADER,
	SDK_BRIDGE_SIDE_REQUEST_FORK,
	type SdkBridgeAvailability,
	SdkBridgeCapacityError,
	type SdkBridgeContinuationUnavailable,
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
	sdkBridgeHistoryHeaderValue,
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
import { answersExactly, type Leg, LiveQuery } from "./live-query";
import { buildQueryOptions, type WorkPaths, workPaths } from "./options";
import { PromptStream } from "./prompt-stream";
import { TurnRecorder } from "./recorder";
import {
	LeaseHeldElsewhere,
	type ReleasedEntry,
	ReleasedParkStore,
	type ResumeDescriptor,
	transcriptHoldsCalls,
} from "./released-parks";
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
	MAX_TOOL_RESULT_CHARS,
	type McpSdk,
	ParkedCalls,
	sideRequestToolResult,
	ToolNames,
	toMcpResult,
	toolResultChars,
} from "./tool-server";
import {
	type Block,
	blocksOf,
	parseTurnBody,
	parseTurnRequest,
	type TurnBody,
	type TurnRequest,
} from "./turn-request";
import {
	type BridgeLog,
	type ClaudeSdkBridgeDeps,
	DEFAULT_SDK_BRIDGE_LIMITS,
	DEFAULT_SDK_BRIDGE_TIMING,
	type QueryFn,
	type SdkBridgeLimits,
	type SdkBridgeTurnHistory,
} from "./types";
import {
	claimGeneration,
	ensurePrivateDir,
	ownerRunning,
	removeTree,
	sweepGenerations,
} from "./work-dirs";

/** The longest wait between two attempts at recovering released parks. */
const RECOVERY_RETRY_MAX_MS = 5 * 60_000;

const LEASE_ELSEWHERE =
	"another running process on this database owns its released parks";

/** Claude Code version the bundled binary reports; written into rebuilt transcripts. */
const CLAUDE_CODE_VERSION = "2.1.280";

export type { SdkBridgeCounters, SdkBridgeStatus };

/** The system-prompt policy a turn ran and what it made of the prompt. */
interface PromptRecord {
	policy: string;
	detail: SdkBridgeSystemPromptDetail | null;
}

export interface ClaudeSdkBridge extends SdkBridgeTransport {
	/**
	 * Resolves once released parks an earlier process left are recovered.
	 * Expose the transport only after it: a continuation arriving before
	 * would miss its park.
	 */
	ready(): Promise<void>;
	/**
	 * Refuse new turns and release parked queries (tear them down when they
	 * cannot be released), now and whenever one parks later.
	 */
	beginShutdown(): void;
	/**
	 * Wait for releases in flight, abort everything left, stop the listener
	 * and SIGKILL leftover processes.
	 */
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
	const generationId = `${now().toString(36)}-${process.pid}-${randomBytes(4).toString("hex")}`;
	const createdAt = now();
	if (!unavailableReason)
		try {
			generationRoot = claimGeneration(deps.workRoot, generationId);
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
		released: 0,
		releaseFailures: 0,
		releasesRefused: 0,
		releasedResumes: 0,
		releasedExpired: 0,
	};
	let peakRssBytes: number | null = null;
	const notePeakRss = (bytes: number) => {
		peakRssBytes = Math.max(peakRssBytes ?? 0, bytes);
	};

	// Released parks: parked queries whose process stopped, their sessions kept
	// on disk under the work root and their records in the database, so the
	// client's results resume them, across restarts too.
	let parks: ReleasedParkStore | null = null;
	/** Why parked turns are not released at all: no repository, or another holder. */
	let parksOffReason: string | null = deps.parkRepo
		? null
		: "no released-park repository";
	if (!unavailableReason && deps.parkRepo)
		try {
			parks = new ReleasedParkStore({
				workRoot: deps.workRoot,
				repo: deps.parkRepo,
				recoveryRepo: deps.parkRepo.withBusyRetryBudget?.(
					timing.recoveryBusyRetryMs,
				),
				log,
				now,
				namespace: deps.parkNamespace ?? "default",
			});
		} catch (error) {
			parksOffReason = `released parks are unusable (${errorSummary(error)})`;
			log.warn(`SDK bridge: ${parksOffReason}`);
		}
	/** The session byte ceiling is reached by sessions nothing may evict. */
	let ceilingBlocked = false;
	let sessionBytes: number | null = null;
	/** Releases in flight, by turn id; each settles once its turn is stored or ended. */
	const releases = new Map<string, Promise<void>>();
	/** Releases dispose gave up on: they must store nothing after that. */
	const abandoned = new Set<string>();
	/** Resume descriptors of live queries, by turn id. */
	const descriptors = new Map<string, ResumeDescriptor>();
	/** Live queries resumed from a released park, by turn id. */
	const resumedFrom = new Map<string, ReleasedEntry>();

	/** Park writes running in the background (unclaims, forgets, retries); dispose drains them. */
	const parkWork = new Set<Promise<unknown>>();
	const track = (work: Promise<unknown>): void => {
		parkWork.add(work);
		void work
			.catch(() => {})
			.finally(() => {
				parkWork.delete(work);
			});
	};

	/**
	 * Set until the released parks an earlier process left are recovered.
	 * Meanwhile the bridge is unavailable, and tool results matching no live
	 * query answer 503: a park not indexed yet would look dead and its
	 * results would start a flattened rebuild.
	 */
	let recovering: string | null = parks ? "recovering released parks" : null;
	let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
	let recoveryRun: Promise<boolean> | null = null;
	let reconcileRun: Promise<void> | null = null;

	/** One recovery attempt; false when it failed and must be retried. */
	async function recoverParks(): Promise<boolean> {
		if (!parks || !deps.parkRepo) return true;
		// The barrier goes up before anything is awaited: until the new index
		// is published (or the lease is found to be another's), results no
		// live query holds may belong to a park not indexed yet.
		recovering = "recovering released parks";
		try {
			const kept = await parks.recover({
				preparing: bridgeErrors.bridgeRestarted("while this turn was released"),
				consumed: bridgeErrors.bridgeRestarted(
					"while this turn resumed after its tool results",
				),
				unusable: bridgeErrors.releaseFailed(
					"its stored session is missing or unreadable",
				),
				expired: bridgeErrors.releasedParkExpired(limits().releasedParkTtlMs),
			});
			recovering = null;
			if (parksOffReason === LEASE_ELSEWHERE) parksOffReason = null;
			if (kept)
				log.info(
					`SDK bridge: ${kept} released park${kept === 1 ? "" : "s"} recovered`,
				);
		} catch (error) {
			recovering = null;
			if (error instanceof LeaseHeldElsewhere) {
				// Another live server on this database: its parks are its own. The
				// maintenance pass asks again, in case it goes away.
				if (parksOffReason !== LEASE_ELSEWHERE)
					log.warn(
						`SDK bridge: ${LEASE_ELSEWHERE}; parked turns will not be released`,
					);
				parksOffReason = LEASE_ELSEWHERE;
				return true;
			}
			recovering = `recovering released parks (${errorSummary(error)})`;
			log.error(`SDK bridge: ${recovering}`, error);
			return false;
		}
		try {
			const error = bridgeErrors.bridgeRestarted("while this turn ran");
			const closed = await (
				deps.parkRepo.withBusyRetryBudget?.(timing.recoveryBusyRetryMs) ??
				deps.parkRepo
			).closeOpenTurnsWithoutPark(
				createdAt,
				{
					finishedAt: now(),
					status: "failed",
					httpStatus: error.status,
					errorType: error.type,
					errorMessage: error.message,
				},
				parks.token,
				(owner) => !ownerRunning(owner),
			);
			if (closed)
				log.info(
					`SDK bridge: ${closed} turn${closed === 1 ? "" : "s"} whose process is gone closed`,
				);
		} catch (error) {
			log.warn("SDK bridge: could not close turns left open", error);
		}
		return true;
	}

	/** At most one recovery at a time. */
	function runRecovery(): Promise<boolean> {
		recoveryRun ??= recoverParks().finally(() => {
			recoveryRun = null;
		});
		return recoveryRun;
	}

	/** Retry a failed recovery, doubling the wait up to five minutes. */
	function retryRecovery(delay: number): void {
		if (shuttingDown) return;
		recoveryTimer = setTimeout(async () => {
			recoveryTimer = null;
			if (shuttingDown) return;
			if (!(await runRecovery()))
				retryRecovery(Math.min(delay * 2, RECOVERY_RETRY_MAX_MS));
		}, delay);
		recoveryTimer.unref?.();
	}

	/**
	 * Settles once the first recovery is done, or after recoveryStartupMs:
	 * startup never waits out a long database lock. A slow attempt carries on
	 * in the background, the bridge meanwhile "recovering".
	 */
	const ready: Promise<void> = (async () => {
		if (!parks) return;
		const first = runRecovery();
		const outcome = await Promise.race([
			first,
			Bun.sleep(timing.recoveryStartupMs).then(() => "slow" as const),
		]);
		if (outcome === "slow") {
			log.warn(
				"SDK bridge: released-park recovery is taking longer than startup allows; carrying on in the background",
			);
			void first.then((ok) => {
				if (!ok) retryRecovery(timing.recoveryRetryMs);
			});
		} else if (!outcome) retryRecovery(timing.recoveryRetryMs);
	})();

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
		if (recovering) return { state: "unavailable", reason: recovering };
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
		// A released park's turn is written under the lease, like its resume.
		const recorder = new TurnRecorder(
			deps.turnRepo,
			log,
			turnId,
			parks?.get(turnId) ? parks.token : undefined,
		);
		void recorder.insertLeg(meta.legId, "continue", startedAt);
		void recorder.finishLeg(meta.legId, {
			finishedAt: now(),
			httpStatus: error.status,
			errorPhase: "pre_head",
			errorType: error.type,
			errorMessage: error.message,
		});
		return errorResponse(
			error,
			historyHeaders(
				lives.get(turnId)?.turnHistory ??
					parks?.get(turnId)?.descriptor.history ??
					null,
			),
		);
	}

	async function readBody(
		request: Request,
	): Promise<
		| { bytes: number; json: unknown; raw: ArrayBuffer }
		| { error: AdmissionRejection }
	> {
		const buffer = await request.arrayBuffer();
		const size = checkBodySize(buffer.byteLength, limits());
		if (size) return { error: size };
		try {
			return {
				bytes: buffer.byteLength,
				json: JSON.parse(new TextDecoder().decode(buffer)),
				raw: buffer,
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
		// Matching history resumes even on another account; the change is still recorded.
		if (current && sameDigests(current.digests, digests))
			return {
				mode: "resume",
				reason: reason === "account_change" ? reason : null,
			};
		return { mode: rebuildMode(turn), reason };
	}

	function rebuildsInFlight(): number {
		let n = 0;
		for (const live of lives.values())
			if (live.historyMode.startsWith("rebuild") && !live.sawFirstEvent) n++;
		return n;
	}

	/** Why a parked query is not released now; null when it may be. */
	function releaseRefusal(): string | null {
		if (parksOffReason) return parksOffReason;
		if (recovering) return recovering;
		if (!parks?.usable) return "released parks are unavailable";
		if (ceilingBlocked)
			return "session files have reached sdk_bridge_session_bytes_ceiling";
		return null;
	}

	/**
	 * Release a parked query: stop its process and store its session so the
	 * client's results resume it later. One release per turn; a refused one
	 * leaves the query parked under the parked timeout, or tears it down
	 * during shutdown.
	 */
	function releaseLive(live: LiveQuery): Promise<void> {
		const running = releases.get(live.turnId);
		if (running) return running;
		if (!live.awaitingClient) return Promise.resolve();
		const refusal = releaseRefusal();
		if (refusal) {
			counters.releasesRefused++;
			log.info(`SDK bridge turn ${live.turnId}: not released (${refusal})`);
			if (shuttingDown) live.teardown("shutdown", bridgeErrors.shutdown());
			else live.keepParked();
			return Promise.resolve();
		}
		const done = storeRelease(live)
			.catch((error) => {
				log.error(`SDK bridge turn ${live.turnId}: release failed`, error);
			})
			.finally(() => releases.delete(live.turnId));
		releases.set(live.turnId, done);
		return done;
	}

	async function storeRelease(live: LiveQuery): Promise<void> {
		const descriptor = descriptors.get(live.turnId);
		const stop = await live.release();
		if (abandoned.has(live.turnId)) return;
		if (!stop.ok) {
			if (!stop.stopped) {
				counters.releasesRefused++;
				log.warn(
					`SDK bridge turn ${live.turnId}: not released (${stop.reason})`,
				);
				if (shuttingDown) live.teardown("shutdown", bridgeErrors.shutdown());
				else live.keepParked();
				return;
			}
			counters.releaseFailures++;
			live.failRelease(bridgeErrors.releaseFailed(stop.reason));
			return;
		}
		const fail = (why: string) => {
			counters.releaseFailures++;
			log.warn(`SDK bridge turn ${live.turnId}: release failed (${why})`);
			live.failRelease(bridgeErrors.releaseFailed(why));
		};
		if (!parks || !descriptor) return fail("released parks became unavailable");
		const source = sessionStore().pathOf(stop.sessionId);
		if (!transcriptHoldsCalls(source, stop.resumeAt, stop.awaitedToolUseIds))
			return fail("Claude Code's transcript does not hold the parked calls");
		try {
			// A resumed turn that parks again replaces its spent park.
			const previous = resumedFrom.get(live.turnId);
			if (previous) {
				resumedFrom.delete(live.turnId);
				await parks.forget(previous);
			}
			if (abandoned.has(live.turnId)) return;
			// From the first durable park write on, the turn is the park's: its
			// original recorder, and whatever it has queued, is fenced.
			live.fenceTurn(parks.token);
			const at = now();
			await parks.store(
				{
					turnId: live.turnId,
					ownerApiKeyId: live.ownerApiKeyId,
					conversationKeyHash: live.conversationKey,
					sessionId: stop.sessionId,
					resumeAt: stop.resumeAt,
					awaitedToolUseIds: stop.awaitedToolUseIds,
					requestedModel: live.requestedModel,
					descriptor: JSON.stringify(descriptor),
					activeMs: stop.activeMs,
					parkedSince: stop.parkedSince,
					expiresAt: at + limits().releasedParkTtlMs,
					createdAt: at,
				},
				descriptor,
				source,
				() => abandoned.has(live.turnId),
			);
		} catch (error) {
			return fail(errorSummary(error));
		}
		counters.released++;
		live.completeRelease();
	}

	/** End a released park's turn and forget it; logged, never thrown. */
	function closePark(
		entry: ReleasedEntry,
		error: BridgeError,
		status: "aborted" | "expired" | "failed",
	): Promise<void> {
		if (!parks) return Promise.resolve();
		// Refused or failed, the close is pending and the maintenance pass retries it.
		const work = parks.close(entry, error, status).then(() => {});
		track(work);
		return work;
	}

	function expirePark(entry: ReleasedEntry): Promise<void> {
		counters.releasedExpired++;
		return closePark(
			entry,
			bridgeErrors.releasedParkExpired(limits().releasedParkTtlMs),
			"expired",
		);
	}

	function sessionFileBytes(): number {
		let total = 0;
		const dir = paths?.sessions;
		if (!dir) return 0;
		let names: string[] = [];
		try {
			names = readdirSync(dir);
		} catch {
			return 0;
		}
		for (const name of names)
			try {
				total += lstatSync(join(dir, name)).size;
			} catch {}
		return total;
	}

	/**
	 * The periodic pass: expire released parks, then hold session files under
	 * the byte ceiling by evicting idle conversations, least recently used
	 * first. Live queries' sessions and unexpired released parks are never
	 * evicted; when they alone exceed the ceiling, new releases stop.
	 */
	function maintain(): void {
		if (parks)
			for (const entry of parks.all())
				if (entry.state === "released" && entry.park.expiresAt <= now())
					void expirePark(entry);
		// Writes the database has not confirmed yet, until it does.
		// One pass at a time: the next waits for the previous to finish.
		if (parks?.usable && !recoveryRun && !reconcileRun) {
			const pass = parks.reconcile().finally(() => {
				reconcileRun = null;
			});
			reconcileRun = pass;
			track(pass);
		}
		// Another server held the lease: it may have gone since.
		if (parks && parksOffReason === LEASE_ELSEWHERE && !recoveryRun)
			void runRecovery();
		const ceiling = limits().sessionBytesCeiling;
		let total = sessionFileBytes() + (parks?.totalBytes() ?? 0);
		if (total > ceiling)
			for (const idle of conversations.idleSessions()) {
				let size = 0;
				try {
					size = lstatSync(sessionStore().pathOf(idle.sessionId)).size;
				} catch {}
				if (!conversations.evict(idle.key)) continue;
				total -= size;
				if (total <= ceiling) break;
			}
		sessionBytes = total;
		const blocked = total > ceiling;
		if (blocked !== ceilingBlocked)
			if (blocked)
				log.warn(
					`SDK bridge: ${total} bytes of active and released sessions exceed the ${ceiling}-byte ceiling; parked turns are no longer released`,
				);
			else log.info("SDK bridge: session files back under the ceiling");
		ceilingBlocked = blocked;
	}
	const maintenance = paths
		? setInterval(maintain, timing.maintenanceIntervalMs)
		: null;
	maintenance?.unref?.();

	/** A live query that handed out any of `ids`, in this round or an earlier one. */
	function liveIssuing(ids: readonly string[]): LiveQuery | null {
		for (const id of ids) {
			const turnId = toolIndex.get(id);
			const live = turnId ? lives.get(turnId) : undefined;
			if (live && !live.closed) return live;
		}
		return null;
	}

	/** {@link SDK_BRIDGE_HISTORY_HEADER}, when the turn's decision is known. */
	function historyHeaders(
		history: SdkBridgeTurnHistory | null,
	): Record<string, string> {
		return history
			? {
					[SDK_BRIDGE_HISTORY_HEADER]: sdkBridgeHistoryHeaderValue(
						history.mode,
						history.reason,
					),
				}
			: {};
	}

	function newLeg(
		id: string,
		kind: Leg["kind"],
		stream: boolean,
		signal: AbortSignal,
		bumpIdleTimeout: (() => void) | undefined,
		onGone: (leg: Leg) => void,
		history: SdkBridgeTurnHistory | null,
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
			headers: historyHeaders(history),
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
			turn: TurnBody;
			target: SdkBridgeRouteCandidate;
			toolNames: ToolNames;
			systemPrompt: SystemPromptDecision;
			sessionId: string;
			historyMode: SdkBridgeHistoryMode;
			promptContent: Block[];
			/** The conversation this query holds and may register with. */
			claim: ConversationClaim | null;
			convKey: string | null;
			/** A side request: its tool calls are refused, never parked. */
			sideRequest: boolean;
			recorder: TurnRecorder;
			startedAt: number;
			/** What a release of this query stores for its resume. */
			descriptor: ResumeDescriptor;
			/** A released park this query resumes, at its calls. */
			resume?: { entry: ReleasedEntry };
		},
	): LiveQuery {
		const { plan, meta } = input.start;
		const { turn, toolNames, sideRequest } = input;
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
		const resumed = input.resume?.entry;
		const registration = listener.register(
			context,
			resumed && parks
				? {
						beforeFirstDispatch: () =>
							(parks as ReleasedParkStore).consume(resumed),
					}
				: {},
		);
		taken.registration = registration;
		const baseUrl = listener.ensureStarted();
		const parked = new ParkedCalls();
		const toolServer = turn.tools.length
			? createToolServer(input.mcp, turn.tools, toolNames, (id) =>
					sideRequest
						? Promise.resolve(sideRequestToolResult())
						: live
							? live.onToolCall(id)
							: parked.wait(id),
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
				maxTurns: sideRequest ? 1 : null,
				resume:
					input.historyMode === "resume" ||
					input.historyMode === "rebuild_transcript",
				resumeSessionAt: resumed?.park.resumeAt ?? null,
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
			forwardToolUse: !sideRequest,
		});
		const current = limits();
		live = new LiveQuery({
			turnId: plan.turnId,
			ownerApiKeyId: meta.apiKeyId,
			sessionId: input.sessionId,
			accountId: plan.preferredAccountId,
			requestedModel: meta.model,
			historyMode: input.historyMode,
			turnHistory: input.descriptor.history ?? null,
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
			priorActiveMs: resumed?.park.activeMs ?? 0,
			// Ended before its first model call, a resume leaves its park (and the
			// turn) as they were: the results can resume it again.
			// A spent active-time budget ends the turn all the same.
			keepTurnOpen: resumed
				? (status) => !resumed.consumed && status !== "timed_out"
				: undefined,
			parkReleaseMs:
				sideRequest || !deps.parkRepo ? null : current.parkReleaseMs,
			onReleaseDue: (parked) => void releaseLive(parked),
			canRelease: () => releaseRefusal() === null,
			maxParkedCalls: current.maxParkedCallsPerTurn,
			startedAt: input.startedAt,
			now,
			log,
			isShuttingDown: () => shuttingDown,
			conversationKey: input.convKey,
			sideRequest,
			discardSession,
			discardClaudeCodeTranscripts,
			onPeakRss: notePeakRss,
			onClosed: (closed) => {
				lives.delete(closed.turnId);
				descriptors.delete(closed.turnId);
				if (
					closed.conversationKey &&
					liveByConversation.get(closed.conversationKey) === closed
				)
					liveByConversation.delete(closed.conversationKey);
				for (const id of turnToolIds.get(closed.turnId) ?? [])
					toolIndex.delete(id);
				turnToolIds.delete(closed.turnId);
				// The turn lives on in its released park.
				if (closed.released) return;
				const resumed = resumedFrom.get(closed.turnId);
				if (resumed && parks) {
					resumedFrom.delete(closed.turnId);
					const store = parks;
					track(
						(async () => {
							// A consumed mark still in flight decides the park's fate.
							await resumed.consuming?.catch(() => {});
							if (resumed.consumed) {
								// Spent after all: the turn it kept open ends now.
								if (closed.keptOpen) closed.finishKeptOpenTurn();
								await store.forget(resumed);
							} else if (closed.keptOpen) await store.unclaim(resumed);
							// Its budget was spent: the turn ended, so does the park.
							else await store.forget(resumed);
						})(),
					);
				}
				void closed.done.then((ok) => {
					if (ok) counters.turnsCompleted++;
					else counters.turnsFailed++;
				});
			},
		});
		lives.set(plan.turnId, live);
		descriptors.set(plan.turnId, input.descriptor);
		if (input.convKey) liveByConversation.set(input.convKey, live);
		return live;
	}

	function describe(
		start: StartInput,
		turn: TurnBody,
		systemPrompt: SystemPromptDecision,
		startedAt: number,
		history: SdkBridgeTurnHistory,
	): ResumeDescriptor {
		return {
			v: 1,
			plan: start.plan,
			tools: turn.tools,
			systemPrompt,
			effort: turn.effort,
			maxOutputTokens: turn.maxOutputTokens,
			apiKeyName: start.meta.apiKeyName ?? start.plan.apiKeyName,
			clientHarness: start.meta.clientHarness,
			project: start.meta.project,
			projectAttributionSource: start.meta.projectAttributionSource,
			turnStartedAt: startedAt,
			history,
		};
	}

	/** Record the started turn and open its first leg on the live query. */
	function openStartLeg(
		live: LiveQuery,
		recorder: TurnRecorder,
		row: Omit<SdkBridgeTurnInsert, "id">,
		turn: TurnBody,
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
			{ mode: row.historyMode, reason: row.rebuildReason ?? null },
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
		await ready;
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
		/** What every start needs once its body is read: target, tools, prompt, conversation. */
		const prepare = (
			turn: TurnBody,
		):
			| Response
			| {
					target: SdkBridgeRouteCandidate;
					toolNames: ToolNames;
					systemPrompt: SystemPromptDecision;
					convKey: string | null;
			  } => {
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
			return {
				target,
				toolNames,
				systemPrompt: decided.decision,
				convKey,
			};
		};

		if (kind === "side_request") {
			// Its messages are compared with the stored conversation before
			// anything requires them to end in a user message.
			const parsed = parseTurnBody(
				body.json,
				meta.reasoningEffort,
				body.bytes,
				meta.translationGaps,
				"side_request",
			);
			if (!parsed.ok) return refuse(parsed.error, "invalid");
			const prepared = prepare(parsed.body);
			if (prepared instanceof Response) return prepared;
			return startSideRequest({
				start: input,
				run,
				mcp,
				turn: parsed.body,
				...prepared,
				recorder,
				startedAt,
				promptRecord,
				refuse,
			});
		}

		const parsed = parseTurnRequest(
			body.json,
			meta.reasoningEffort,
			body.bytes,
			meta.translationGaps,
		);
		if (!parsed.ok) return refuse(parsed.error, "invalid");
		const turn = parsed.turn;

		// Tool results no parked query waits on. Ids a live query handed out in
		// an earlier round are a stale replay of that query; otherwise the query
		// is gone, and the history up to its tool calls rebuilds it.
		const resultIds = toolResultIds(turn);
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
		const prepared = prepare(turn);
		if (prepared instanceof Response) return prepared;
		const { target, toolNames, systemPrompt, convKey } = prepared;
		// A new turn replaces one of its conversation still waiting on tool
		// results; the old one could only ever be answered out of order now.
		// Synchronous, so a continuation for it arriving meanwhile finds it closed.
		const superseded = convKey ? liveByConversation.get(convKey) : undefined;
		if (superseded?.awaitingClient)
			superseded.teardown("superseded", bridgeErrors.superseded());
		// Released parks of the conversation go the same way, once a release
		// still in flight has stored its park.
		if (convKey && parks) {
			if (superseded?.releasing) {
				await releases.get(superseded.turnId)?.catch(() => {});
				// A release that fell back to parked left a live query behind.
				const still = liveByConversation.get(convKey);
				if (still?.awaitingClient)
					still.teardown("superseded", bridgeErrors.superseded());
			}
			for (const entry of parks.byConversation(convKey)) {
				if (entry.state === "released")
					void closePark(entry, bridgeErrors.superseded(), "aborted");
				// Claimed and not yet launched: the resume ends it before launching.
				else if (!resumedFrom.has(entry.park.turnId)) entry.superseded = true;
			}
		}
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
			const admission = () =>
				checkAdmission({
					turn,
					plan,
					limits: limits(),
					processes: lives.size,
					rebuilds: rebuildsInFlight(),
					needsRebuild: history.mode.startsWith("rebuild"),
				});
			const rejection = admission();
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
				if (!store.fork(claim.current.sessionId, newSessionId)) {
					history = {
						mode: rebuildMode(turn),
						reason: history.reason ?? "unknown",
					};
					const rebuildRejection = admission();
					if (rebuildRejection) {
						releaseClaim();
						return refuseAdmission(rebuildRejection, refuse);
					}
				}
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
				sideRequest: false,
				recorder,
				startedAt,
				descriptor: describe(input, turn, systemPrompt, startedAt, {
					mode: history.mode,
					reason: history.reason,
				}),
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
	 * session in one model turn. It keeps the turn's tools, so the prompt's
	 * cached prefix is the conversation's, and refuses every call to them.
	 * It takes no claim and registers nothing, so the conversation's next turn
	 * still resumes the stored session, and the copy goes when the query
	 * closes. A history the session does not match is refused, never rebuilt.
	 */
	async function startSideRequest(input: {
		start: StartInput;
		run: QueryFn;
		mcp: McpSdk;
		turn: TurnBody;
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
		if (next.content.some((b) => b.type === "tool_result"))
			return refuse(
				bridgeErrors.invalid("A side request cannot carry tool results"),
				"invalid",
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
				sideRequest: true,
				recorder: input.recorder,
				startedAt: input.startedAt,
				descriptor: describe(
					input.start,
					turn,
					input.systemPrompt,
					input.startedAt,
					{ mode: "resume", reason: null },
				),
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
			await ready;
			let live = lives.get(input.turnId);
			// Results that arrive while the query is being released resume the
			// park the release stores.
			if (live?.releasing) {
				await releases.get(input.turnId)?.catch(() => {});
				live = lives.get(input.turnId);
			}
			if (!live || live.closed) {
				const entry = parks?.get(input.turnId);
				if (entry) return await continueReleased(entry, input, startedAt);
				// Not recovered yet: it may be a park that is not indexed.
				if (recovering) return refuse(bridgeErrors.recovering());
			}
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
			// Its release timer may have fired while the body arrived: once the
			// release is over, a stored park resumes with this body.
			if (live.releasing || live.released) {
				await releases.get(input.turnId)?.catch(() => {});
				const entry = parks?.get(input.turnId);
				if (entry)
					return await resumeReleased(
						entry,
						input,
						startedAt,
						body,
						parsed.turn,
					);
			}
			if (live.closed || !live.awaitingClient)
				return refuse(bridgeErrors.deadTurn());
			// Parked state stays as it is unless every awaited call is answered.
			if (!live.answersAwaiting(toolResultIds(parsed.turn)))
				return refuse(bridgeErrors.staleToolResults());
			// Claude Code would hand the model a preview of a larger result.
			// Rebuilt histories and released parks carry results as message
			// content, which it sends whole.
			for (const block of parsed.turn.toolResults) {
				const chars = toolResultChars(toMcpResult(block));
				if (chars > MAX_TOOL_RESULT_CHARS)
					return refuse(
						bridgeErrors.toolResultTooLarge(
							String(block.tool_use_id),
							chars,
							MAX_TOOL_RESULT_CHARS,
						),
					);
			}
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
				live.turnHistory,
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
	):
		| { turnId: string; ownerApiKeyId: string | null }
		| SdkBridgeContinuationUnavailable
		| null {
		for (const live of lives.values()) {
			if (live.closed) continue;
			const awaiting = live.awaitingToolUseIds;
			if (!toolUseIds.some((id) => awaiting.has(id))) continue;
			// The client moved to another model mid tool loop. Its query cannot
			// serve that model, so the results start a fresh turn instead;
			// stale or partial results still go on to their own refusal. A
			// query being released decides once its park is stored.
			if (
				!live.releasing &&
				live.ownerApiKeyId === caller.apiKeyId &&
				live.requestedModel !== caller.model &&
				live.answersAwaiting(toolUseIds)
			) {
				live.teardown("superseded", bridgeErrors.superseded());
				return null;
			}
			return { turnId: live.turnId, ownerApiKeyId: live.ownerApiKeyId };
		}
		// Not recovered yet: these may be a park's that is not indexed.
		if (recovering)
			return {
				unavailable: bridgeErrors.recovering().message,
				retryAfter: String(bridgeErrors.recovering().retryAfter),
			};
		const entry = parks?.lookup(toolUseIds);
		if (!entry) return null;
		const { park } = entry;
		if (entry.state === "released") {
			if (park.expiresAt <= now()) {
				void expirePark(entry);
				return null;
			}
			if (
				park.ownerApiKeyId === caller.apiKeyId &&
				park.requestedModel !== caller.model &&
				answersExactly(new Set(park.awaitedToolUseIds), toolUseIds)
			) {
				void closePark(entry, bridgeErrors.superseded(), "aborted");
				return null;
			}
		}
		// A claimed park stays found, so a second claimant gets its 409.
		return { turnId: park.turnId, ownerApiKeyId: park.ownerApiKeyId };
	}

	/**
	 * Resume a released park with the client's tool results: claim it, copy
	 * its session under a new id, and run Claude Code from the entry that made
	 * the calls, with the final user message as one prompt. The turn keeps
	 * its id, its frozen plan and the settings it started with. A stored
	 * session that is gone ends the park and starts a fresh turn from the
	 * client's history instead (a flattened dead continuation).
	 */
	async function continueReleased(
		entry: ReleasedEntry,
		input: Parameters<SdkBridgeTransport["continueTurn"]>[0],
		startedAt: number,
	): Promise<Response> {
		const { meta } = input;
		const refuse = (error: BridgeError) =>
			refuseContinuation(entry.park.turnId, meta, startedAt, error);
		if (entry.park.ownerApiKeyId !== meta.apiKeyId)
			return refuse(bridgeErrors.otherOwner());
		if (entry.state === "released" && entry.park.expiresAt <= now()) {
			void expirePark(entry);
			return refuse(bridgeErrors.deadTurn());
		}
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
		return resumeReleased(entry, input, startedAt, body, parsed.turn);
	}

	/**
	 * Resume a released park with the client's tool results: claim it, copy
	 * its session under a new id and run Claude Code from the entry that made
	 * the calls, with the final user message as one prompt. The turn keeps
	 * its id, its frozen plan and the settings it started with.
	 *
	 * Everything between the claim and the launch is one sequence with one
	 * rollback (conversation, copy, claim), and the last checks (shutdown,
	 * client gone, supersession, process cap) run with no await before the
	 * launch. A stored session that no longer holds the calls ends the park
	 * and starts a flattened dead continuation instead.
	 */
	async function resumeReleased(
		entry: ReleasedEntry,
		input: Parameters<SdkBridgeTransport["continueTurn"]>[0],
		startedAt: number,
		body: { raw: ArrayBuffer },
		turn: TurnRequest,
	): Promise<Response> {
		const { meta } = input;
		const turnId = entry.park.turnId;
		const refuse = (error: BridgeError) =>
			refuseContinuation(turnId, meta, startedAt, error);
		const store = parks as ReleasedParkStore;
		if (entry.park.ownerApiKeyId !== meta.apiKeyId)
			return refuse(bridgeErrors.otherOwner());
		if (shuttingDown) return refuse(bridgeErrors.shutdown());
		if (
			!answersExactly(
				new Set(entry.park.awaitedToolUseIds),
				toolResultIds(turn),
			)
		)
			return refuse(bridgeErrors.staleToolResults());
		if (meta.model !== entry.park.requestedModel) {
			if (entry.state === "released")
				void closePark(entry, bridgeErrors.superseded(), "aborted");
			return refuse(
				bridgeErrors.modelChanged(entry.park.requestedModel, meta.model),
			);
		}
		// Synchronous from the state check on: the first claimant takes it.
		if (!store.takeLocal(entry)) return refuse(bridgeErrors.staleToolResults());
		// A fast path; the launch checks the cap again after the awaits.
		if (lives.size >= limits().maxProcesses) {
			entry.state = "released";
			return refuse(bridgeErrors.processCap(limits().maxProcesses));
		}

		const descriptor = entry.descriptor;
		const convKey = entry.park.conversationKeyHash;
		const taken = launching();
		let claim: ConversationClaim | null = null;
		let sessionId: string | null = null;
		let dbClaimed = false;
		/** Give back everything the resume took; the park stays resumable. */
		const rollback = async () => {
			claim?.release();
			claim = null;
			abandonLaunch(taken, sessionId);
			// Released locally only once the database agrees; otherwise the
			// entry stays reconciling and the maintenance pass retries.
			if (dbClaimed) await store.unclaim(entry);
			else entry.state = "released";
		};
		// One recorder for the turn's writes from here, the leg's included, so
		// the leg's finish is always chained behind its insert. A park owns
		// the turn: every write carries the lease token and changes nothing
		// once the lease has moved on.
		const recorder = new TurnRecorder(deps.turnRepo, log, turnId, store.token);
		let live: LiveQuery;
		try {
			try {
				dbClaimed = await store.claim(entry);
			} catch (error) {
				// The store left it reconciling: the database is read back first.
				log.error(
					`SDK bridge turn ${turnId}: could not claim its released park`,
					error,
				);
				return refuse(bridgeErrors.parkStoreUnavailable());
			}
			if (!dbClaimed) return refuse(bridgeErrors.staleToolResults());
			claim = convKey
				? await conversations.claim(convKey, timing.settleWaitMs)
				: null;
			const { query: run, mcp } = await loadSdks();
			// No await from here to the launch.
			if (entry.superseded) {
				claim?.release();
				claim = null;
				await closePark(entry, bridgeErrors.superseded(), "aborted");
				return refuse(bridgeErrors.superseded());
			}
			if (shuttingDown) {
				await rollback();
				return refuse(bridgeErrors.shutdown());
			}
			if (input.signal.aborted) {
				await rollback();
				return refuse(bridgeErrors.clientGone());
			}
			if (lives.size >= limits().maxProcesses) {
				await rollback();
				return refuse(bridgeErrors.processCap(limits().maxProcesses));
			}
			const target =
				descriptor.plan.candidates.find(
					(c) => c.accountId === descriptor.plan.preferredAccountId,
				) ?? descriptor.plan.candidates[0];
			if (!target) throw new Error("its route plan has no candidate");
			const newSessionId = randomId();
			if (!isUuid(newSessionId))
				throw new Error("randomId must produce UUIDs for session ids");
			sessionId = newSessionId;
			if (
				!store.forkForResume(
					entry,
					sessionStore().pathOf(newSessionId),
					newSessionId,
				)
			) {
				claim?.release();
				claim = null;
				log.warn(
					`SDK bridge turn ${turnId}: its released session no longer holds the calls; rebuilding from the client's history`,
				);
				await closePark(
					entry,
					bridgeErrors.releaseFailed("its stored session is gone"),
					"failed",
				);
				return startTurn({
					request: new Request(input.request.url, {
						method: "POST",
						headers: input.request.headers,
						body: body.raw,
					}),
					plan: { ...descriptor.plan, turnId: randomId() },
					meta,
					signal: input.signal,
					bumpIdleTimeout: input.bumpIdleTimeout,
				});
			}
			live = launchQuery(taken, {
				start: {
					request: input.request,
					plan: descriptor.plan,
					meta: {
						...meta,
						apiKeyName: descriptor.apiKeyName,
						clientHarness: descriptor.clientHarness,
						project: descriptor.project,
						projectAttributionSource: descriptor.projectAttributionSource,
						model: entry.park.requestedModel,
					},
					signal: input.signal,
					bumpIdleTimeout: input.bumpIdleTimeout,
				},
				run,
				mcp,
				turn: {
					...turn,
					tools: descriptor.tools,
					effort: descriptor.effort,
					maxOutputTokens: descriptor.maxOutputTokens,
				},
				target,
				toolNames: new ToolNames(descriptor.tools.map((t) => t.name)),
				systemPrompt: descriptor.systemPrompt,
				sessionId: newSessionId,
				historyMode: "resume",
				promptContent: normalizeHistory([turn.last]).flatMap((m) => m.content),
				claim,
				convKey,
				sideRequest: false,
				recorder,
				startedAt: descriptor.turnStartedAt,
				descriptor,
				resume: { entry },
			});
		} catch (error) {
			await rollback();
			log.warn(`SDK bridge turn ${turnId}: could not resume`, error);
			return refuse({
				status: 503,
				type: "api_error",
				message: `Claude Code could not start: ${errorSummary(error)}`,
				retryAfter: "5",
			});
		}
		resumedFrom.set(turnId, entry);
		// Replays of the calls it answered are stale for the resumed query.
		const ids = turnToolIds.get(turnId) ?? [];
		for (const id of entry.park.awaitedToolUseIds) {
			toolIndex.set(id, turnId);
			ids.push(id);
		}
		turnToolIds.set(turnId, ids);
		counters.continuations++;
		counters.releasedResumes++;
		void recorder.insertLeg(meta.legId, "continue", startedAt);
		void recorder.bump({ toolRounds: 1 });
		const leg = newLeg(
			meta.legId,
			"continue",
			turn.stream,
			input.signal,
			input.bumpIdleTimeout,
			(l) => live.onClientGone(l),
			live.turnHistory,
		);
		live.start(leg);
		return leg.response.response;
	}

	function beginShutdown(): void {
		shuttingDown = true;
		// Parked queries are released, so their results resume them after the
		// restart; one that cannot be is torn down, as before.
		for (const live of [...lives.values()])
			if (live.awaitingClient) void releaseLive(live);
	}

	async function dispose(): Promise<void> {
		beginShutdown();
		if (maintenance) clearInterval(maintenance);
		if (recoveryTimer) clearTimeout(recoveryTimer);
		// Everything not being released ends now; a query being released
		// ignores the teardown.
		const all = [...lives.values()];
		for (const live of all) live.teardown("shutdown", bridgeErrors.shutdown());
		// Releases need the generation's session files and the database.
		await Promise.race([
			Promise.allSettled([...releases.values()]),
			Bun.sleep(timing.releaseDrainMs),
		]);
		// One that did not finish in time ends as failed; recovery closes
		// whatever record it left.
		for (const live of all)
			if (live.releasing) {
				abandoned.add(live.turnId);
				live.failRelease(
					bridgeErrors.releaseFailed("the bridge stopped first"),
				);
			}
		listener.stop();
		await Promise.race([
			Promise.all(all.map((live) => live.done)),
			Bun.sleep(2_000),
		]);
		spawner.killAll("SIGKILL");
		// Unclaims, forgets and retries still running, and a recovery attempt,
		// get the same drain; after the lease goes, whatever is left of them
		// changes no row.
		await Promise.race([
			Promise.allSettled([...parkWork, ...(recoveryRun ? [recoveryRun] : [])]),
			Bun.sleep(timing.releaseDrainMs),
		]);
		await parks?.dispose();
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
			releasedParks:
				parks?.all().filter((e) => e.state === "released").length ?? 0,
			sessionBytes,
			releaseBlocked: releaseRefusal(),
		};
	}

	return {
		ready: () => ready,
		availability,
		startTurn,
		continueTurn,
		findContinuation,
		beginShutdown,
		dispose,
		status,
	};
}
