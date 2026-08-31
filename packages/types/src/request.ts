/**
 * Which tier of project attribution produced a request's `project` value.
 * Shared by the proxy (which derives it), the database (which persists it),
 * the HTTP API and the dashboard (which surface it), so the vocabulary can
 * never drift between producer and consumers.
 *
 *  - `header`            — explicit `x-project` request header (tier 1)
 *  - `path_override`     — an operator-configured path-to-project mapping
 *  - `repo_root`         — the repository root named by the client's own
 *                          instruction files, validated against the working
 *                          directory
 *  - `wd_primary`        — "Primary working directory:" system-prompt label
 *  - `wd_plain`          — plain "Working directory:" system-prompt label
 *  - `codex_cwd`         — Codex `<cwd>…</cwd>` tag in the first user message
 *
 * The three path-derived labels above (`wd_primary`, `wd_plain`, `codex_cwd`)
 * say which SIGNAL supplied the working directory; the configured project
 * roots then decided which segment of it was the project.
 *
 *  - `session_inherited` — inherited from the session cache
 *  - `session_ambiguous` — the session seeded conflicting projects, so nothing
 *                          was inherited (project stays null)
 *  - `none`              — eligible request, no tier produced a project
 *
 * A persisted NULL means something different again: the row predates the
 * column, or the request was never eligible for attribution at all.
 */
export type ProjectAttributionSource =
	| "header"
	| "path_override"
	| "repo_root"
	| "wd_primary"
	| "wd_plain"
	| "codex_cwd"
	| "session_inherited"
	| "session_ambiguous"
	| "none";

/**
 * Per-request context composition: character counts per context-window bucket
 * (system prompt / tool definitions / messages / tool results), computed once
 * at ingest from the already-parsed /v1/messages body. Char counts are
 * proportions, not tokens. Persisted as the nullable requests.context_*
 * columns; NULL = "composition not recorded" (old rows, parse failures,
 * non-messages endpoints), while 0 is a valid recorded value.
 */
/**
 * Cache-measurement capture: prompt-cache prefix identity for one request,
 * computed at ingest by packages/proxy/src/cache-prefix-hash.ts (the layout,
 * chain design, and join semantics are documented there). Persisted as JSON in
 * the nullable requests.cache_prefix_hashes column; consumed only by offline
 * analysis.
 */
export interface CachePrefixCapture {
	/** Shape version; bumped on any change to the hash layout. */
	v: 2;
	/** Breakpoint-chain digests (16-hex each), walk order, capped at 8. */
	bp: string[];
	/** Total number of messages walked. */
	n: number;
	/** Message-chain digests at the last ≤16 message ends, oldest first. */
	tail: string[];
}

export interface ContextComposition {
	/** System prompt: string length or summed text-block lengths. */
	systemChars: number;
	/** JSON.stringify(body.tools).length; 0 when no tools are defined. */
	toolsChars: number;
	toolCount: number;
	/** Sum over all messages' content (includes toolResultChars). */
	messagesChars: number;
	messageCount: number;
	/** Subset of messagesChars contributed by tool_result blocks. */
	toolResultChars: number;
	/** Biggest single tool_result block. */
	largestToolResultChars: number;
	/** Tool name of the largest tool_result, resolved via tool_use_id. */
	largestToolName: string | null;
	/**
	 * Recognised image blocks (base64 AND url sources), including images nested
	 * in tool_result content. Estimators price these at a flat per-image token
	 * allowance instead of by payload size.
	 */
	imageCount: number;
	/**
	 * Base64 image payload chars. EXCLUDED from every char field above — a
	 * transport payload is not prompt text.
	 */
	imagePayloadChars: number;
	/**
	 * Base64 document (e.g. PDF) payload chars. EXCLUDED from every char field
	 * above; the gate adds them back at chars/N, so only their attribution
	 * changes.
	 */
	documentPayloadChars: number;
}

/**
 * Per-request tool-call stats mined from the FINAL message of the parsed
 * /v1/messages body: each tool_result block counts as one call for the tool
 * resolved via its tool_use_id (tool_use blocks anywhere in the history);
 * blocks with `is_error: true` (strict boolean) additionally count as errors
 * and contribute a truncated error-text sample. Stats travel as
 * `ToolCallStat[] | null` (one entry per distinct toolName, insertion order);
 * null means the final message contained no tool_result blocks.
 */
export interface ToolCallStat {
	/** Resolved via tool_use_id → tool_use.name; "unknown" if unresolvable. */
	toolName: string;
	/** tool_result blocks for this tool in the FINAL message. */
	callCount: number;
	/** Subset with is_error === true (strict). */
	errorCount: number;
	/** Up to MAX_ERROR_SAMPLES truncated error texts (errors only). */
	errorSamples: string[];
}

