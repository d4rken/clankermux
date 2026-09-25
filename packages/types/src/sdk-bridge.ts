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

/**
 * Why a turn could not resume its conversation's Claude Code session.
 * `dead_continuation`: the request answered tool calls of a query that no
 * longer exists, so the history up to those calls was rebuilt and the tool
 * results became the new query's prompt.
 */
export type SdkBridgeRebuildReason =
	| "continuation"
	| "compaction"
	| "edit"
	| "unknown"
	| "account_change"
	| "dead_continuation";

/** `start` opens a turn; `continue` delivers tool results to a parked one. */
export type SdkBridgeLegKind = "start" | "continue";

/** Whether a failed leg had already committed its response head. */
export type SdkBridgeLegErrorPhase = "pre_head" | "mid_stream";

/**
 * What the turn's system-prompt policy made of the client's system prompt.
 * Never the prompt's text: a refusal keeps its length and SHA-256 instead.
 */
export type SdkBridgeSystemPromptDetail =
	| {
			outcome: "forwarded";
			/** The prompt-layout version the client declared. */
			version: string;
			/** Whether pi's own harness head was taken off the front. */
			headStripped: boolean;
			/** Characters appended to Claude Code's preset. */
			forwardedLength: number;
			/** Section openers seen in the forwarded text; a diagnostic only. */
			sectionsSeen: string[];
	  }
	| {
			outcome: "refused";
			/** Null when the client declared none. */
			version: string | null;
			/** The `error.code` the client got. */
			code: string;
			reason: string;
			/** The section the reason is about, when it names one. */
			section: string | null;
			promptLength: number;
			promptSha256: string;
	  };

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
	rebuildReason: SdkBridgeRebuildReason | null;
	systemPromptPolicy: string;
	/** Null for `drop`, and for a turn refused before its policy ran. */
	systemPromptDetail: SdkBridgeSystemPromptDetail | null;
	stopReason: string | null;
	legCount: number;
	toolRoundCount: number;
	/** Inner calls whose `requests` row began. */
	innerCallCount: number;
	/**
	 * Inner calls that ended in error, and calls refused before any row
	 * existed, so it can exceed `innerCallCount`.
	 */
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
	/**
	 * Request fields the turn accepted but Claude Code cannot apply, by the
	 * Messages name (`temperature`, `top_p`). Null when there were none.
	 */
	ignoredFields: string[] | null;
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
			| "ignoredFields"
			| "systemPromptDetail"
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

/** One inner model call of a turn: a `requests` row carrying its turn id. */
export interface SdkBridgeInnerRequest {
	id: string;
	timestamp: number;
	accountId: string | null;
	/** Null when the account was deleted since. */
	accountName: string | null;
	model: string | null;
	statusCode: number | null;
	success: boolean;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadInputTokens: number | null;
	cacheCreationInputTokens: number | null;
	costUsd: number | null;
}

/** `GET /api/sdk-bridge-turns/:id`, where `:id` is a turn id or a leg id. */
export interface SdkBridgeTurnView extends SdkBridgeTurnDetail {
	/** Name of `turn.accountId`; null when unset or deleted. */
	accountName: string | null;
	/** Oldest first, capped at {@link SDK_BRIDGE_TURN_VIEW_MAX_INNER}. */
	innerRequests: SdkBridgeInnerRequest[];
	/** Inner calls the turn counted whose `requests` row no longer exists. */
	prunedInnerCalls: number;
	/** The leg the lookup matched, when `:id` was a leg id. */
	matchedLegId: string | null;
}

export const SDK_BRIDGE_TURN_VIEW_MAX_INNER = 200;
