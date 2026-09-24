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
		// Extra Usage fails closed and says so, verbatim.
		expect(extra).toEqual({
			status: 400,
			type: "invalid_request_error",
			message:
				"You're out of extra usage. Add more at claude.ai/settings/usage",
			retryAfter: null,
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
