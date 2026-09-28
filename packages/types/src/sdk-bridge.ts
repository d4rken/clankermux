// Claude Agent SDK bridge accounting: one `sdk_bridge_turns` row per logical
// turn (one Claude Code query) and one `sdk_bridge_turn_legs` row per outer HTTP
// request that turn spans. The inner model calls Claude Code makes are ordinary
// `requests` rows carrying `sdk_bridge_turn_id`; token and cost truth lives
// there and is summed at read time, never copied onto the turn.

/**
 * `released`: parked on the client's tool calls with no Claude Code process;
 * its session is stored in `sdk_bridge_released_parks` until the results
 * resume it or the park expires. `expired`: a released park whose tool
 * results never came.
 */
export type SdkBridgeTurnStatus =
	| "running"
	| "released"
	| "completed"
	| "failed"
	| "aborted"
	| "timed_out"
	| "expired"
	| "shutdown"
	| "rejected";

// Key order is display order: outcomes first, open turns last.
const TURN_STATUS_SET = {
	completed: true,
	failed: true,
	timed_out: true,
	rejected: true,
	aborted: true,
	expired: true,
	shutdown: true,
	running: true,
	released: true,
} satisfies Record<SdkBridgeTurnStatus, true>;

export const SDK_BRIDGE_TURN_STATUSES = Object.keys(
	TURN_STATUS_SET,
) as SdkBridgeTurnStatus[];

export function isSdkBridgeTurnStatus(
	value: string,
): value is SdkBridgeTurnStatus {
	return Object.hasOwn(TURN_STATUS_SET, value);
}

/**
 * `side_request`: a client's auxiliary request (recap, title) run on a copy
 * of its conversation's session, which it never replaces.
 */
export type SdkBridgeTurnKind = "turn" | "side_request";

export const SDK_BRIDGE_TURN_KINDS = Object.keys({
	turn: true,
	side_request: true,
} satisfies Record<SdkBridgeTurnKind, true>) as SdkBridgeTurnKind[];

/** How the turn's conversation history reached Claude Code. */
export type SdkBridgeHistoryMode =
	| "fresh"
	| "resume"
	| "rebuild_transcript"
	| "rebuild_flattened";

export const SDK_BRIDGE_HISTORY_MODES = Object.keys({
	fresh: true,
	resume: true,
	rebuild_transcript: true,
	rebuild_flattened: true,
} satisfies Record<SdkBridgeHistoryMode, true>) as SdkBridgeHistoryMode[];

/**
 * Why a turn rebuilt its conversation's Claude Code session from the
 * client's history. `account_change` is the exception: it is recorded on a
 * resumed session whose previous turn ran on another account.
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

export const SDK_BRIDGE_REBUILD_REASONS = Object.keys({
	continuation: true,
	compaction: true,
	edit: true,
	unknown: true,
	account_change: true,
	dead_continuation: true,
} satisfies Record<SdkBridgeRebuildReason, true>) as SdkBridgeRebuildReason[];

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
	kind: SdkBridgeTurnKind;
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
			| "kind"
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
	> & {
		/** The process running the turn: pid and its /proc start time. */
		ownerPid?: number | null;
		ownerStartTime?: string | null;
	};

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
	/** The model the provider reported; null for a call with no usage. */
	model: string | null;
	/** The model the call asked for, shown when `model` is null. */
	requestedModel: string | null;
	statusCode: number | null;
	/** False for a request without an outcome too; see `errorMessage`. */
	success: boolean;
	/**
	 * The row's recorded error, which is how a request whose client left
	 * before any response started is told apart from a failure.
	 */
	errorMessage: string | null;
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

/**
 * A released park's lifecycle. `preparing`: the record exists, its session file
 * may not yet; `released`: file published, waiting for the client; `claimed`:
 * a resume holds it and has made no model call; `consumed`: the resumed query
 * made a model call, so the park can never be resumed again.
 */
export type SdkBridgeReleasedParkState =
	| "preparing"
	| "released"
	| "claimed"
	| "consumed";

/** One row of `sdk_bridge_released_parks`. */
export interface SdkBridgeReleasedPark {
	turnId: string;
	state: SdkBridgeReleasedParkState;
	ownerApiKeyId: string | null;
	conversationKeyHash: string | null;
	/** The Claude Code session id the stored transcript carries. */
	sessionId: string;
	/**
	 * Absolute path of the stored session, inside a released-parks directory
	 * of this database (any work root): recovery reads it where it is.
	 */
	sessionPath: string;
	/** Uuid of the transcript entry a resume continues from. */
	resumeAt: string;
	/** The tool_use ids the client must answer, each exactly once. */
	awaitedToolUseIds: string[];
	/** The model the client named, as it named it. */
	requestedModel: string;
	/** The bridge's immutable resume descriptor, as JSON. */
	descriptor: string;
	/** Active (not parked) time the turn has used. */
	activeMs: number;
	parkedSince: number;
	expiresAt: number;
	fileBytes: number;
	claimOwner: string | null;
	/** The current claim's generation: an unclaim names the claim it undoes. */
	claimId: string | null;
	claimedAt: number | null;
	createdAt: number;
}

export type SdkBridgeReleasedParkInsert = Omit<
	SdkBridgeReleasedPark,
	"state" | "claimOwner" | "claimId" | "claimedAt"
>;

/**
 * What closing a released park's turn did. `kept`: the turn had already
 * finished and keeps its outcome; its park is gone all the same. `refused`:
 * the token does not hold the lease, and nothing changed.
 */
export type SdkBridgeParkCloseOutcome = "closed" | "kept" | "refused";

/** The one row of `sdk_bridge_park_lease`: who may act on released parks. */
export interface SdkBridgeParkLease {
	/** The holder's released-parks directory. */
	dir: string;
	pid: number;
	startTime: string | null;
	token: string;
	at: number;
}
