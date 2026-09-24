import type { TerminalReason } from "@anthropic-ai/claude-agent-sdk";
import type { SdkBridgeInnerOutcome } from "@clankermux/types";

/** An error the bridge answers the client with, as JSON or as an SSE `error`. */
export interface BridgeError {
	status: number;
	type: string;
	message: string;
	retryAfter: string | null;
	/** OpenAI-style `error.code`, for a condition clients branch on. */
	code?: string;
}

/** Retry-After for a 429/503/529 whose cause named none. */
export const DEFAULT_RETRY_AFTER_SECONDS = "30";
/** Retry-After when every Claude Code slot is taken. */
export const PROCESS_CAP_RETRY_AFTER_SECONDS = "10";

const ANTHROPIC_ERROR_TYPES = new Set([
	"invalid_request_error",
	"authentication_error",
	"billing_error",
	"permission_error",
	"not_found_error",
	"request_too_large",
	"rate_limit_error",
	"api_error",
	"timeout_error",
	"overloaded_error",
]);

// Claude Code's own wording for a credential failure. The client has no
// Anthropic credential to fix, so this text would only send it looking for one.
const CREDENTIAL_TEXT =
	/failed to authenticate|authentication_error|invalid (x-)?api[- _]?key|invalid bearer|oauth|\/login|please run|log ?in again/i;

const GENERIC_UPSTREAM_MESSAGE = "The upstream model call failed";

/**
 * An error's first line, for an availability reason. Module resolution errors
 * append a require stack of internal paths that says nothing to an operator.
 */
export function errorSummary(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.split("\n")[0]?.trim() ?? "";
}

