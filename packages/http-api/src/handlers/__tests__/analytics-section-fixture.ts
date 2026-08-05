/**
 * Deterministic analytics dataset shared by the section-scoping tests and by
 * the golden-fixture generator (scripts/generate-analytics-golden.ts).
 *
 * Deliberately NOT named *.test.ts so bun's runner doesn't pick it up.
 *
 * Every timestamp is an ABSOLUTE constant anchored to FIXED_NOW, and the tests
 * freeze the clock with setSystemTime(FIXED_NOW) before calling the handler.
 * That is what makes the whole wire response — including the time-bucketed
 * series and the burn-rate averages, which read Date.now() directly — byte
 * stable, so the golden fixture can be compared field-for-field instead of
 * structurally.
 *
 * The dataset exercises EVERY query phase: named + NULL projects, a renamed and
 * a hard-deleted API key, a NULL-account row, routing/affinity rows, tool calls
 * and tool errors, context-composition columns, and speed samples spread wide
 * enough that the PERCENT_RANK medians are not degenerate.
 */
import type { Database } from "bun:sqlite";

/** Frozen wall clock for every fixture-backed test. 2026-03-15T12:00:00.000Z. */
export const FIXED_NOW = Date.UTC(2026, 2, 15, 12, 0, 0, 0);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Account ids used by the fixture (stable, so ID-based filters can target them). */
export const ACCOUNT_A = "acct-aaaa-1111";
export const ACCOUNT_B = "acct-bbbb-2222";
/** Referenced by requests but absent from `accounts` — a hard-deleted account. */
export const ACCOUNT_DELETED = "acct-cccc-3333";

/** API key ids used by the fixture. */
export const API_KEY_LIVE = "key-live-1";
export const API_KEY_RENAMED = "key-renamed-2";
/** Referenced by requests but absent from `api_keys` — a hard-deleted key. */
export const API_KEY_DELETED = "key-deleted-3";

export const PROJECT_ALPHA = "alpha";
export const PROJECT_BETA = "beta";

type RequestRow = {
	id: string;
	timestamp: number;
	accountUsed: string | null;
	model: string | null;
	success: boolean;
	statusCode: number;
	responseTimeMs: number;
	totalTokens: number;
	costUsd: number;
	billingType: "plan" | "api";
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
	outputTokensPerSecond: number | null;
	apiKeyId: string | null;
	apiKeyName: string | null;
	project: string | null;
	projectAttributionSource: string | null;
	contextSystemChars: number | null;
	contextToolsChars: number | null;
	contextMessagesChars: number | null;
	contextToolResultChars: number | null;
	contextMessageCount: number | null;
	contextLargestToolName: string | null;
	contextLargestToolChars: number | null;
};

function row(overrides: Partial<RequestRow> & { id: string }): RequestRow {
	return {
		timestamp: FIXED_NOW - HOUR,
		accountUsed: ACCOUNT_A,
		model: "claude-opus-4-8",
		success: true,
		statusCode: 200,
		responseTimeMs: 1200,
		totalTokens: 1000,
		costUsd: 0.05,
		billingType: "plan",
		inputTokens: 300,
		cacheReadInputTokens: 500,
		cacheCreationInputTokens: 100,
		outputTokens: 100,
		outputTokensPerSecond: 40,
		apiKeyId: API_KEY_LIVE,
		apiKeyName: "live-key",
		project: PROJECT_ALPHA,
		projectAttributionSource: "wd_label",
		contextSystemChars: 2000,
		contextToolsChars: 5000,
		contextMessagesChars: 20000,
		contextToolResultChars: 8000,
		contextMessageCount: 12,
		contextLargestToolName: "Read",
		contextLargestToolChars: 4000,
		...overrides,
	};
}

/**
 * The request rows. Order matters only for readability — every query sorts.
 *
 * Timestamps straddle the 7d and 30d burn-rate windows on purpose so those
 * fixed-window aggregates are exercised with rows both inside and outside.
 */
