/**
 * End-to-end check of the path the production failure actually took: a Codex
 * CLI /v1/responses request carrying one attached screenshot.
 *
 * That request is translated to an Anthropic /v1/messages body BEFORE ingress,
 * so it goes through the composition walk rather than the whole-body fallback.
 * With the base64 payload counted as prompt text, a ~1.4MB PNG (~1.9MB base64)
 * measured as ~630k tokens and the context-window gate answered
 * context_window_exceeded on a request whose real size was ~47k tokens.
 *
 * The three packages involved (adapter → proxy walk → core estimator) each have
 * their own unit tests; only this composition can catch a mismatch between
 * what the translator emits and what the walk recognises.
 */
import { describe, expect, it } from "bun:test";
import {
	codexAccountFitsRequest,
	estimateContextWindowTokens,
} from "@clankermux/core";
import type { ResponsesRequest } from "@clankermux/openai-responses-adapter";
import { translateRequestToAnthropic } from "@clankermux/openai-responses-adapter";
import { computeContextAndToolStats } from "@clankermux/proxy";
import type { Account } from "@clankermux/types";

/** ~1.9MB of base64, the size a 1.4MB PNG arrives at. */
const IMAGE_BASE64 = "A".repeat(1_900_000);

/**
 * The two screenshots carried by the 2026-08-20 production failure, at their
 * measured base64 lengths. Codex CLI attaches these inside a
 * `function_call_output`, not inside a message — see the second describe block.
 */
const TOOL_IMAGE_SMALL_BASE64 = "A".repeat(147_292);
const TOOL_IMAGE_LARGE_BASE64 = "B".repeat(520_676);

/** Roughly the real prompt of the observed request (~47k tokens). */
const PROMPT_TEXT = "x".repeat(140_000);

function codexAccount(): Account {
	return {
		id: "acct-codex",
		name: "codex",
		provider: "codex",
		api_key: "",
		refresh_token: "r",
		access_token: "a",
		expires_at: Date.now() + 3_600_000,
		created_at: Date.now(),
		last_used: null,
		request_count: 0,
		total_requests: 0,
		account_tier: 1,
		paused: false,
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		custom_endpoint: null,
		model_mappings: null, // opus → gpt-5.6-sol (353k window)
	} as unknown as Account;
}

function responsesRequestWithImage(): ResponsesRequest & {
	input: NonNullable<Exclude<ResponsesRequest["input"], string>>;
} {
	return {
		model: "gpt-5.6-sol",
		input: [
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: PROMPT_TEXT },
					{
						type: "input_image",
						image_url: `data:image/png;base64,${IMAGE_BASE64}`,
					},
				],
			},
		],
	};
}

describe("image-bearing /v1/responses request through the context-window gate", () => {
	it("estimates the translated body by content, not by attachment bytes", () => {
		const anthropicBody = translateRequestToAnthropic(
			responsesRequestWithImage(),
		);

		// Sanity: the translator really did produce a base64 image block.
		const blocks = anthropicBody.messages[0].content;
		expect(blocks.some((block) => block.type === "image")).toBe(true);

		const { composition } = computeContextAndToolStats(
			anthropicBody as unknown as Parameters<
				typeof computeContextAndToolStats
			>[0],
		);
		expect(composition).not.toBeNull();
		expect(composition?.imageCount).toBe(1);
		expect(composition?.imagePayloadChars).toBe(IMAGE_BASE64.length);

		const estimate = estimateContextWindowTokens(
			anthropicBody as unknown as Record<string, unknown>,
			composition,
		);

		// Old behaviour: ~657k tokens → rejected. Now the estimate tracks the
		// prompt text plus one flat image allowance.
		expect(estimate).toBeLessThan(100_000);
		expect(
			codexAccountFitsRequest(codexAccount(), "claude-opus-4-8", estimate),
		).toBe(true);
	});

	it("never mutates the body it measures (native passthrough forwards it verbatim)", () => {
		const anthropicBody = translateRequestToAnthropic(
			responsesRequestWithImage(),
		);
		const before = structuredClone(anthropicBody);

		const { composition } = computeContextAndToolStats(
			anthropicBody as unknown as Parameters<
				typeof computeContextAndToolStats
			>[0],
		);
		estimateContextWindowTokens(
			anthropicBody as unknown as Record<string, unknown>,
			composition,
		);
		// The fallback path measures the whole body too — also non-destructive.
		estimateContextWindowTokens(
			anthropicBody as unknown as Record<string, unknown>,
		);

		expect(anthropicBody).toEqual(before);
	});
});

/**
 * The shape production actually sends. Codex CLI returns a screenshot as the
 * OUTPUT OF A TOOL CALL, and that output is an ARRAY of Responses content items
 * rather than the JSON string the type claims:
 *
 *   {type:"function_call_output", call_id, output:[
 *     {type:"input_text",  text:"Script completed…"},
 *     {type:"input_image", image_url:"data:image/png;base64,…"}]}
 *
 * The message-attached case above was already handled; this one was not. The
 * untranslated `input_image` blocks landed inside an Anthropic `tool_result`,
 * where the measurement walk could not recognise them, so 668k base64 chars were
 * priced as prompt text and a ~76k-token request estimated at 430,847 — past
 * gpt-5.6-sol's 353k window, with no other backend eligible for Codex CLI
 * traffic.
 */
