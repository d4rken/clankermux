/**
 * Unified message protocol for main thread <-> worker communication
 * Handles both streaming and non-streaming responses
 */

// ===== MAIN THREAD → WORKER =====

export interface StartMessage {
	type: "start";
	messageId: string; // envelope ID for ack tracking
	requestId: string;
	accountId: string | null;
	method: string;
	path: string;
	timestamp: number;

	// Request details
	requestHeaders: Record<string, string>;
	// NOTE: requestBody is intentionally NOT carried to the worker anymore. The
	// long-lived worker is a pure usage/cost computer; the up-to-4MB request body
	// is captured + persisted by the main-thread RequestRecorder instead (Bun
	// #5709: structured-clone backing stores transferred into the worker were
	// never reclaimed). project extraction also moved to the main thread.
	project: string | null;

	// Response details
	responseStatus: number;
	responseHeaders: Record<string, string>;
	isStream: boolean;

	// Provider info for rate limit parsing
	providerName: string;

	// Account billing type override (null = use provider heuristic)
	accountBillingType: string | null;

	// Account auto-pause-on-overage flag (1 = enabled, 0 = disabled, null = not set)
	accountAutoPauseOnOverageEnabled: number | null;

	// Account name for logging
	accountName: string | null;

	// Agent info
	agentUsed: string | null;

	// Combo info
	comboName: string | null;

	// API key info
	apiKeyId: string | null;
	apiKeyName: string | null;

	// Retry info
	retryAttempt: number;
	failoverAttempts: number;

	// Routing telemetry
	routing: RequestRoutingMessage | null;
}

export interface RequestRoutingMessage {
	strategy: string;
	decision: string;
	affinityScope: import("@clankermux/types").RequestAffinityScope | null;
	affinityKeyHash: string | null;
	selectedAccountId: string | null;
	previousAccountId: string | null;
	candidatesCount: number | null;
	failoverReason: string | null;
}

export interface ChunkMessage {
	type: "chunk";
	requestId: string;
	data: Uint8Array;
}

export interface EndMessage {
	type: "end";
	requestId: string;
	responseBody?: string | null; // base64 encoded, for non-streaming
	success: boolean;
	error?: string;
}

export interface ControlMessage {
	type: "shutdown";
}

export type WorkerMessage =
	| StartMessage
	| ChunkMessage
	| EndMessage
	| ControlMessage;

// ===== WORKER → MAIN THREAD =====

/** Worker is initialized and ready to accept messages */
export interface ReadyMessage {
	type: "ready";
}

/** Worker acknowledges a StartMessage envelope */
export interface AckMessage {
	type: "ack";
	messageId: string;
}

/** Worker has flushed all pending work and is safe to terminate */
export interface ShutdownCompleteMessage {
	type: "shutdown-complete";
}

/**
 * Slim usage summary posted by the pure usage worker. The worker no longer
 * builds a full `RequestResponse` — it computes usage/cost/tokens only and
 * hands them back; the main-thread RequestRecorder merges this with its own
 * meta + billingType + outcome to build the dashboard RequestResponse and
 * persist the row. Mirrors `SlimUsageSummary` in request-recorder.ts.
 */
export interface SummaryMessage {
	type: "summary";
	summary: {
		requestId: string;
		usage: {
			model?: string;
			inputTokens?: number;
			outputTokens?: number;
			cacheReadInputTokens?: number;
			cacheCreationInputTokens?: number;
			totalTokens?: number;
			costUsd?: number;
		};
		tokensPerSecond?: number;
		responseTimeMs?: number;
		cacheCreationInputTokens?: number;
	};
}

export type OutgoingWorkerMessage =
	| ReadyMessage
	| AckMessage
	| ShutdownCompleteMessage
	| SummaryMessage;