const REQUESTS: RequestRow[] = [
	// ── Recent, account A, project alpha, live key ─────────────────────────
	row({ id: "r-01", timestamp: FIXED_NOW - 1 * HOUR }),
	row({
		id: "r-02",
		timestamp: FIXED_NOW - 2 * HOUR,
		outputTokensPerSecond: 55,
		responseTimeMs: 900,
		costUsd: 0.07,
	}),
	row({
		id: "r-03",
		timestamp: FIXED_NOW - 3 * HOUR,
		outputTokensPerSecond: 25,
		responseTimeMs: 2400,
		success: false,
		statusCode: 429,
		costUsd: 0,
	}),
	// ── Account B, second model, api-billed, project beta ──────────────────
	row({
		id: "r-04",
		timestamp: FIXED_NOW - 5 * HOUR,
		accountUsed: ACCOUNT_B,
		model: "claude-sonnet-5",
		project: PROJECT_BETA,
		billingType: "api",
		costUsd: 0.02,
		outputTokensPerSecond: 90,
		responseTimeMs: 600,
		apiKeyId: API_KEY_RENAMED,
		apiKeyName: "old-name",
		contextSystemChars: 1000,
		contextToolsChars: 2500,
		contextMessagesChars: 9000,
		contextToolResultChars: 1500,
		contextMessageCount: 5,
		contextLargestToolName: "Bash",
		contextLargestToolChars: 900,
	}),
	row({
		id: "r-05",
		timestamp: FIXED_NOW - 6 * HOUR,
		accountUsed: ACCOUNT_B,
		model: "claude-sonnet-5",
		project: PROJECT_BETA,
		billingType: "api",
		costUsd: 0.03,
		outputTokensPerSecond: 70,
		responseTimeMs: 700,
		apiKeyId: API_KEY_RENAMED,
		// Recorded BEFORE the rename — the snapshot differs from the live name.
		apiKeyName: "old-name",
		success: false,
		statusCode: 500,
	}),
	// ── Hard-deleted account, hard-deleted key, no project ─────────────────
	row({
		id: "r-06",
		timestamp: FIXED_NOW - 8 * HOUR,
		accountUsed: ACCOUNT_DELETED,
		model: "gpt-5-codex",
		project: null,
		projectAttributionSource: "none",
		apiKeyId: API_KEY_DELETED,
		apiKeyName: "retired-key",
		billingType: "api",
		costUsd: 0.01,
		outputTokensPerSecond: 120,
		responseTimeMs: 450,
		contextSystemChars: null,
		contextToolsChars: null,
		contextMessagesChars: null,
		contextToolResultChars: null,
		contextMessageCount: null,
		contextLargestToolName: null,
		contextLargestToolChars: null,
	}),
	// ── SQL-NULL account: the 989-row class the old sentinel predicate could
	//    never select. No API key either.
	row({
		id: "r-07",
		timestamp: FIXED_NOW - 9 * HOUR,
		accountUsed: null,
		model: "gpt-5-codex",
		project: null,
		projectAttributionSource: "session_ambiguous",
		apiKeyId: null,
		apiKeyName: null,
		billingType: "api",
		costUsd: 0.004,
		outputTokensPerSecond: 110,
		responseTimeMs: 500,
	}),
	row({
		id: "r-08",
		timestamp: FIXED_NOW - 10 * HOUR,
		accountUsed: null,
		model: null,
		project: null,
		projectAttributionSource: "session_inherited",
		apiKeyId: null,
		apiKeyName: null,
		billingType: "api",
		costUsd: 0,
		totalTokens: 0,
		outputTokensPerSecond: null,
		responseTimeMs: 300,
	}),
	// ── Older rows: inside 7d, inside 30d, and beyond 30d ──────────────────
	row({
		id: "r-09",
		timestamp: FIXED_NOW - 3 * DAY,
		outputTokensPerSecond: 35,
		costUsd: 0.09,
	}),
	row({
		id: "r-10",
		timestamp: FIXED_NOW - 12 * DAY,
		accountUsed: ACCOUNT_B,
		model: "claude-sonnet-5",
		project: PROJECT_BETA,
		outputTokensPerSecond: 60,
		costUsd: 0.11,
	}),
	row({
		id: "r-11",
		timestamp: FIXED_NOW - 45 * DAY,
		project: PROJECT_ALPHA,
		outputTokensPerSecond: 45,
		costUsd: 0.13,
		// Written before project_attribution_source existed.
		projectAttributionSource: null,
	}),
	row({
		id: "r-12",
		timestamp: FIXED_NOW - 60 * DAY,
		accountUsed: ACCOUNT_DELETED,
		model: "claude-opus-4-8",
		project: null,
		projectAttributionSource: null,
		apiKeyId: API_KEY_DELETED,
		apiKeyName: "retired-key-older",
		outputTokensPerSecond: 15,
		costUsd: 0.02,
	}),
];

