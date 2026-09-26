import type {
	SdkBridgeHistoryMode,
	SdkBridgeRebuildReason,
	SdkBridgeTurnStatus,
} from "@clankermux/types";

export const SDK_BRIDGE_STATUS_LABEL: Record<SdkBridgeTurnStatus, string> = {
	running: "Running",
	released: "Waiting for tool results",
	completed: "Completed",
	failed: "Failed",
	aborted: "Aborted",
	timed_out: "Timed out",
	shutdown: "Shut down",
	rejected: "Rejected",
};

export const SDK_BRIDGE_HISTORY_LABEL: Record<SdkBridgeHistoryMode, string> = {
	fresh: "Fresh session",
	resume: "Resumed session",
	rebuild_transcript: "Rebuilt from history",
	rebuild_flattened: "Rebuilt from history, flattened",
};

export const SDK_BRIDGE_REBUILD_REASON_LABEL: Record<
	SdkBridgeRebuildReason,
	string
> = {
	continuation: "continuation",
	compaction: "compaction",
	edit: "edit",
	unknown: "unknown",
	account_change: "account change",
	dead_continuation: "tool results after their query ended",
};
