/**
 * Per-request context composition: character counts per context-window bucket
 * (system prompt / tool definitions / messages / tool results), computed once
 * at ingest from the already-parsed /v1/messages body. Char counts are
 * proportions, not tokens. Persisted as the nullable requests.context_*
 * columns; NULL = "composition not recorded" (old rows, parse failures,
 * non-messages endpoints), while 0 is a valid recorded value.
 */
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
	billing_type: string | null;
	combo_name: string | null;
	// Per-request reasoning effort: "thinking:<budget>"/"thinking" (Anthropic)
	// or the raw reasoning.effort string (OpenAI Responses), NULL when absent.
	reasoning_effort: string | null;
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
	billingType?: string;
	comboName?: string;
	reasoningEffort?: string;
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
	billingType?: string;
	comboName?: string;
	// Per-request reasoning effort: "thinking:<budget>"/"thinking" (Anthropic)
	// or the raw reasoning.effort string (OpenAI Responses).
	reasoningEffort?: string;
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
		billingType: row.billing_type || undefined,
		comboName: row.combo_name || undefined,
		reasoningEffort: row.reasoning_effort || undefined,
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
		billingType: request.billingType,
		comboName: request.comboName,
		reasoningEffort: request.reasoningEffort,
		rateLimited: request.statusCode === 429,
	};
}

// Special account ID for requests without an account
export const NO_ACCOUNT_ID = "no_account";
