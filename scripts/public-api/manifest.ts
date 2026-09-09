import {
	PUBLIC_ACCOUNTS_SCHEMA,
	PUBLIC_PACING_SCHEMA,
	PUBLIC_RUNWAY_SCHEMA,
	PUBLIC_STATUS_SCHEMA,
	PUBLIC_STOPS_SCHEMA,
	PUBLIC_STREAM_SCHEMA,
	PUBLIC_WORKLOAD_HEADROOM_SCHEMA,
} from "../../packages/http-api/src/handlers/public/dto";

/** Only public DTO entry points may become published contracts. */
export const resources = {
	status: { type: "PublicStatusDto", id: PUBLIC_STATUS_SCHEMA },
	accounts: { type: "PublicAccountsDto", id: PUBLIC_ACCOUNTS_SCHEMA },
	runway: { type: "PublicRunwayDto", id: PUBLIC_RUNWAY_SCHEMA },
	stops: { type: "PublicStopsDto", id: PUBLIC_STOPS_SCHEMA },
	pacing: { type: "PublicPacingDto", id: PUBLIC_PACING_SCHEMA },
	"workload-headroom": {
		type: "PublicWorkloadHeadroomDto",
		id: PUBLIC_WORKLOAD_HEADROOM_SCHEMA,
	},
	stream: { type: "PublicStreamEventDto", id: PUBLIC_STREAM_SCHEMA },
} as const;

export type PublicResource = keyof typeof resources;

/**
 * Paths through JSON objects; [] means each array item. These additions remain
 * optional for v1 consumers. Current producers must emit them (tested separately).
 */
export const compatibilityFields: Partial<Record<PublicResource, string[]>> = {
	runway: ["intervalKind"],
	"workload-headroom": [
		"intervalKind",
		// Historical addition: pre-nextReset v1 servers also remain readable.
		"rows.[].nextReset",
		"rows.[].guidanceState",
		"rows.[].nextReset.intervalKind",
		"rows.[].nextReset.headroomAbsence",
		"rows.[].nextReset.guidanceState",
	],
};

/** Count names whose spelling does not already end in Count. */
export const countFields = new Set([
	"configured",
	"defaultRoutable",
	"paused",
	"rateLimited",
	"usageExhausted",
	"totalRequests",
	"blockedRequests",
	"observedRequests",
	"zeroCandidateRequests",
	"requests",
	"count",
	"eligibleTotal",
	"willRunOut",
	"alreadySpent",
	"learning",
	"unstarted",
	"fiveHourRoom",
	"fiveHourRunningHot",
	"fiveHourWaiting",
	"fiveHourUnavailable",
	"fiveHourUnknown",
	"eligibleAccounts",
	"unreadableAccounts",
	"unopenedAccounts",
	"learningAccounts",
	"spentAccounts",
	"failoverAttempts",
	"totalTokens",
]);