type RoutingRow = {
	requestId: string;
	strategy: string;
	decision: string;
	affinityScope: string | null;
	affinityKeyHash: string | null;
	selectedAccountId: string | null;
	failoverAttempts: number;
};

const ROUTING: RoutingRow[] = [
	{
		requestId: "r-01",
		strategy: "session",
		decision: "affinity_hit",
		affinityScope: "claude",
		affinityKeyHash: "sess-a",
		selectedAccountId: ACCOUNT_A,
		failoverAttempts: 0,
	},
	{
		requestId: "r-02",
		strategy: "session",
		decision: "affinity_hit",
		affinityScope: "claude",
		affinityKeyHash: "sess-a",
		selectedAccountId: ACCOUNT_A,
		failoverAttempts: 0,
	},
	{
		requestId: "r-03",
		strategy: "session",
		decision: "failover",
		affinityScope: "claude",
		affinityKeyHash: "sess-b",
		selectedAccountId: ACCOUNT_A,
		failoverAttempts: 2,
	},
	{
		requestId: "r-04",
		strategy: "session",
		decision: "affinity_new",
		affinityScope: "codex",
		affinityKeyHash: "sess-c",
		selectedAccountId: ACCOUNT_B,
		failoverAttempts: 0,
	},
	{
		requestId: "r-05",
		strategy: "round-robin",
		decision: "ordered",
		affinityScope: "codex",
		affinityKeyHash: "sess-c",
		selectedAccountId: ACCOUNT_B,
		failoverAttempts: 1,
	},
	{
		requestId: "r-06",
		strategy: "round-robin",
		decision: "ordered",
		affinityScope: "other",
		affinityKeyHash: "sess-d",
		selectedAccountId: null,
		failoverAttempts: 0,
	},
	{
		requestId: "r-09",
		strategy: "session",
		decision: "affinity_hit",
		affinityScope: "claude",
		affinityKeyHash: "sess-e",
		selectedAccountId: ACCOUNT_A,
		failoverAttempts: 0,
	},
	{
		requestId: "r-10",
		strategy: "session",
		decision: "affinity_hit",
		affinityScope: "codex",
		affinityKeyHash: "sess-f",
		selectedAccountId: ACCOUNT_B,
		failoverAttempts: 0,
	},
	// r-07/r-08/r-11/r-12 deliberately have NO routing row (the "untracked" class).
];

const TOOL_CALLS: Array<{
	requestId: string;
	toolName: string;
	callCount: number;
	errorCount: number;
}> = [
	{ requestId: "r-01", toolName: "Read", callCount: 5, errorCount: 1 },
	{ requestId: "r-01", toolName: "Bash", callCount: 3, errorCount: 2 },
	{ requestId: "r-02", toolName: "Read", callCount: 4, errorCount: 0 },
	{ requestId: "r-03", toolName: "Edit", callCount: 2, errorCount: 2 },
	{ requestId: "r-04", toolName: "Bash", callCount: 6, errorCount: 1 },
	{ requestId: "r-09", toolName: "Grep", callCount: 1, errorCount: 0 },
	{ requestId: "r-10", toolName: "Read", callCount: 2, errorCount: 1 },
];

const TOOL_ERRORS: Array<{
	requestId: string;
	toolName: string;
	errorText: string | null;
}> = [
	{ requestId: "r-01", toolName: "Read", errorText: "File not found" },
	{ requestId: "r-01", toolName: "Bash", errorText: "exit code 1" },
	{ requestId: "r-01", toolName: "Bash", errorText: "exit code 1" },
	{ requestId: "r-03", toolName: "Edit", errorText: "String not found" },
	{ requestId: "r-03", toolName: "Edit", errorText: null },
	{ requestId: "r-04", toolName: "Bash", errorText: "exit code 2" },
	{ requestId: "r-10", toolName: "Read", errorText: "File not found" },
];

