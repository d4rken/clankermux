import { describe, expect, it } from "bun:test";
import {
	classifyNativeResponsesEnd,
	createUsageState,
	feedChunk,
	flushPendingSseLine,
	getLineBufferLength,
	MAX_SSE_LINE_BYTES,
} from "../usage-collector";

const enc = new TextEncoder();
const attribution = {
	items: Array.from({ length: 8000 }, () => ({
		cached_tokens: 42,
		content: 'escaped " text \\ 😀',
	})),
};
function terminal(kind: string, header = true) {
	return `${header ? `event: response.${kind}\n` : ""}data: ${JSON.stringify({
		type: `response.${kind}`,
		response: {
			tools: [{ description: "x".repeat(300_000) }],
			error: kind === "failed" ? { code: "server_error" } : null,
			usage: {
				attribution,
				input_tokens: 12345,
				output_tokens: 67,
				input_tokens_details: { cached_tokens: 12000 },
			},
		},
	})}\n\n`;
}
function collect(text: string, size: number) {
	const state = createUsageState();
	const bytes = enc.encode(text);
	for (let i = 0; i < bytes.length; i += size) {
		feedChunk(state, bytes.subarray(i, i + size), 1000 + i);
		expect(getLineBufferLength(state)).toBeLessThanOrEqual(MAX_SSE_LINE_BYTES);
	}
	flushPendingSseLine(state);
	return state;
}

describe("large native terminal events", () => {
	for (const kind of ["completed", "failed", "incomplete"] as const) {
		for (const size of [997, 16_384, 2_000_000]) {
			it(`${kind}: exact accounting with ${size}-byte chunks`, () => {
				const state = collect(terminal(kind), size);
				expect(state.responsesTerminalKind).toBe(kind);
				expect(state.inputTokens).toBe(345);
				expect(state.cacheReadInputTokens).toBe(12000);
				expect(state.providerFinalOutputTokens).toBe(67);
				expect(state.providerReportedOutput).toBe(true);
				expect(classifyNativeResponsesEnd(state)).toBe(
					kind === "failed" ? "native_responses_stream_failed" : null,
				);
				if (kind === "failed")
					expect(state.streamFailureCode).toBe("server_error");
			});
		}
	}
	it("accepts data-only terminals and EOF without newline", () => {
		expect(
			collect(terminal("completed", false).trimEnd(), 8191).sawMessageStop,
		).toBe(true);
	});
	it("does not commit a terminal header or an incomplete JSON value", () => {
		const state = collect(terminal("completed").slice(0, -25), 1024);
		expect(state.sawMessageStop).toBe(false);
		expect(state.providerReportedOutput).toBe(false);
		expect(classifyNativeResponsesEnd(state, false)).toBe(
			"native_responses_no_terminal",
		);
		expect(classifyNativeResponsesEnd(state)).toBe(
			"native_responses_parse_error",
		);
		expect(
			classifyNativeResponsesEnd(collect("event: response.completed\n", 1024)),
		).toBe("native_responses_no_terminal");
	});
	it("validates skipped fields and rejects malformed JSON", () => {
		const bad = terminal("completed").replace(
			'"cached_tokens":42',
			'"cached_tokens":01',
		);
		expect(classifyNativeResponsesEnd(collect(bad, 1024))).toBe(
			"native_responses_parse_error",
		);
	});
	it("reports a parser limit independently from upstream truncation", () => {
		const bad = `event: response.completed\ndata: {"padding":"${"x".repeat(300_000)}","deep":${"[".repeat(100)}0${"]".repeat(100)}}\n\n`;
		expect(classifyNativeResponsesEnd(collect(bad, 1024))).toBe(
			"native_responses_parse_limit",
		);
	});
	it("resynchronizes after invalid input and preserves the first valid terminal", () => {
		const text = `${terminal("completed").slice(0, -25)}\n\n${terminal("incomplete")}${terminal("failed")}`;
		const state = collect(text, 8192);
		expect(state.responsesTerminalKind).toBe("incomplete");
		expect(classifyNativeResponsesEnd(state)).toBe(null);
	});
});

it("rejects a large array under a terminal event header", () => {
	const state = collect(
		`event: response.completed\ndata: ["${"x".repeat(300_000)}"]\n\n`,
		8192,
	);
	expect(state.sawMessageStop).toBe(false);
	expect(classifyNativeResponsesEnd(state)).toBe(
		"native_responses_parse_error",
	);
});