export function sanitizeMessage(text: string | null | undefined): string {
	const trimmed = (text ?? "").trim();
	if (!trimmed || CREDENTIAL_TEXT.test(trimmed))
		return GENERIC_UPSTREAM_MESSAGE;
	return trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}…` : trimmed;
}

const PROMPT_TOO_LONG = /prompt is too long/i;
const PROMPT_TOO_LONG_COUNTS =
	/prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i;
const INPUT_LENGTH_OVERFLOW =
	/input length and `?max_tokens`? exceed context limit(?::\s*\d+\s*\+\s*\d+\s*>\s*\d+)?/i;
const OVERFLOW_TERMINAL_REASONS: ReadonlySet<string> = new Set<TerminalReason>([
	"prompt_too_long",
	"blocking_limit",
	"rapid_refill_breaker",
]);
const OVERFLOW_CODE = "context_length_exceeded";

/**
 * Whether a failure is the conversation outgrowing the model's context:
 * Anthropic's or Claude Code's wording, an upstream `context_length_exceeded`
 * code, or one of the SDK's context-limit terminal reasons.
 */
export function isContextOverflow(evidence: {
	text?: string | null;
	code?: string | null;
	terminalReason?: TerminalReason | (string & {}) | null;
}): boolean {
	if (evidence.code === OVERFLOW_CODE) return true;
	if (
		evidence.terminalReason &&
		OVERFLOW_TERMINAL_REASONS.has(evidence.terminalReason)
	)
		return true;
	return (
		!!evidence.text &&
		(PROMPT_TOO_LONG.test(evidence.text) ||
			INPUT_LENGTH_OVERFLOW.test(evidence.text))
	);
}

function overflowError(message: string): BridgeError {
	return {
		status: 400,
		type: "invalid_request_error",
		code: OVERFLOW_CODE,
		message,
		retryAfter: null,
	};
}

/**
 * A context overflow in Anthropic's wording: its "prompt is too long" with
 * the token counts `text` had, or its input-length message as it was.
 */
export function contextOverflow(text: string | null): BridgeError {
	const counts = text ? PROMPT_TOO_LONG_COUNTS.exec(text) : null;
	if (counts)
		return overflowError(
			`prompt is too long: ${counts[1]} tokens > ${counts[2]} maximum`,
		);
	const inputLength = text ? INPUT_LENGTH_OVERFLOW.exec(text) : null;
	if (inputLength) return overflowError(sanitizeMessage(inputLength[0]));
	return overflowError("prompt is too long");
}

/** Why Claude Code ended a turn by itself, when the bridge can tell. */
export type ClaudeCodeFailureCause = "context_overflow";

export interface ClaudeCodeFailure {
	text: string | null;
	cause: ClaudeCodeFailureCause | null;
}

function knownType(type: string | null, fallback: string): string {
	return type && ANTHROPIC_ERROR_TYPES.has(type) ? type : fallback;
}

/** How an inner model call's final failure reaches the client. */
export function mapInnerOutcome(outcome: SdkBridgeInnerOutcome): BridgeError {
	const message = sanitizeMessage(outcome.message);
	const retryAfter = outcome.retryAfter ?? DEFAULT_RETRY_AFTER_SECONDS;
	const { status } = outcome;
	if (status === 429)
		return { status, type: "rate_limit_error", message, retryAfter };
	if (status === 529)
		return { status, type: "overloaded_error", message, retryAfter };
	if (status === 503)
		return {
			status,
			type: knownType(outcome.errorType, "api_error"),
			message,
			retryAfter,
		};
	if (
		status === 400 &&
		isContextOverflow({ text: outcome.message, code: outcome.errorCode })
	)
		return contextOverflow(outcome.message);
	if (status === 400)
		return {
			status,
			type: knownType(outcome.errorType, "invalid_request_error"),
			message,
			retryAfter: null,
		};
	if (status === 403)
		return { status, type: "permission_error", message, retryAfter: null };
	if (status === 401 || status >= 500)
		return { status: 502, type: "api_error", message, retryAfter: null };
	if (status >= 400)
		return {
			status,
			type: knownType(outcome.errorType, "invalid_request_error"),
			message,
			retryAfter: null,
		};
	return {
		status: 502,
		type: "api_error",
		message: GENERIC_UPSTREAM_MESSAGE,
		retryAfter: null,
	};
}

/**
 * A turn Claude Code ended in error. The inner call it gave up on decides the
 * answer; without one, the failure was Claude Code's own.
 */
export function mapClaudeCodeFailure(
	decisive: SdkBridgeInnerOutcome | null,
	failure: ClaudeCodeFailure,
): BridgeError {
	if (failure.cause === "context_overflow" && decisive?.status === 400)
		return contextOverflow(
			isContextOverflow({ text: decisive.message })
				? decisive.message
				: failure.text,
		);
	if (decisive) return mapInnerOutcome(decisive);
	if (failure.cause === "context_overflow")
		return contextOverflow(failure.text);
	return {
		status: 502,
		type: "api_error",
		message: `Claude Code ended the turn with an error: ${sanitizeMessage(failure.text)}`,
		retryAfter: null,
	};
}

export const bridgeErrors = {
	deadline(ms: number): BridgeError {
		return {
			status: 504,
			type: "timeout_error",
			message: `The SDK bridge turn exceeded its ${Math.round(ms / 1000)} s deadline`,
			retryAfter: null,
		};
	},
	processCap(cap: number): BridgeError {
		return {
			status: 529,
			type: "overloaded_error",
			message: `The SDK bridge is running its maximum of ${cap} Claude Code processes`,
			retryAfter: PROCESS_CAP_RETRY_AFTER_SECONDS,
		};
	},
	rebuildCap(cap: number): BridgeError {
		return {
			status: 529,
			type: "overloaded_error",
			message: `The SDK bridge is rebuilding its maximum of ${cap} conversations (maxConcurrentRebuilds)`,
			retryAfter: PROCESS_CAP_RETRY_AFTER_SECONDS,
		};
	},
	noEligibleAccount(): BridgeError {
		return {
			status: 503,
			type: "api_error",
			message: "No Claude account is eligible for this SDK bridge turn",
			retryAfter: DEFAULT_RETRY_AFTER_SECONDS,
		};
	},
	shutdown(): BridgeError {
		return {
			status: 503,
			type: "api_error",
			message: "The SDK bridge is shutting down",
			retryAfter: DEFAULT_RETRY_AFTER_SECONDS,
		};
	},
	deadTurn(): BridgeError {
		return {
			status: 409,
			type: "invalid_request_error",
			message:
				"The Claude Code session that issued these tool calls is gone; resend the turn",
			retryAfter: null,
		};
	},
	staleToolResults(): BridgeError {
		return {
			status: 409,
			type: "invalid_request_error",
			message:
				"These tool results do not answer the tool calls this turn is waiting on (stale tool results)",
			retryAfter: null,
		};
	},
	otherOwner(): BridgeError {
		return {
			status: 409,
			type: "invalid_request_error",
			message:
				"These tool results answer a turn that belongs to another API key",
			retryAfter: null,
		};
	},
	modelChanged(started: string, requested: string): BridgeError {
		return {
			status: 409,
			type: "invalid_request_error",
			message: `This turn started on model "${started}"; its tool results cannot continue it on "${requested}"`,
			retryAfter: null,
		};
	},
	superseded(): BridgeError {
		return {
			status: 409,
			type: "invalid_request_error",
			message:
				"A new turn of this conversation arrived while this one waited on tool results",
			retryAfter: null,
		};
	},
	tooDeep(): BridgeError {
		return {
			status: 400,
			type: "invalid_request_error",
			message: "The request is nested too deeply to hand to Claude Code",
			retryAfter: null,
		};
	},
	parkedTimeout(ms: number): BridgeError {
		return {
			status: 504,
			type: "timeout_error",
			message: `No tool result arrived within ${Math.round(ms / 1000)} s`,
			retryAfter: null,
		};
	},
	idle(ms: number): BridgeError {
		return {
			status: 502,
			type: "api_error",
			message: `Claude Code went silent for ${Math.round(ms / 1000)} s`,
			retryAfter: null,
		};
	},
	limit(name: string, actual: number, limit: number): BridgeError {
		const tooLarge = name.endsWith("Bytes");
		return {
			status: tooLarge ? 413 : 400,
			type: tooLarge ? "request_too_large" : "invalid_request_error",
			message: `SDK bridge limit ${name} exceeded: ${actual} > ${limit}`,
			retryAfter: null,
		};
	},
	invalid(message: string): BridgeError {
		return {
			status: 400,
			type: "invalid_request_error",
			message,
			retryAfter: null,
		};
	},
	clientGone(): BridgeError {
		return {
			status: 499,
			type: "client_closed_request",
			message: "The client closed the request",
			retryAfter: null,
		};
	},
	internal(message: string): BridgeError {
		return { status: 502, type: "api_error", message, retryAfter: null };
	},
};

export function errorBody(error: BridgeError) {
	return {
		type: "error" as const,
		error: {
			type: error.type,
			message: error.message,
			...(error.code ? { code: error.code } : {}),
		},
	};
}

export function errorResponse(error: BridgeError): Response {
	const headers = new Headers({ "content-type": "application/json" });
	if (error.retryAfter) headers.set("retry-after", error.retryAfter);
	return new Response(JSON.stringify(errorBody(error)), {
		status: error.status,
		headers,
	});
}
