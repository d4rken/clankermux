// Claude Agent SDK bridge accounting: one `sdk_bridge_turns` row per logical
// turn (one Claude Code query) and one `sdk_bridge_turn_legs` row per outer HTTP
// request that turn spans. The inner model calls Claude Code makes are ordinary
// `requests` rows carrying `sdk_bridge_turn_id`; token and cost truth lives
// there and is summed at read time, never copied onto the turn.

export type SdkBridgeTurnStatus =
	| "running"
	| "completed"
	| "failed"
	| "aborted"
	| "timed_out"
	| "shutdown"
	| "rejected";

/** How the turn's conversation history reached Claude Code. */
export type SdkBridgeHistoryMode =
	| "fresh"
	| "resume"
	| "rebuild_transcript"
	| "rebuild_flattened";

/** `start` opens a turn; `continue` delivers tool results to a parked one. */
export type SdkBridgeLegKind = "start" | "continue";

/** Whether a failed leg had already committed its response head. */
export type SdkBridgeLegErrorPhase = "pre_head" | "mid_stream";

export interface SdkBridgeTurn {
	id: string;
	startedAt: number;
	finishedAt: number | null;
	status: SdkBridgeTurnStatus;
	httpStatus: number | null;
	errorType: string | null;
	errorMessage: string | null;
	apiKeyId: string | null;
	apiKeyName: string | null;
	/** The outer-selected official Anthropic account. Not a foreign key. */
	accountId: string | null;
	model: string | null;
	clientHarness: string | null;
	clientUserAgent: string | null;
	project: string | null;
	conversationKeyHash: string | null;
	ccSessionId: string | null;
	historyMode: SdkBridgeHistoryMode;
	rebuildReason: string | null;
	systemPromptPolicy: string;
	stopReason: string | null;
	legCount: number;
	toolRoundCount: number;
	innerCallCount: number;
	innerErrorCount: number;
	spawnMs: number | null;
	firstEventMs: number | null;
	durationMs: number | null;
	/** Cross-check values from the SDK `result` message, not accounting truth. */
	sdkNumTurns: number | null;
	sdkInputTokens: number | null;
	sdkOutputTokens: number | null;
	sdkCacheReadInputTokens: number | null;
	sdkCacheCreationInputTokens: number | null;
}

/** What is known when a turn is admitted. Counters start at zero. */
export type SdkBridgeTurnInsert = Pick<
	SdkBridgeTurn,
	"id" | "startedAt" | "historyMode" | "systemPromptPolicy"
> &
	Partial<
		Pick<
			SdkBridgeTurn,
			| "status"
			| "apiKeyId"
			| "apiKeyName"
			| "accountId"
			| "model"
			| "clientHarness"
			| "clientUserAgent"
			| "project"
			| "conversationKeyHash"
			| "ccSessionId"
			| "rebuildReason"
		>
	>;

/** Terminal facts written once the turn ends. */
export type SdkBridgeTurnFinish = Pick<SdkBridgeTurn, "finishedAt" | "status"> &
	Partial<
		Pick<
			SdkBridgeTurn,
			| "httpStatus"
			| "errorType"
			| "errorMessage"
			| "stopReason"
			| "ccSessionId"
			| "spawnMs"
			| "firstEventMs"
			| "durationMs"
			| "sdkNumTurns"
			| "sdkInputTokens"
			| "sdkOutputTokens"
			| "sdkCacheReadInputTokens"
			| "sdkCacheCreationInputTokens"
		>
	>;

/** Increments applied in one statement. Legs are counted by `insertLeg`. */
export interface SdkBridgeTurnCounterDelta {
	toolRounds?: number;
	innerCalls?: number;
	innerErrors?: number;
}

export interface SdkBridgeTurnLeg {
	/** The outer request id returned to the client as `x-clankermux-request-id`. */
	id: string;
	turnId: string;
	kind: SdkBridgeLegKind;
	startedAt: number;
	finishedAt: number | null;
	httpStatus: number | null;
	errorPhase: SdkBridgeLegErrorPhase | null;
	stopReason: string | null;
	errorType: string | null;
	errorMessage: string | null;
	/** Tool-use ids this leg handed to the client. */
	toolUseIds: string[] | null;
}

export type SdkBridgeLegInsert = Pick<
	SdkBridgeTurnLeg,
	"id" | "turnId" | "kind" | "startedAt"
>;

export type SdkBridgeLegFinish = Pick<SdkBridgeTurnLeg, "finishedAt"> &
	Partial<
		Pick<
			SdkBridgeTurnLeg,
			| "httpStatus"
			| "errorPhase"
			| "stopReason"
			| "errorType"
			| "errorMessage"
			| "toolUseIds"
		>
	>;

/**
 * Sums over the turn's inner `requests` rows that still exist. Inner rows follow
 * request retention independently of the turn, so `requestCount` below the
 * turn's `innerCallCount` means the rest were pruned (or never recorded).
 */
export interface SdkBridgeInnerSummary {
	requestCount: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	costUsd: number;
}

export interface SdkBridgeTurnDetail {
	turn: SdkBridgeTurn;
	/** Oldest first. */
	legs: SdkBridgeTurnLeg[];
	inner: SdkBridgeInnerSummary;
}
