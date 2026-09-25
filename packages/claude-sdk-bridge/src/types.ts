import type {
	Options,
	SDKMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
	SdkBridgeInnerContext,
	SdkBridgeLegFinish,
	SdkBridgeLegInsert,
	SdkBridgeReleasedPark,
	SdkBridgeReleasedParkInsert,
	SdkBridgeTurnCounterDelta,
	SdkBridgeTurnFinish,
	SdkBridgeTurnInsert,
} from "@clankermux/types";

/** The part of the SDK's `Query` the bridge drives. The real `query()` satisfies it. */
export interface BridgeQuery extends AsyncIterable<SDKMessage> {
	interrupt(): Promise<unknown>;
	close(): void;
}

export type QueryFn = (params: {
	prompt: AsyncIterable<SDKUserMessage>;
	options: Options;
}) => BridgeQuery;

/** The write surface of `SdkBridgeTurnRepository`. */
export interface SdkBridgeTurnRepo {
	insertTurn(turn: SdkBridgeTurnInsert): Promise<void>;
	finishTurn(id: string, finish: SdkBridgeTurnFinish): Promise<void>;
	bumpTurnCounters(id: string, delta: SdkBridgeTurnCounterDelta): Promise<void>;
	insertLeg(leg: SdkBridgeLegInsert): Promise<void>;
	finishLeg(id: string, finish: SdkBridgeLegFinish): Promise<void>;
}

/**
 * `SdkBridgeReleasedParkRepository`: released parks' durable state. Every
 * method throws on failure; a transition resolves false when the park was not
 * in the state it leaves.
 */
export interface SdkBridgeParkRepo {
	insertPreparing(park: SdkBridgeReleasedParkInsert): Promise<void>;
	list(): Promise<SdkBridgeReleasedPark[]>;
	markReleased(
		turnId: string,
		file: { sessionFile: string; fileBytes: number },
	): Promise<boolean>;
	claim(turnId: string, owner: string, at: number): Promise<boolean>;
	unclaim(turnId: string, owner: string | null): Promise<boolean>;
	markConsumed(turnId: string, owner: string): Promise<boolean>;
	delete(turnId: string): Promise<void>;
	closeTurn(turnId: string, finish: SdkBridgeTurnFinish): Promise<void>;
	closeOpenTurnsWithoutPark(
		startedBefore: number,
		finish: SdkBridgeTurnFinish,
	): Promise<number>;
}

export interface BridgeLog {
	debug(message: string, data?: unknown): void;
	info(message: string, data?: unknown): void;
	warn(message: string, data?: unknown): void;
	error(message: string, data?: unknown): void;
}

export interface SdkBridgeLimits {
	/** Claude Code processes alive at once, parked ones included. */
	maxProcesses: number;
	/**
	 * How long a parked tool call waits for the client's result, when the
	 * query is not released instead.
	 */
	parkedTimeoutMs: number;
	/**
	 * Parked this long, a query is released: its process stops and its
	 * session waits on disk for the results.
	 */
	parkReleaseMs: number;
	/** How long a released park waits for the client's results. */
	releasedParkTtlMs: number;
	/**
	 * Soft ceiling on session files on disk. Idle conversations are evicted
	 * above it; when active and released sessions alone exceed it, no new
	 * parks are released.
	 */
	sessionBytesCeiling: number;
	/** Active-time budget of one turn, all legs together; parked time is free. */
	turnDeadlineMs: number;
	maxHistoryBytes: number;
	maxTools: number;
	maxSchemaBytes: number;
	maxParkedCallsPerTurn: number;
	maxConcurrentRebuilds: number;
}

export const DEFAULT_SDK_BRIDGE_LIMITS: SdkBridgeLimits = {
	maxProcesses: 8,
	parkedTimeoutMs: 15 * 60_000,
	parkReleaseMs: 2 * 60_000,
	releasedParkTtlMs: 24 * 60 * 60_000,
	sessionBytesCeiling: 2 * 1024 * 1024 * 1024,
	turnDeadlineMs: 60 * 60_000,
	maxHistoryBytes: 64 * 1024 * 1024,
	maxTools: 1024,
	maxSchemaBytes: 8 * 1024 * 1024,
	maxParkedCallsPerTurn: 256,
	maxConcurrentRebuilds: 8,
};

/** Protocol timings. Only tests change them. */
export interface SdkBridgeTiming {
	/** How long a streaming response withholds its head waiting for output. */
	headHoldMs: number;
	/** Silence after which a committed stream gets a `ping`. */
	pingIntervalMs: number;
	/** How long a turn waits for the previous turn of its conversation. */
	settleWaitMs: number;
	/** Silence from Claude Code, while not parked, after which the query is dead. */
	idleTimeoutMs: number;
	/** How long a settled query may take to exit before it is closed. */
	exitGraceMs: number;
	/** Period of the expiry and byte-ceiling pass over session files. */
	maintenanceIntervalMs: number;
	/** How long dispose waits for releases in flight. */
	releaseDrainMs: number;
	/** First wait before retrying a failed recovery; it doubles up to 5 min. */
	recoveryRetryMs: number;
}

export const DEFAULT_SDK_BRIDGE_TIMING: SdkBridgeTiming = {
	headHoldMs: 20_000,
	pingIntervalMs: 15_000,
	settleWaitMs: 15_000,
	idleTimeoutMs: 10 * 60_000,
	exitGraceMs: 5_000,
	maintenanceIntervalMs: 60_000,
	releaseDrainMs: 15_000,
	recoveryRetryMs: 5_000,
};

export interface ClaudeSdkBridgeDeps {
	/** Defaults to a lazy import of the Agent SDK's `query`. */
	queryFn?: QueryFn;
	/** Serves one of Claude Code's model calls through the proxy. */
	dispatchInner(req: Request, ctx: SdkBridgeInnerContext): Promise<Response>;
	turnRepo: SdkBridgeTurnRepo;
	/** Without it no parked query is released; the parked timeout ends them. */
	parkRepo?: SdkBridgeParkRepo;
	limits?: () => Partial<SdkBridgeLimits>;
	timing?: Partial<SdkBridgeTiming>;
	/** Holds HOME, CLAUDE_CONFIG_DIR, TMPDIR, the cwd and session files. */
	workRoot: string;
	/** Defaults to the SDK's bundled binary for this platform. */
	claudeExecutablePath?: string | null;
	log?: BridgeLog;
	now?: () => number;
	randomId?: () => string;
}