/**
 * Seed the deterministic dataset into a schema-initialized database.
 *
 * `api_keys` gets the live and the RENAMED key (its current name differs from
 * every snapshot on the request rows), and no row at all for the deleted key.
 */
export function seedAnalyticsFixture(db: Database): void {
	db.run(
		`INSERT INTO accounts (id, name, provider, created_at) VALUES (?, ?, 'anthropic', ?)`,
		[ACCOUNT_A, "primary-account", FIXED_NOW - 90 * DAY],
	);
	db.run(
		`INSERT INTO accounts (id, name, provider, created_at) VALUES (?, ?, 'openai', ?)`,
		[ACCOUNT_B, "secondary-account", FIXED_NOW - 80 * DAY],
	);

	db.run(
		`INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at, last_used, usage_count, is_active)
		 VALUES (?, ?, ?, ?, ?, NULL, 0, 1)`,
		[API_KEY_LIVE, "live-key", "hash-live", "aaaabbbb", FIXED_NOW - 70 * DAY],
	);
	db.run(
		`INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at, last_used, usage_count, is_active)
		 VALUES (?, ?, ?, ?, ?, NULL, 0, 1)`,
		[
			API_KEY_RENAMED,
			"new-name",
			"hash-renamed",
			"ccccdddd",
			FIXED_NOW - 70 * DAY,
		],
	);

	const insertRequest = db.prepare(
		`INSERT INTO requests (
			id, timestamp, method, path, account_used, status_code, success,
			error_message, response_time_ms, failover_attempts, model,
			total_tokens, cost_usd, output_tokens_per_second, input_tokens,
			cache_read_input_tokens, cache_creation_input_tokens, output_tokens,
			billing_type, api_key_id, api_key_name, project,
			project_attribution_source, context_system_chars, context_tools_chars,
			context_messages_chars, context_tool_result_chars,
			context_message_count, context_largest_tool_name,
			context_largest_tool_chars
		) VALUES (?, ?, 'POST', '/v1/messages', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const r of REQUESTS) {
		insertRequest.run(
			r.id,
			r.timestamp,
			r.accountUsed,
			r.statusCode,
			r.success ? 1 : 0,
			r.success ? null : `error on ${r.id}`,
			r.responseTimeMs,
			r.model,
			r.totalTokens,
			r.costUsd,
			r.outputTokensPerSecond,
			r.inputTokens,
			r.cacheReadInputTokens,
			r.cacheCreationInputTokens,
			r.outputTokens,
			r.billingType,
			r.apiKeyId,
			r.apiKeyName,
			r.project,
			r.projectAttributionSource,
			r.contextSystemChars,
			r.contextToolsChars,
			r.contextMessagesChars,
			r.contextToolResultChars,
			r.contextMessageCount,
			r.contextLargestToolName,
			r.contextLargestToolChars,
		);
	}

	const requestTimestamps = new Map(REQUESTS.map((r) => [r.id, r.timestamp]));
	const insertRouting = db.prepare(
		`INSERT INTO request_routing (
			request_id, strategy, decision, affinity_scope, affinity_key_hash,
			selected_account_id, previous_account_id, candidates_count,
			failover_attempts, failover_reason, created_at
		) VALUES (?, ?, ?, ?, ?, ?, NULL, 2, ?, NULL, ?)`,
	);
	for (const r of ROUTING) {
		insertRouting.run(
			r.requestId,
			r.strategy,
			r.decision,
			r.affinityScope,
			r.affinityKeyHash,
			r.selectedAccountId,
			r.failoverAttempts,
			requestTimestamps.get(r.requestId) ?? FIXED_NOW,
		);
	}

	const insertToolCall = db.prepare(
		`INSERT INTO request_tool_calls (request_id, tool_name, call_count, error_count) VALUES (?, ?, ?, ?)`,
	);
	for (const t of TOOL_CALLS) {
		insertToolCall.run(t.requestId, t.toolName, t.callCount, t.errorCount);
	}

	const insertToolError = db.prepare(
		`INSERT INTO request_tool_errors (request_id, tool_name, error_text) VALUES (?, ?, ?)`,
	);
	for (const t of TOOL_ERRORS) {
		insertToolError.run(t.requestId, t.toolName, t.errorText);
	}
}
