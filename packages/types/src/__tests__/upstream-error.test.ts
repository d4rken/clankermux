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

	// --- FastAPI-style `detail` envelopes (ChatGPT/Codex backend, issue #5) ---

	it("extracts a string detail from a FastAPI-style envelope", () => {
		expect(
			parseUpstreamError(
				'{"detail":"Unsupported parameter: max_output_tokens"}',
			),
		).toBe("Unsupported parameter: max_output_tokens");
	});

	it("extracts the Codex model-entitlement detail verbatim", () => {
		const body = JSON.stringify({
			detail:
				"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
		});
		expect(parseUpstreamError(body)).toBe(
			"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
		);
	});

	it("renders a FastAPI validation array as loc: msg entries", () => {
		const body = JSON.stringify({
			detail: [
				{
					loc: ["body", "max_output_tokens"],
					msg: "Extra inputs are not permitted",
					type: "extra_forbidden",
					input: 4096,
				},
				{
					loc: ["body", "model"],
					msg: "Field required",
					type: "missing",
				},
			],
		});
		expect(parseUpstreamError(body)).toBe(
			"body.max_output_tokens: Extra inputs are not permitted; body.model: Field required",
		);
	});

	it("never echoes a validation entry's `input` value", () => {
		const body = JSON.stringify({
			detail: [
				{
					loc: ["body", "messages", 0, "content"],
					msg: "Input should be a valid string",
					type: "string_type",
					input: "sk-live-SUPERSECRET-and-some-user-prompt-text",
				},
			],
		});
		const result = parseUpstreamError(body);
		expect(result).toBe(
			"body.messages.0.content: Input should be a valid string",
		);
		expect(result).not.toContain("SUPERSECRET");
	});

	it("renders a validation entry without loc as the bare message", () => {
		const body = JSON.stringify({ detail: [{ msg: "Field required" }] });
		expect(parseUpstreamError(body)).toBe("Field required");
	});

	it("renders an array of plain strings", () => {
		const body = JSON.stringify({
			detail: ["first problem", "second problem"],
		});
		expect(parseUpstreamError(body)).toBe("first problem; second problem");
	});

	it("caps a long validation array and reports how many were omitted", () => {
		const body = JSON.stringify({
			detail: Array.from({ length: 9 }, (_, i) => ({
				loc: ["body", `f${i}`],
				msg: "Field required",
			})),
		});
		const result = parseUpstreamError(body);
		expect(result).toContain("body.f0: Field required");
		expect(result).toContain("body.f4: Field required");
		expect(result).not.toContain("body.f5");
		expect(result).toContain("(+4 more)");
	});

	it("extracts a message from an object detail", () => {
		expect(parseUpstreamError('{"detail":{"message":"quota exhausted"}}')).toBe(
			"quota exhausted",
		);
	});

	it("extracts a nested error envelope from an object detail", () => {
		const body = JSON.stringify({
			detail: { error: { type: "billing_error", message: "no credits" } },
		});
		expect(parseUpstreamError(body)).toBe("billing_error: no credits");
	});

	it("returns null for an object detail with no recognizable message", () => {
		// Deliberate: a blind JSON.stringify would leak arbitrary upstream values
		// into requests.error_message. Falling through keeps the generic label.
		expect(parseUpstreamError('{"detail":{"foo":{"bar":1}}}')).toBeNull();
	});

	it("returns null for an empty or whitespace-only detail", () => {
		expect(parseUpstreamError('{"detail":""}')).toBeNull();
		expect(parseUpstreamError('{"detail":"   "}')).toBeNull();
		expect(parseUpstreamError('{"detail":[]}')).toBeNull();
		expect(parseUpstreamError('{"detail":{}}')).toBeNull();
		expect(parseUpstreamError('{"detail":null}')).toBeNull();
	});

	it("truncates a long detail to exactly 300 chars ending with an ellipsis", () => {
		const result = parseUpstreamError(
			JSON.stringify({ detail: "y".repeat(500) }),
		);
		expect(result?.length).toBe(300);
		expect(result?.endsWith("…")).toBe(true);
	});

	it("ignores a `detail` inside an SSE data frame", () => {
		// `detail` is a whole-body FastAPI convention; the SSE scan feeds EVERY
		// data frame through the extractor, so a generic key must not fire there.
		const body =
			'event: response.output_text.delta\ndata: {"detail":"not an error"}\n\n';
		expect(parseUpstreamError(body)).toBeNull();
	});

	// --- Branch precedence ---

	it("prefers a structured error envelope over detail and message", () => {
		const body = JSON.stringify({
			error: { type: "invalid_request_error", message: "from error" },
			detail: "from detail",
			message: "from message",
		});
		expect(parseUpstreamError(body)).toBe("invalid_request_error: from error");
	});

	it("prefers detail over a bare top-level message", () => {
		const body = JSON.stringify({
			detail: "from detail",
			message: "from message",
		});
		expect(parseUpstreamError(body)).toBe("from detail");
	});

	it("falls through to detail when the error envelope carries nothing usable", () => {
		// An `{"error":{}}` wrapper must not suppress a usable sibling field.
		expect(parseUpstreamError('{"error":{},"detail":"real reason"}')).toBe(
			"real reason",
		);
	});

	it("falls through to message when both error and detail are unusable", () => {
		expect(
			parseUpstreamError('{"error":{},"detail":"  ","message":"last resort"}'),
		).toBe("last resort");
	});

	it("treats a whitespace-only error string as absent rather than returning empty", () => {
		expect(parseUpstreamError('{"error":"   "}')).toBeNull();
		expect(parseUpstreamError('{"error":"   ","message":"real"}')).toBe("real");
	});

	it("keeps returning null when no convention matches", () => {
		expect(parseUpstreamError('{"foo":"bar"}')).toBeNull();
	});
});
