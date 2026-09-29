import type {
	SdkBridgeHistoryMode,
	SdkBridgeRebuildReason,
	SdkBridgeTurnFinish,
	SdkBridgeTurnKind,
} from "@clankermux/types";
import type { BridgeLog } from "./types";

/**
 * Which path wrote the turn's final status. `live`: the process that
 * inserted the turn. `resumed_park`: a released park's resume, which did not.
 * `park_close`: a released park closed by expiry, supersession or recovery.
 */
export type TurnLogSource = "live" | "resumed_park" | "park_close";

/** The turn as the journal names it; null where the path does not know. */
export interface TurnLogIdentity {
	kind: SdkBridgeTurnKind;
	model: string | null;
	accountId: string | null;
	clientHarness: string | null;
	historyMode: SdkBridgeHistoryMode | null;
	rebuildReason: SdkBridgeRebuildReason | null;
	systemPromptPolicy: string | null;
}

/** The row's counters, as this process wrote them. */
export interface TurnLogCounts {
	legs: number;
	toolRounds: number;
	innerCalls: number;
	innerErrors: number;
}

/** Claude Code's WebSearch calls in the turn, and the searches they ran. */
export interface TurnLogWebSearch {
	calls: number;
	requests: number;
}

/** Token counts of one model call; null where Claude Code reported none. */
export interface ModelCallUsage {
	input: number | null;
	cacheRead: number | null;
	cacheCreation: number | null;
}

const WARN_STATUSES = new Set<SdkBridgeTurnFinish["status"]>([
	"failed",
	"timed_out",
	"expired",
]);

/**
 * The journal's line for a turn whose final status was just written: one per
 * turn, whichever path wrote it. What a path does not know is left out.
 *
 * `SDK bridge turn <id> completed {"event":"sdk_bridge_turn","turnId":…,
 * "source":"live","status":"completed",…,"historyMode":"resume",…,
 * "firstCall":{"input":3,"cacheRead":41000,"cacheCreation":250}}`
 */
export function logTurnFinished(
	log: BridgeLog,
	turnId: string,
	finish: SdkBridgeTurnFinish,
	line: {
		source: TurnLogSource;
		identity: TurnLogIdentity | null;
		counts?: TurnLogCounts | null;
		firstCall?: ModelCallUsage | null;
		webSearch?: TurnLogWebSearch | null;
	},
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
	const { identity, counts } = line;
	const data: Record<string, unknown> = {
		event: "sdk_bridge_turn",
		turnId,
		source: line.source,
		kind: identity?.kind,
		status: finish.status,
		httpStatus: finish.httpStatus ?? null,
		errorType: finish.errorType ?? null,
		errorMessage: finish.errorMessage ?? null,
		stopReason: finish.stopReason,
		model: identity?.model,
		accountId: identity?.accountId,
		clientHarness: identity?.clientHarness,
		historyMode: identity?.historyMode,
		rebuildReason: identity?.rebuildReason,
		systemPromptPolicy: identity?.systemPromptPolicy,
		legs: counts?.legs,
		toolRounds: counts?.toolRounds,
		innerCalls: counts?.innerCalls,
		innerErrors: counts?.innerErrors,
		spawnMs: finish.spawnMs,
		firstEventMs: finish.firstEventMs,
		durationMs: finish.durationMs,
		sdkNumTurns: finish.sdkNumTurns,
		tokens,
		firstCall: line.firstCall ?? undefined,
		webSearchCount: line.webSearch?.calls,
		webSearchRequests: line.webSearch?.requests,
	};
	for (const key of Object.keys(data))
		if (data[key] === undefined) delete data[key];
	log[WARN_STATUSES.has(finish.status) ? "warn" : "info"](
		`SDK bridge turn ${turnId} ${finish.status}`,
		data,
	);
}
