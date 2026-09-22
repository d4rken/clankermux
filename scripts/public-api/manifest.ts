import {
	CLIENT_REQUEST_SCHEMA,
	CLIENT_REQUESTS_SCHEMA,
} from "../../packages/http-api/src/handlers/client/dto";
import {
	PUBLIC_ACCOUNTS_SCHEMA,
	PUBLIC_STATUS_SCHEMA,
	PUBLIC_STOPS_SCHEMA,
	PUBLIC_STREAM_SCHEMA,
} from "../../packages/http-api/src/handlers/public/dto";
import { PUBLIC_WORKLOADS_SCHEMA } from "../../packages/http-api/src/handlers/public/workloads-dto";

const publicResources = {
	status: { type: "PublicStatusDto", id: PUBLIC_STATUS_SCHEMA },
	accounts: { type: "PublicAccountsDto", id: PUBLIC_ACCOUNTS_SCHEMA },
	workloads: { type: "PublicWorkloadsDto", id: PUBLIC_WORKLOADS_SCHEMA },
	stops: { type: "PublicStopsDto", id: PUBLIC_STOPS_SCHEMA },
	stream: { type: "PublicStreamEventDto", id: PUBLIC_STREAM_SCHEMA },
} as const;

const clientResources = {
	request: { type: "ClientRequestDto", id: CLIENT_REQUEST_SCHEMA },
	requests: { type: "ClientRequestsDto", id: CLIENT_REQUESTS_SCHEMA },
} as const;

export type PublicResource = keyof typeof publicResources;
export type ClientResource = keyof typeof clientResources;
/** Every generated resource, whichever group publishes it. */
export type ApiResource = PublicResource | ClientResource;

export interface ResourceEntry {
	/** The exported DTO type name, resolved from the group's `source`. */
	type: string;
	/** The `schema` literal every payload of this resource carries. */
	id: string;
}

/**
 * One published surface: its own DTO entry file, its own output directories.
 *
 * Grouped rather than listed flat because the generator resolves types from a
 * single entry file, so a second surface cannot be generated from the first
 * one's manifest entry no matter how the output paths are arranged.
 */
export interface ResourceGroup {
	/** Entry file the generator resolves types from, relative to the repo root. */
	source: string;
	/** Repository-relative directory, trailing slash, for `<resource>.schema.json`. */
	schemaDir: string;
	/** Repository-relative directory, trailing slash, for `<resource>[.scenario].json`. */
	exampleDir: string;
	/** `$comment` on every schema this group generates. */
	comment: string;
	resources: Record<string, ResourceEntry>;
}

export const groups: Record<string, ResourceGroup> = {
	public: {
		source: "packages/http-api/src/handlers/public/dto.ts",
		schemaDir: "docs/public-api/schemas/",
		exampleDir: "docs/public-api/examples/",
		comment:
			"Generated from public DTOs. Unknown properties are accepted; producer allowlist tests enforce privacy. This is the replacement public contract.",
		resources: publicResources,
	},
	client: {
		source: "packages/http-api/src/handlers/client/dto.ts",
		schemaDir: "docs/client-api/schemas/",
		exampleDir: "docs/client-api/examples/",
		comment:
			"Generated from client API DTOs. Unknown properties are accepted. Every read on this surface is scoped to the api key that authenticated it.",
		resources: clientResources,
	},
};

const projectRootUrl = new URL("../../", import.meta.url);

export function schemaDirectory(group: ResourceGroup): URL {
	return new URL(group.schemaDir, projectRootUrl);
}

export function exampleDirectory(group: ResourceGroup): URL {
	return new URL(group.exampleDir, projectRootUrl);
}

/**
 * Resource names are unique ACROSS groups: `assertPublicSchema` is called with
 * a bare resource name from handler tests, so a name appearing in two groups
 * would silently validate against whichever group this index reached first.
 */
const index = new Map<string, { group: ResourceGroup; entry: ResourceEntry }>();
for (const group of Object.values(groups)) {
	for (const [name, entry] of Object.entries(group.resources)) {
		if (index.has(name))
			throw new Error(`Duplicate resource name across groups: ${name}`);
		index.set(name, { group, entry });
	}
}

export function findResource(resource: ApiResource): {
	group: ResourceGroup;
	entry: ResourceEntry;
} {
	const found = index.get(resource);
	if (!found) throw new Error(`Unknown resource: ${resource}`);
	return found;
}

/** Count names whose spelling does not already end in Count. */
export const countFields = new Set([
	"configured",
	"defaultRoutable",
	"paused",
	"rateLimited",
	"usageExhausted",
	"totalRequests",
	"blockedRequests",
	"failedRequests",
	"disconnectedRequests",
	"unclassifiedRequests",
	"excludedAttemptAuditRows",
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
	"modeledAccounts",
	"idleAccounts",
	"unavailableAccounts",
	"availableAccounts",
	"constrainedAccounts",
	"unknownAccounts",
	"atRiskAccounts",
	"withinBudgetAccounts",
	"unreadableAccounts",
	"unopenedAccounts",
	"learningAccounts",
	"spentAccounts",
	"failoverAttempts",
	"modelSubstitutionDiscards",
	"totalTokens",
]);
