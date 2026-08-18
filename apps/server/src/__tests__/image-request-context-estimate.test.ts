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