// Database row type
export interface RequestRow {
	id: string;
	timestamp: number;
	method: string;
	path: string;
	account_used: string | null;
	status_code: number | null;
	success: boolean | number;
	error_message: string | null;
	response_time_ms: number | null;
	failover_attempts: number;
	model: string | null;
	requested_model: string | null;
	prompt_tokens: number | null;
	completion_tokens: number | null;
	total_tokens: number | null;
	cost_usd: number | null;
	input_tokens: number | null;
	cache_read_input_tokens: number | null;
	cache_creation_input_tokens: number | null;
	output_tokens: number | null;
	output_tokens_per_second: number | null;
	// 1 when output_tokens_per_second came from the implausible-streaming-window
	// → total-request-duration fallback, NULL otherwise.
	output_tokens_per_second_approx: number | null;
	api_key_id: string | null;
	api_key_name: string | null;
	project: string | null;
	// Which tier produced `project` (ProjectAttributionSource). NULL = the row
	// predates the column, or the request was never eligible for attribution.
	project_attribution_source: string | null;
	billing_type: string | null;
	combo_name: string | null;
	// Per-request reasoning effort: "thinking:<budget>"/"thinking" (Anthropic)
	// or the raw reasoning.effort string (OpenAI Responses), NULL when absent.
	reasoning_effort: string | null;
	/**
	 * When a persistable token vector first became known for this request, ms
	 * epoch. Distinct from `timestamp`, which is stamped at PERSISTENCE time
	 * (after the async writer drains) — anything correlating token spend against
	 * a rate-limit clock is skewed by that unknown lag without this column.
	 * NULL = no usable usage ever arrived (waived, or a summary with no model),
	 * or the row predates the column.
	 */
	usage_finalized_at: number | null;
}

// Domain model
export interface Request {
	id: string;
	timestamp: number;
	method: string;
	path: string;
	accountUsed: string | null;
	statusCode: number | null;
	success: boolean;
	errorMessage: string | null;
	responseTimeMs: number | null;
	failoverAttempts: number;
	model?: string;
	/** Model named by the request, available even when no provider response arrived. */
	requestedModel?: string;
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
	costUsd?: number;
	inputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	outputTokens?: number;
	tokensPerSecond?: number;
	tokensPerSecondApproximate?: boolean;
	apiKeyId?: string;
	apiKeyName?: string;
	project?: string;
	projectAttributionSource?: ProjectAttributionSource;
	billingType?: string;
	comboName?: string;
	reasoningEffort?: string;
	/**
	 * Ms epoch at which a persistable token vector first became known. Absent
	 * when none ever did, or when the row predates the column.
	 */
	usageFinalizedAt?: number;
}

// API response type
export interface RequestResponse {
	id: string;
	timestamp: string;
	method: string;
	path: string;
	accountUsed: string | null;
	statusCode: number | null;
	success: boolean;
	errorMessage: string | null;
	responseTimeMs: number | null;
	failoverAttempts: number;
	model?: string;
	/** Model named by the request, available even when no provider response arrived. */
	requestedModel?: string;
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
	inputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	outputTokens?: number;
	costUsd?: number;
	tokensPerSecond?: number;
	// True when tokensPerSecond is the total-duration fallback (rendered with a
	// "~" prefix in the dashboard). Only meaningful when tokensPerSecond is set.
	tokensPerSecondApproximate?: boolean;
	apiKeyId?: string;
	apiKeyName?: string;
	project?: string;
	/**
	 * Which tier produced `project`. Absent when unknown (pre-column rows) or
	 * when the request was never eligible; `"none"` means the request WAS
	 * eligible and no tier fired.
	 */
	projectAttributionSource?: ProjectAttributionSource;
	billingType?: string;
	comboName?: string;
	// Per-request reasoning effort: "thinking:<budget>"/"thinking" (Anthropic)
	// or the raw reasoning.effort string (OpenAI Responses).
	reasoningEffort?: string;
	/**
	 * Summed base64 payload chars of the request's image/PDF attachments
	 * (`context_binary_chars`); decoded size is roughly `chars × 3/4`. Absent for
	 * attachment-free requests and for rows predating v2026.8.26.
	 */
	attachmentChars?: number;
	// Derived from statusCode === 429 server-side so the list view can render
	// the "Rate Limited" badge without lazy-loading the full payload.
	rateLimited?: boolean;
}

