import { describe, expect, it } from "bun:test";
import type { SdkBridgeInnerOutcome } from "@clankermux/types";
import {
	bridgeErrors,
	contextOverflow,
	DEFAULT_RETRY_AFTER_SECONDS,
	errorBody,
	errorResponse,
	isContextOverflow,
	mapClaudeCodeFailure,
	mapInnerOutcome,
	sanitizeMessage,
} from "../errors";

function outcome(
	status: number,
	extra: Partial<SdkBridgeInnerOutcome> = {},
): SdkBridgeInnerOutcome {
	return {
		requestId: "r1",
		status,
		errorType: null,
		message: `upstream said ${status}`,
		retryAfter: null,
		accountId: "acct-a",
		...extra,
	};
}

describe("error mapping", () => {
	it.each([
		// [inner status, client status, type, has Retry-After]
		[429, 429, "rate_limit_error", true],
		[503, 503, "api_error", true],
		[529, 529, "overloaded_error", true],
		[400, 400, "invalid_request_error", false],
		[403, 403, "permission_error", false],
		[500, 502, "api_error", false],
		[502, 502, "api_error", false],
		[504, 502, "api_error", false],
		[401, 502, "api_error", false],
	])("inner %i answers the client %i %s", (inner, status, type, retry) => {
		const mapped = mapInnerOutcome(outcome(inner));
		expect(mapped.status).toBe(status);
		expect(mapped.type).toBe(type);
		expect(mapped.retryAfter !== null).toBe(retry);
	});

	it("keeps the inner Retry-After and a 400's own type and message", () => {
		expect(mapInnerOutcome(outcome(429, { retryAfter: "17" })).retryAfter).toBe(
			"17",
		);
		expect(mapInnerOutcome(outcome(429)).retryAfter).toBe(
			DEFAULT_RETRY_AFTER_SECONDS,
		);
		const extra = mapInnerOutcome(
			outcome(400, {
				errorType: "invalid_request_error",
				message:
					"You're out of extra usage. Add more at claude.ai/settings/usage",
			}),
		);
		// Extra Usage fails closed and says so, verbatim; the attempt may fail over.
		expect(extra).toEqual({
			status: 400,
			type: "invalid_request_error",
			message:
				"You're out of extra usage. Add more at claude.ai/settings/usage",
			retryAfter: null,
			failover: "extra_usage_exhausted",
		});
	});

	it("marks only an inner 400 saying it is out of extra usage for failover", () => {
		const failover = (status: number, message: string | null) =>
			mapInnerOutcome(outcome(status, { message })).failover;
		expect(failover(400, "You're out of extra usage.")).toBe(
			"extra_usage_exhausted",
		);
		expect(failover(400, "OUT OF EXTRA USAGE")).toBe("extra_usage_exhausted");
		expect(failover(429, "You're out of extra usage.")).toBeUndefined();
		expect(failover(403, "You're out of extra usage.")).toBeUndefined();
		expect(
			failover(400, "Extra usage is required for 1M context"),
		).toBeUndefined();
		expect(failover(400, null)).toBeUndefined();
		expect(
			failover(400, "prompt is too long: 3 tokens > 2 maximum"),
		).toBeUndefined();
	});

	describe("a claude_code_version_too_old rejection", () => {
		const ANTHROPIC_TEXT =
			"Claude Code 2.1.280 does not support this model; version 2.1.290 or newer is required.";

		it("names the gateway's Claude Code as the cause and fails over", () => {
			const mapped = mapInnerOutcome(
				outcome(400, {
					errorType: "invalid_request_error",
					errorCode: "claude_code_version_too_old",
					message: ANTHROPIC_TEXT,
					model: "claude-opus-6",
				}),
			);
			expect(mapped).toEqual({
				status: 400,
				type: "invalid_request_error",
				code: "claude_code_version_too_old",
				message:
					"Anthropic requires Claude Code 2.1.290 or newer for model \"claude-opus-6\", and this gateway's SDK bridge runs 2.1.280. The gateway operator has to update the bridge's Claude Agent SDK.",
				retryAfter: null,
				failover: "claude_code_version_too_old",
			});
			expect(errorBody(mapped).error).toEqual({
				type: "invalid_request_error",
				message: mapped.message,
				code: "claude_code_version_too_old",
			});
		});

		it("is recognized by its wording when the body carries no error code", () => {
			expect(
				mapInnerOutcome(outcome(400, { message: ANTHROPIC_TEXT })).failover,
			).toBe("claude_code_version_too_old");
		});

		it("still fails over when the message names no versions", () => {
			const mapped = mapInnerOutcome(
				outcome(400, {
					errorCode: "claude_code_version_too_old",
					message: "This model needs a newer client.",
				}),
			);
			expect(mapped.failover).toBe("claude_code_version_too_old");
			expect(mapped.message).toBe(
				"Anthropic requires a newer Claude Code for this model than this gateway's SDK bridge runs. The gateway operator has to update the bridge's Claude Agent SDK.",
			);
		});

		it("is only a 400", () => {
			expect(
				mapInnerOutcome(
					outcome(403, {
						errorCode: "claude_code_version_too_old",
						message: ANTHROPIC_TEXT,
					}),
				).failover,
			).toBeUndefined();
		});
	});

	it("never sends the failover mark to the client", () => {
		const mapped = mapInnerOutcome(
			outcome(400, { message: "You're out of extra usage." }),
		);
		expect(errorBody(mapped)).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "You're out of extra usage.",
			},
		});
	});

	it("passes an inner 400's plain message verbatim", () => {
		const mapped = mapInnerOutcome(
			outcome(400, {
				errorType: "invalid_request_error",
				message: "max_tokens: must be at most 128000",
			}),
		);
		expect(mapped).toEqual({
			status: 400,
			type: "invalid_request_error",
			message: "max_tokens: must be at most 128000",
			retryAfter: null,
		});
	});

	it("answers an inner context overflow as context_length_exceeded, with its token counts", () => {
		expect(
			mapInnerOutcome(
				outcome(400, {
					errorType: "invalid_request_error",
					message: "prompt is too long: 215012 tokens > 200000 maximum",
				}),
			),
		).toEqual({
			status: 400,
			type: "invalid_request_error",
			code: "context_length_exceeded",
			message: "prompt is too long: 215012 tokens > 200000 maximum",
			retryAfter: null,
		});
	});

	it("answers an inner 400 coded context_length_exceeded as overflow, whatever its wording", () => {
		expect(
			mapInnerOutcome(
				outcome(400, {
					errorType: "invalid_request_error",
					errorCode: "context_length_exceeded",
					message: null,
				}),
			),
		).toMatchObject({
			status: 400,
			code: "context_length_exceeded",
			message: "prompt is too long",
		});
		expect(
			mapInnerOutcome(
				outcome(400, {
					errorType: "invalid_request_error",
					errorCode: "something_else",
					message: "bad",
				}),
			).code,
		).toBeUndefined();
	});

	it("answers Anthropic's input-length overflow as context_length_exceeded, keeping its message", () => {
		const message =
			"input length and `max_tokens` exceed context limit: 187254 + 21333 > 200000, decrease input length or `max_tokens` and try again";
		expect(
			mapInnerOutcome(
				outcome(400, { errorType: "invalid_request_error", message }),
			),
		).toEqual({
			status: 400,
			type: "invalid_request_error",
			code: "context_length_exceeded",
			message:
				"input length and `max_tokens` exceed context limit: 187254 + 21333 > 200000",
			retryAfter: null,
		});
		expect(isContextOverflow({ text: `API Error: 400 ${message}` })).toBe(true);
	});

	it("answers a decisive 400 as overflow when Claude Code's cause says so, even without a message", () => {
		expect(
			mapClaudeCodeFailure(outcome(400, { message: null }), {
				text: "prompt is too long: 9 tokens > 8 maximum",
				cause: "context_overflow",
			}),
		).toEqual({
			status: 400,
			type: "invalid_request_error",
			code: "context_length_exceeded",
			message: "prompt is too long: 9 tokens > 8 maximum",
			retryAfter: null,
		});
		expect(
			mapClaudeCodeFailure(outcome(400, { message: null }), {
				text: null,
				cause: null,
			}).code,
		).toBeUndefined();
	});

	it("keeps Claude Code's token counts when the decisive 400's own message is no overflow evidence", () => {
		expect(
			mapClaudeCodeFailure(outcome(400, { message: "Bad request" }), {
				text: "prompt is too long: 9 tokens > 8 maximum",
				cause: "context_overflow",
			}).message,
		).toBe("prompt is too long: 9 tokens > 8 maximum");
		expect(
			mapClaudeCodeFailure(
				outcome(400, {
					message: "prompt is too long: 215012 tokens > 200000 maximum",
				}),
				{ text: "Prompt is too long", cause: "context_overflow" },
			).message,
		).toBe("prompt is too long: 215012 tokens > 200000 maximum");
	});

	it("answers 502 for a Claude Code error with no inner outcome", () => {
		const mapped = mapClaudeCodeFailure(null, {
			text: "something broke",
			cause: null,
		});
		expect(mapped.status).toBe(502);
		expect(mapped.code).toBeUndefined();
		expect(mapped.message).toContain("something broke");
	});

	it("answers Claude Code's own context overflow as context_length_exceeded", () => {
		expect(
			mapClaudeCodeFailure(null, {
				text: "Prompt is too long",
				cause: "context_overflow",
			}),
		).toEqual({
			status: 400,
			type: "invalid_request_error",
			code: "context_length_exceeded",
			message: "prompt is too long",
			retryAfter: null,
		});
		// The cause decides, not the wording.
		expect(
			mapClaudeCodeFailure(null, {
				text: "Prompt is too long",
				cause: null,
			}).status,
		).toBe(502);
	});

	it("lets the inner outcome Claude Code gave up on decide", () => {
		expect(
			mapClaudeCodeFailure(outcome(529), {
				text: "Prompt is too long",
				cause: "context_overflow",
			}).status,
		).toBe(529);
	});

	it("classifies context overflow from Anthropic's and Claude Code's wording and from Claude Code's terminal reasons", () => {
		for (const text of [
			"prompt is too long: 215012 tokens > 200000 maximum",
			"Prompt is too long",
			'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1 tokens > 0 maximum"}}',
		])
			expect(isContextOverflow({ text })).toBe(true);
		for (const terminalReason of [
			"prompt_too_long",
			"blocking_limit",
			"rapid_refill_breaker",
		])
			expect(isContextOverflow({ terminalReason })).toBe(true);
		expect(isContextOverflow({ code: "context_length_exceeded" })).toBe(true);
		expect(isContextOverflow({ text: "max_tokens exceeded" })).toBe(false);
		expect(isContextOverflow({ terminalReason: "model_error" })).toBe(false);
		expect(isContextOverflow({})).toBe(false);
	});

	it("keeps the token counts wherever the overflow wording carried them", () => {
		expect(
			contextOverflow(
				'API Error: 400 {"error":{"message":"prompt is too long: 215012 tokens > 200000 maximum"}}',
			).message,
		).toBe("prompt is too long: 215012 tokens > 200000 maximum");
		expect(contextOverflow(null).message).toBe("prompt is too long");
	});

	it("never passes Claude Code's credential wording through", () => {
		for (const text of [
			"Failed to authenticate. API Error: 401",
			'API Error: 401 {"type":"authentication_error"}',
			"Invalid API key · Please run /login",
			"OAuth token has expired",
		]) {
			const mapped = mapClaudeCodeFailure(null, { text, cause: null });
			expect(mapped.message.toLowerCase()).not.toContain(
				"failed to authenticate",
			);
			expect(mapped.message.toLowerCase()).not.toContain("login");
			expect(sanitizeMessage(text)).toBe("The upstream model call failed");
			expect(mapInnerOutcome(outcome(401, { message: text })).message).toBe(
				"The upstream model call failed",
			);
		}
	});

	it("covers the bridge's own rows", () => {
		expect(bridgeErrors.deadline(60_000).status).toBe(504);
		expect(bridgeErrors.processCap(4)).toMatchObject({
			status: 529,
			retryAfter: "10",
		});
		expect(bridgeErrors.noEligibleAccount()).toMatchObject({ status: 503 });
		expect(bridgeErrors.shutdown()).toMatchObject({ status: 503 });
		expect(bridgeErrors.limit("maxHistoryBytes", 2, 1)).toMatchObject({
			status: 413,
			type: "request_too_large",
		});
		expect(bridgeErrors.limit("maxTools", 2, 1)).toMatchObject({ status: 400 });
		expect(bridgeErrors.limit("maxTools", 2, 1).message).toContain("maxTools");
	});

	it("renders an error's code only when it has one", () => {
		expect(errorBody(bridgeErrors.shutdown()).error).not.toHaveProperty("code");
		expect(errorBody(contextOverflow(null))).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "prompt is too long",
				code: "context_length_exceeded",
			},
		});
	});

	it("refuses a continuation that names another model with 409", () => {
		const error = bridgeErrors.modelChanged("sonnet", "opus");
		expect(error).toMatchObject({
			status: 409,
			type: "invalid_request_error",
		});
		expect(error.message).toContain('"sonnet"');
		expect(error.message).toContain('"opus"');
	});

	it("renders JSON with Retry-After", async () => {
		const response = errorResponse(bridgeErrors.processCap(4));
		expect(response.status).toBe(529);
		expect(response.headers.get("retry-after")).toBe("10");
		expect(await response.json()).toEqual({
			type: "error",
			error: {
				type: "overloaded_error",
				message:
					"The SDK bridge is running its maximum of 4 Claude Code processes",
			},
		});
	});
});
