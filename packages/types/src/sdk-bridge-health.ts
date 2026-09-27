import type {
	SdkBridgeHistoryMode,
	SdkBridgeInnerSummary,
	SdkBridgeRebuildReason,
	SdkBridgeTurnKind,
	SdkBridgeTurnStatus,
} from "./sdk-bridge";

/**
 * A status's place in the failure rate, failures over finished turns.
 * `excluded`: still open (running, released), ended by the client
 * (rejected, aborted, expired), or by a server shutdown; those are counted
 * on their own.
 */
export type SdkBridgeFailureRateRole = "failure" | "finished" | "excluded";

export function sdkBridgeFailureRateRole(
	status: SdkBridgeTurnStatus,
): SdkBridgeFailureRateRole {
	switch (status) {
		case "failed":
		case "timed_out":
			return "failure";
		case "completed":
			return "finished";
		case "running":
		case "released":
		case "rejected":
		case "aborted":
		case "expired":
		case "shutdown":
			return "excluded";
	}
}

/** Nearest-rank percentiles over the non-null values; null with no samples. */
export interface SdkBridgePercentiles {
	samples: number;
	p50: number | null;
	p95: number | null;
}

/**
 * One client harness's or account's share of the range. Turn counts go to
 * the turn's harness and the account routing chose for it; inner calls and
 * cost go to the turn's harness and the account that served each call, so
 * an account can have calls and no turns.
 */
export interface SdkBridgeHealthSplit {
	/** The harness, or the account id; null when the turn recorded none. */
	key: string | null;
	/** The account's name; null for a harness, or an account deleted since. */
	name: string | null;
	total: number;
	completed: number;
	/** Failed and timed out. */
	failures: number;
	/** Failures plus completed: the failure rate's denominator. */
	finished: number;
	rejected: number;
	aborted: number;
	/** Inner `requests` rows that still exist. */
	innerCalls: number;
	costUsd: number;
}

export interface SdkBridgeHealthError {
	status: SdkBridgeTurnStatus;
	errorType: string | null;
	httpStatus: number | null;
	count: number;
}

export interface SdkBridgeHealthFailure {
	id: string;
	kind: SdkBridgeTurnKind;
	status: SdkBridgeTurnStatus;
	startedAt: number;
	httpStatus: number | null;
	errorType: string | null;
	/** Truncated to {@link SDK_BRIDGE_HEALTH_MESSAGE_MAX_CHARS}. */
	errorMessage: string | null;
	clientHarness: string | null;
	model: string | null;
}

export const SDK_BRIDGE_HEALTH_RECENT_FAILURES = 20;
export const SDK_BRIDGE_HEALTH_MESSAGE_MAX_CHARS = 160;

/** `GET /api/analytics/sdk-bridge-health`: `sdk_bridge_turns` started in the range. */
export interface SdkBridgeHealthResponse {
	range: string;
	windowStartsAt: number;
	windowEndsAt: number;
	/** Every row, turns and side requests. */
	total: number;
	byStatus: Record<SdkBridgeTurnStatus, number>;
	byKind: Record<SdkBridgeTurnKind, number>;
	failureRate: {
		failures: number;
		finished: number;
		/** Null when nothing finished. */
		rate: number | null;
	};
	/** Failed, timed-out and rejected rows, biggest group first. */
	errors: SdkBridgeHealthError[];
	/** Finished turns and side requests only. */
	timings: {
		spawnMs: SdkBridgePercentiles;
		firstEventMs: SdkBridgePercentiles;
		durationMs: SdkBridgePercentiles;
	};
	/** Finished turns, side requests excluded. */
	toolRounds: SdkBridgePercentiles & { total: number };
	/** Rejected rows excluded: they never had a session. */
	byHistoryMode: Record<SdkBridgeHistoryMode, number>;
	byRebuildReason: Record<SdkBridgeRebuildReason, number>;
	/** Most rows first. */
	byHarness: SdkBridgeHealthSplit[];
	/** Most rows first. */
	byAccount: SdkBridgeHealthSplit[];
	/** Inner model calls of the range's turns. */
	inner: SdkBridgeInnerSummary;
	/** Failed, timed-out and rejected rows, newest first. */
	recentFailures: SdkBridgeHealthFailure[];
}
