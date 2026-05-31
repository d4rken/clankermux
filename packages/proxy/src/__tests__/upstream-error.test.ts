import { describe, expect, it } from "bun:test";
import { parseUpstreamError } from "../upstream-error";

describe("parseUpstreamError", () => {
	it("extracts type + message from an Anthropic JSON 400 envelope", () => {
		const body = JSON.stringify({
			type: "error",
			error: {
				type: "invalid_request_error",
				message:
					"messages.3.content.130: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.",
			},
		});
		expect(parseUpstreamError(body)).toBe(
			"invalid_request_error: messages.3.content.130: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.",
		);
	});

	it("returns just the message when error has no type", () => {
		expect(parseUpstreamError('{"error":{"message":"something broke"}}')).toBe(
			"something broke",
		);
	});

	it("returns just the type when error has no message", () => {
		expect(parseUpstreamError('{"error":{"type":"rate_limit_error"}}')).toBe(
			"rate_limit_error",
		);
	});

	it("returns the string when error is a flat string", () => {
		expect(parseUpstreamError('{"error":"flat string error"}')).toBe(
			"flat string error",
		);
	});

	it("returns a top-level message string when there is no error key", () => {
		expect(parseUpstreamError('{"message":"top level message"}')).toBe(
			"top level message",
		);
	});

	it("extracts an error from an SSE error frame", () => {
		const body =
			'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
		expect(parseUpstreamError(body)).toBe("overloaded_error: Overloaded");
	});

	it("returns null for an SSE stream of normal deltas (no error frame)", () => {
		const body =
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","role":"assistant"}}\n\n' +
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n';
		// message_start's `message` is an OBJECT, not a string — the top-level
		// message-string rule must NOT fire here.
		expect(parseUpstreamError(body)).toBeNull();
	});

	it("returns null for invalid JSON", () => {
		expect(parseUpstreamError("not json at all {")).toBeNull();
	});

	it("returns null for an HTML error page", () => {
		expect(
			parseUpstreamError("<html><body>502 Bad Gateway</body></html>"),
		).toBeNull();
	});

	it("returns null for an empty string", () => {
		expect(parseUpstreamError("")).toBeNull();
	});

	it("truncates a long message to exactly 300 chars ending with an ellipsis", () => {
		const body = JSON.stringify({
			error: { message: "x".repeat(500) },
		});
		const result = parseUpstreamError(body);
		expect(result).not.toBeNull();
		expect(result?.length).toBe(300);
		expect(result?.endsWith("…")).toBe(true);
	});

	it("collapses internal whitespace and trims the message", () => {
		const body = JSON.stringify({
			error: { message: "line one\n\n   line two" },
		});
		expect(parseUpstreamError(body)).toBe("line one line two");
	});

	it("still returns the error frame when a [DONE] line is present", () => {
		const body =
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n' +
			'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n' +
			"data: [DONE]\n\n";
		expect(parseUpstreamError(body)).toBe("overloaded_error: Overloaded");
	});

	it("finds an error frame within the last 16KB of a very large SSE body", () => {
		const filler = Array.from(
			{ length: 2000 },
			() =>
				'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
		).join("");
		const body = `${filler}event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Internal server error"}}\n\n`;
		expect(parseUpstreamError(body)).toBe("api_error: Internal server error");
	});

	it("keeps the LAST error frame when multiple are present", () => {
		const body =
			'event: error\ndata: {"type":"error","error":{"type":"first_error","message":"first"}}\n\n' +
			'event: error\ndata: {"type":"error","error":{"type":"last_error","message":"last"}}\n\n';
		expect(parseUpstreamError(body)).toBe("last_error: last");
	});
});