function responsesRequestWithToolResultImages(): ResponsesRequest & {
	input: NonNullable<Exclude<ResponsesRequest["input"], string>>;
} {
	return {
		model: "gpt-5.6-sol",
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: PROMPT_TEXT }],
			},
			{
				type: "function_call",
				call_id: "call_shell_1",
				name: "shell",
				arguments: '{"command":"adb exec-out screencap -p > /tmp/a.png"}',
			},
			{
				type: "function_call_output",
				call_id: "call_shell_1",
				output: [
					{ type: "input_text", text: "Script completed\nWall time 0.0s" },
					{
						type: "input_image",
						image_url: `data:image/png;base64,${TOOL_IMAGE_SMALL_BASE64}`,
					},
				],
			} as unknown as NonNullable<
				Exclude<ResponsesRequest["input"], string>
			>[number],
			{
				type: "function_call",
				call_id: "call_view_1",
				name: "view_image",
				arguments: '{"path":"/tmp/a.png"}',
			},
			{
				type: "function_call_output",
				call_id: "call_view_1",
				output: [
					{ type: "input_text", text: "Viewed Image" },
					{
						type: "input_image",
						image_url: `data:image/png;base64,${TOOL_IMAGE_LARGE_BASE64}`,
					},
				],
			} as unknown as NonNullable<
				Exclude<ResponsesRequest["input"], string>
			>[number],
		],
	};
}

describe("screenshot attached as a tool RESULT (the production shape)", () => {
	it("translates nested Responses content items into Anthropic blocks", () => {
		const anthropicBody = translateRequestToAnthropic(
			responsesRequestWithToolResultImages(),
		);

		const toolResults = anthropicBody.messages
			.flatMap((m) => m.content)
			.filter((block) => block.type === "tool_result");
		expect(toolResults).toHaveLength(2);

		for (const result of toolResults) {
			// An `input_image` reaching the Anthropic body untranslated is the bug:
			// it is not a shape the measurement walk — or a real Anthropic-compatible
			// backend — knows how to read.
			const nested = result.content;
			expect(Array.isArray(nested)).toBe(true);
			const types = (nested as { type: string }[]).map((b) => b.type);
			expect(types).toEqual(["text", "image"]);
		}
	});

	it("prices the nested screenshots per-image, not by their base64 size", () => {
		const anthropicBody = translateRequestToAnthropic(
			responsesRequestWithToolResultImages(),
		);

		const { composition } = computeContextAndToolStats(
			anthropicBody as unknown as Parameters<
				typeof computeContextAndToolStats
			>[0],
		);
		expect(composition).not.toBeNull();
		expect(composition?.imageCount).toBe(2);
		expect(composition?.imagePayloadChars).toBe(
			TOOL_IMAGE_SMALL_BASE64.length + TOOL_IMAGE_LARGE_BASE64.length,
		);

		const estimate = estimateContextWindowTokens(
			anthropicBody as unknown as Record<string, unknown>,
			composition,
		);

		// Measured: 54,848. Counting the base64 as prompt text instead adds
		// 667,968/3 and lands at 277,504 (production saw 430,847 for a slightly
		// larger conversation of this shape). The band is deliberately tight in
		// BOTH directions — an estimate that collapses toward the floor would mean
		// the attachments stopped being counted at all, which admits a request to
		// an account it does not fit. That is the same failure as the one being
		// fixed here, just with the sign flipped.
		expect(estimate).toBeGreaterThan(50_000);
		expect(estimate).toBeLessThan(60_000);
		expect(
			codexAccountFitsRequest(codexAccount(), "claude-opus-4-8", estimate),
		).toBe(true);
	});

	it("counts a url-source image in a tool result as an image too", () => {
		// Only a data: URL carries a payload to strip; a bare URL has none. It must
		// still register as an attachment so it draws the flat per-image allowance
		// rather than being priced as the ~40 chars of its own JSON.
		const anthropicBody = translateRequestToAnthropic({
			model: "gpt-5.6-sol",
			input: [
				{
					type: "function_call_output",
					call_id: "call_url",
					output: [
						{ type: "input_image", image_url: "https://example.com/shot.png" },
					],
				} as unknown as NonNullable<
					Exclude<ResponsesRequest["input"], string>
				>[number],
			],
		});

		const { composition } = computeContextAndToolStats(
			anthropicBody as unknown as Parameters<
				typeof computeContextAndToolStats
			>[0],
		);
		expect(composition?.imageCount).toBe(1);
		expect(composition?.imagePayloadChars).toBe(0);
	});

	it("leaves a plain string tool output exactly as it was", () => {
		const anthropicBody = translateRequestToAnthropic({
			model: "gpt-5.6-sol",
			input: [
				{
					type: "function_call_output",
					call_id: "call_1",
					output: "ordinary text result",
				},
			],
		});

		expect(anthropicBody.messages[0].content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "call_1",
				content: "ordinary text result",
			},
		]);
	});
});