// Detailed request with payload
export interface RequestPayload {
	id: string;
	request: {
		headers: Record<string, string>;
		body: string | null;
		truncated?: boolean;
	};
	response: {
		status: number;
		headers: Record<string, string>;
		body: string | null;
		truncated?: boolean;
	} | null;
	error?: string;
	meta: {
		accountId?: string;
		accountName?: string;
		retry?: number;
		timestamp: number;
		success?: boolean;
		accountsAttempted?: number;
		pending?: boolean;
		path?: string;
		method?: string;
		requestBodyTruncated?: boolean;
		responseBodyTruncated?: boolean;
		limitApplied?: number;
		// True when the server (or client-side synthesis) returned this payload
		// without request/response bodies. Consumers that need bodies must
		// re-fetch via GET /api/requests/payload/:id.
		bodiesOmitted?: boolean;
		// Mirror of RequestResponse.rateLimited so the list view can render
		// the "Rate Limited" badge from a summary-only payload (no body
		// hydration required).
		rateLimited?: boolean;
		/** Provider selected for, or locally gating, this request. */
		providerName?: string;
		/** Model named by the request before any provider response was available. */
		requestedModel?: string;
		/** True when the proxy produced the terminal response without dispatching upstream. */
		synthetic?: boolean;
		/** Machine-readable origin for a locally produced terminal response. */
		failureSource?: string;
		/**
		 * Which tier produced the request's project (see
		 * ProjectAttributionSource). Absent for rows recorded before the field
		 * existed and for requests that were never eligible.
		 */
		projectAttributionSource?: ProjectAttributionSource;
	};
}

// Type mappers
export function toRequest(row: RequestRow): Request {
	return {
		id: row.id,
		timestamp: Number(row.timestamp),
		method: row.method,
		path: row.path,
		accountUsed: row.account_used,
		statusCode: row.status_code != null ? Number(row.status_code) : null,
		success: !!row.success,
		errorMessage: row.error_message,
		responseTimeMs:
			row.response_time_ms != null ? Number(row.response_time_ms) : null,
		failoverAttempts: Number(row.failover_attempts) || 0,
		model: row.model || undefined,
		requestedModel: row.requested_model || undefined,
		promptTokens:
			row.prompt_tokens != null ? Number(row.prompt_tokens) : undefined,
		completionTokens:
			row.completion_tokens != null ? Number(row.completion_tokens) : undefined,
		totalTokens:
			row.total_tokens != null ? Number(row.total_tokens) : undefined,
		costUsd: row.cost_usd != null ? Number(row.cost_usd) : undefined,
		inputTokens:
			row.input_tokens != null ? Number(row.input_tokens) : undefined,
		cacheReadInputTokens:
			row.cache_read_input_tokens != null
				? Number(row.cache_read_input_tokens)
				: undefined,
		cacheCreationInputTokens:
			row.cache_creation_input_tokens != null
				? Number(row.cache_creation_input_tokens)
				: undefined,
		outputTokens:
			row.output_tokens != null ? Number(row.output_tokens) : undefined,
		tokensPerSecond:
			row.output_tokens_per_second != null
				? Number(row.output_tokens_per_second)
				: undefined,
		tokensPerSecondApproximate: row.output_tokens_per_second_approx
			? true
			: undefined,
		apiKeyId: row.api_key_id || undefined,
		apiKeyName: row.api_key_name || undefined,
		project: row.project || undefined,
		projectAttributionSource:
			(row.project_attribution_source as ProjectAttributionSource | null) ||
			undefined,
		billingType: row.billing_type || undefined,
		comboName: row.combo_name || undefined,
		reasoningEffort: row.reasoning_effort || undefined,
		usageFinalizedAt:
			row.usage_finalized_at != null
				? Number(row.usage_finalized_at)
				: undefined,
	};
}

export function toRequestResponse(request: Request): RequestResponse {
	return {
		id: request.id,
		timestamp: new Date(request.timestamp).toISOString(),
		method: request.method,
		path: request.path,
		accountUsed: request.accountUsed,
		statusCode: request.statusCode,
		success: request.success,
		errorMessage: request.errorMessage,
		responseTimeMs: request.responseTimeMs,
		failoverAttempts: request.failoverAttempts,
		model: request.model,
		requestedModel: request.requestedModel,
		promptTokens: request.promptTokens,
		completionTokens: request.completionTokens,
		totalTokens: request.totalTokens,
		inputTokens: request.inputTokens,
		cacheReadInputTokens: request.cacheReadInputTokens,
		cacheCreationInputTokens: request.cacheCreationInputTokens,
		outputTokens: request.outputTokens,
		costUsd: request.costUsd,
		tokensPerSecond: request.tokensPerSecond,
		tokensPerSecondApproximate: request.tokensPerSecondApproximate,
		apiKeyId: request.apiKeyId,
		apiKeyName: request.apiKeyName,
		project: request.project,
		projectAttributionSource: request.projectAttributionSource,
		billingType: request.billingType,
		comboName: request.comboName,
		reasoningEffort: request.reasoningEffort,
		rateLimited: request.statusCode === 429,
	};
}

// Special account ID for requests without an account
export const NO_ACCOUNT_ID = "no_account";
