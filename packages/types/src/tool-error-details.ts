export interface ToolErrorScope {
	fromMs: number | null;
	toMs: number;
	filters: {
		accounts: string[];
		accountsNone: boolean;
		models: string[];
		apiKeys: string[];
		projects: string[];
		projectsNone: boolean;
		status: "all" | "success" | "error";
	};
}
export interface ToolErrorGroup {
	/** Ephemeral selection token. Re-saving or deleting its request invalidates it. */
	sampleId: number;
	errorText: string;
	occurrences: number;
}
export interface ToolErrorSupportingRequest {
	requestId: string;
	timestamp: number;
	project: string | null;
	model: string | null;
	/** A stored row exists; decoding can still fail or retention can remove it. */
	payloadAvailable: boolean;
}
export interface ToolErrorDetailsResponse {
	scope: ToolErrorScope;
	toolName: string;
	totalCalls: number;
	totalErrors: number;
	capturedTexts: number;
	distinctGroups: number;
	groups: ToolErrorGroup[];
	offset: number;
	hasMore: boolean;
	detail: null | {
		group: ToolErrorGroup;
		distinctRequests: number;
		distinctProjects: number;
		requestsWithoutProject: number;
		knownSessions: number;
		requestsWithoutSession: number;
		firstObserved: number;
		lastObserved: number;
		projects: { project: string | null; requests: number }[];
		projectsOmitted: number;
		requests: ToolErrorSupportingRequest[];
		offset: number;
		hasMore: boolean;
	};
}
export interface ToolErrorCallExcerpt {
	toolUseId: string | null;
	messageIndex: number;
	blockIndex: number;
	input: string | null;
	result: string;
	inputTruncated: boolean;
	resultTruncated: boolean;
}
export interface ToolErrorEvidence {
	state:
		| "matched"
		| "ambiguous"
		| "no-match"
		| "unavailable"
		| "malformed"
		| "too-large";
	totalMatches: number;
	matches: ToolErrorCallExcerpt[];
	omittedMatches: number;
}
export interface ToolErrorExampleResponse extends ToolErrorEvidence {
	requestId: string;
}
