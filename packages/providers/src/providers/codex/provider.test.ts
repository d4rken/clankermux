import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { OAuthRefreshTokenError } from "@clankermux/core";
import {
	NATIVE_RESPONSES_REQUEST_HEADER,
	NATIVE_RESPONSES_RESPONSE_HEADER,
} from "@clankermux/types";
import { CodexProvider } from "./provider";
import { normalizeCodexInputUsage, parseCodexUsageHeaders } from "./usage";

const sseBody = (lines: string[]) => `${lines.join("\n")}\n`;
const eventLine = (name: string, data: unknown) => [
	`event: ${name}`,
	`data: ${typeof data === "string" ? data : JSON.stringify(data)}`,
	"",
];

describe("CodexProvider request conversion", () => {
	it("handles /v1/messages and /v1/messages/count_tokens paths", () => {
		const provider = new CodexProvider();
		expect(provider.canHandle("/v1/messages")).toBeTrue();
		expect(provider.canHandle("/v1/messages/count_tokens")).toBeTrue();
		expect(provider.canHandle("/v1/other")).toBeFalse();
	});

	it("forwards Claude reasoning effort to Codex reasoning.effort", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				reasoning: { effort: "high" },
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.reasoning).toEqual({ effort: "high" });
	});

	it("adds a continuation nudge after Skill tool results", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [
					{ role: "user", content: "load /ce-plan" },
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_skill_1",
								name: "Skill",
								input: { skill: "ce-plan" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "call_skill_1",
								content: [{ type: "text", text: "Successfully loaded skill" }],
							},
						],
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.input).toContainEqual({
			role: "user",
			content: [
				{
					type: "input_text",
					text: "The requested Skill tool has loaded additional instructions. Continue the user's original request now, applying those instructions. Do not wait for another user message.",
				},
			],
		});
	});

	it("does not add a continuation nudge after non-Skill tool results", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [
					{ role: "user", content: "search" },
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_search_1",
								name: "WebSearch",
								input: { query: "news" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "call_search_1",
								content: [{ type: "text", text: "results" }],
							},
						],
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(JSON.stringify(body.input)).not.toContain(
			"Continue the user's original request now",
		);
	});

	it("does not inject a Skill continuation nudge into replayed mid-history", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [
					{ role: "user", content: "load /ce-plan" },
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_skill_1",
								name: "Skill",
								input: { skill: "ce-plan" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "call_skill_1",
								content: [{ type: "text", text: "Successfully loaded skill" }],
							},
						],
					},
					{ role: "assistant", content: "I will apply the plan skill." },
					{ role: "user", content: "continue" },
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(JSON.stringify(body.input)).not.toContain(
			"Continue the user's original request now",
		);
	});

	it("does not nudge when a block follows the Skill tool_result in the final message", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [
					{ role: "user", content: "load /ce-plan" },
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_skill_1",
								name: "Skill",
								input: { skill: "ce-plan" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "call_skill_1",
								content: [{ type: "text", text: "Successfully loaded skill" }],
							},
							{ type: "text", text: "actually, do something else" },
						],
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(JSON.stringify(body.input)).not.toContain(
			"Continue the user's original request now",
		);
	});

	it("adds a continuation nudge when the Skill tool_use and result span separate messages", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [
					{ role: "user", content: "load /ce-plan" },
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_skill_1",
								name: "Skill",
								input: { skill: "ce-plan" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "call_skill_1",
								content: [{ type: "text", text: "Successfully loaded skill" }],
							},
						],
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		// The nudge must be the final item so Codex resumes the request.
		expect(body.input[body.input.length - 1]).toEqual({
			role: "user",
			content: [
				{
					type: "input_text",
					text: "The requested Skill tool has loaded additional instructions. Continue the user's original request now, applying those instructions. Do not wait for another user message.",
				},
			],
		});
	});

	it("does not nudge for an orphaned Skill tool_result with no matching tool_use", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [
					{ role: "user", content: "hello" },
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "call_unknown_1",
								content: [{ type: "text", text: "Successfully loaded skill" }],
							},
						],
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(JSON.stringify(body.input)).not.toContain(
			"Continue the user's original request now",
		);
	});

	it("forwards xhigh reasoning effort to Codex unchanged", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				reasoning: { effort: "xhigh" },
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.reasoning).toEqual({ effort: "xhigh" });
	});

	it("uses role-appropriate text block types in Codex input", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				messages: [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: "hi" },
					{ role: "developer", content: "follow policy" },
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.input[0]).toEqual({
			role: "user",
			content: [{ type: "input_text", text: "hello" }],
		});
		expect(body.input[1]).toEqual({
			role: "assistant",
			content: [{ type: "output_text", text: "hi" }],
		});
		expect(body.input[2]).toEqual({
			role: "system",
			content: [{ type: "input_text", text: "follow policy" }],
		});
	});

	it("marks replayed tool call items as completed", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_1",
								name: "search",
								input: { query: "hello" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "call_1",
								content: [{ type: "text", text: "result" }],
							},
						],
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.input[0]).toMatchObject({
			type: "function_call",
			call_id: "call_1",
			name: "search",
			arguments: JSON.stringify({ query: "hello" }),
			status: "completed",
		});
		expect(body.input[1]).toMatchObject({
			type: "function_call_output",
			call_id: "call_1",
			output: "result",
			status: "completed",
		});
	});

	it("keeps default Codex reasoning effort when Claude effort is absent", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.reasoning).toEqual({ effort: "medium" });
	});

	it("uses role-specific text item types for multi-turn history", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				messages: [
					{ role: "user", content: "Question" },
					{ role: "system", content: "Keep answers brief." },
					{
						role: "assistant",
						content: [{ type: "text", text: "Previous answer" }],
					},
					{ role: "user", content: "Follow-up" },
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.input[1].role).toBe("system");
		expect(body.input[1].content).toEqual([
			{ type: "input_text", text: "Keep answers brief." },
		]);
		expect(body.input[2].role).toBe("assistant");
		expect(body.input[2].content).toEqual([
			{ type: "output_text", text: "Previous answer" },
		]);
	});

	it("rejects unsupported reasoning effort values", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				reasoning: { effort: "extreme" },
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		await expect(provider.transformRequestBody(request)).rejects.toThrow(
			"reasoning.effort must be one of: minimal, low, medium, high, xhigh, max",
		);
	});

	it("downgrades efforts unsupported by the mapped Codex model", async () => {
		const provider = new CodexProvider();
		const account = {
			model_mappings: JSON.stringify({ sonnet: "gpt-5.4-mini" }),
		} as Parameters<typeof provider.transformRequestBody>[1];

		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				reasoning: { effort: "xhigh" },
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, account);
		const body = await transformed.json();
		expect(body.reasoning).toEqual({ effort: "medium" });
	});

	it("omits empty Read.pages when replaying Anthropic history to Codex", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_read_1",
								name: "Read",
								input: {
									file_path: "/tmp/full.diff",
									offset: 0,
									limit: 2000,
									pages: "",
								},
							},
						],
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.input[0]).toMatchObject({
			type: "function_call",
			call_id: "call_read_1",
			name: "Read",
		});
		expect(JSON.parse(body.input[0].arguments)).toEqual({
			file_path: "/tmp/full.diff",
			offset: 0,
			limit: 2000,
		});
	});

	it("normalizes stored WebSearch tool_use input when replaying Anthropic history to Codex", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_search_1",
								name: "WebSearch",
								input: {
									query: "latest earnings",
									allowed_domains: [" investors.example.com ", ""],
									blocked_domains: ["spam.example.com"],
								},
							},
						],
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.input[0]).toMatchObject({
			type: "function_call",
			call_id: "call_search_1",
			name: "WebSearch",
		});
		expect(JSON.parse(body.input[0].arguments)).toEqual({
			query: "latest earnings",
			allowed_domains: ["investors.example.com"],
		});
	});

	it("preserves falsy non-object tool_use input when replaying Anthropic history to Codex", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_generic_1",
								name: "generic_tool",
								input: "",
							},
							{
								type: "tool_use",
								id: "call_generic_2",
								name: "generic_tool",
								input: null,
							},
						],
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.input[0]).toMatchObject({
			type: "function_call",
			call_id: "call_generic_1",
			name: "generic_tool",
		});
		expect(body.input[0].arguments).toBe('""');
		expect(body.input[1]).toMatchObject({
			type: "function_call",
			call_id: "call_generic_2",
			name: "generic_tool",
		});
		expect(body.input[1].arguments).toBe("null");
	});
});

describe("CodexProvider.processResponse", () => {
	it("buffers tool-call arguments and emits them once before content_block_stop", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"query":"hel',
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: 'lo"}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();

		expect(
			transformedBody.match(/event: content_block_delta/g)?.length ?? 0,
		).toBe(1);
		expect(transformedBody).toContain('"index":0');
		expect(transformedBody).toContain(
			'"partial_json":"{\\"query\\":\\"hello\\"}"',
		);
		const deltaPos = transformedBody.indexOf("event: content_block_delta");
		const stopPos = transformedBody.indexOf("event: content_block_stop");
		expect(deltaPos).toBeGreaterThanOrEqual(0);
		expect(stopPos).toBeGreaterThan(deltaPos);
		expect(transformedBody).toContain('"stop_reason":"tool_use"');
	});

	it("emits tool_use stop_reason from the EOF fallback when upstream omits response.completed", async () => {
		const provider = new CodexProvider();
		// No response.completed event: the stream ends after the tool call, so the
		// end-of-stream fallback terminal message_delta must report tool_use.
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"query":"hello"}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();

		expect(transformedBody).toContain("event: message_delta");
		expect(transformedBody).toContain('"stop_reason":"tool_use"');
		expect(transformedBody).not.toContain('"stop_reason":"end_turn"');
		expect(transformedBody).toContain("event: message_stop");
	});

	it("uses the function_call block index rather than the current text block index", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 1,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "hello" }),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"query":"hel',
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: 'lo"}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const deltaLine = transformedBody
			.split("\n")
			.find(
				(line) =>
					line.includes('"type":"content_block_delta"') &&
					line.includes('"input_json_delta"'),
			);

		expect(deltaLine).not.toBeUndefined();
		expect(deltaLine).toContain('"index":0');
		expect(deltaLine).toContain('"partial_json":"{\\"query\\":\\"hello\\"}"');
	});

	it("does not emit premature content_block_stop for function-call when text block opens concurrently", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 1,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "hello" }),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"q":1}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const events = transformedBody
			.split("\n")
			.filter((l) => l.startsWith("data:"))
			.map(
				(l) =>
					JSON.parse(l.slice("data:".length).trim()) as Record<string, unknown>,
			);

		// Collect events for block index 0 in order
		const block0Events = events
			.filter(
				(e) =>
					(e.type === "content_block_start" ||
						e.type === "content_block_stop" ||
						e.type === "content_block_delta") &&
					(e.index === 0 ||
						(e.type === "content_block_start" &&
							(e.content_block as Record<string, unknown>)?.type ===
								"tool_use")),
			)
			.map((e) => e.type);

		// Must be: start → delta → stop (no premature stop before delta)
		expect(block0Events).toEqual([
			"content_block_start",
			"content_block_delta",
			"content_block_stop",
		]);

		// Text block (index 1) must come after function-call block opens
		const block1Start = events.findIndex(
			(e) => e.type === "content_block_start" && e.index === 1,
		);
		const block0Stop = events.findIndex(
			(e) => e.type === "content_block_stop" && e.index === 0,
		);
		expect(block1Start).toBeGreaterThan(-1);
		expect(block0Stop).toBeGreaterThan(block1Start);
	});

	it("includes input_tokens when model metadata is unavailable", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "unknown-model" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "unknown-model",
					usage: {
						input_tokens: 12,
						output_tokens: 3,
						input_tokens_details: { cached_tokens: 4 },
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageDeltaLine).not.toBeUndefined();
		expect(messageDeltaLine).not.toContain('"context_window"');
		expect(messageDeltaLine).toContain('"usage":{');
		expect(messageDeltaLine).toContain('"output_tokens":3');
		// Codex's input_tokens (12) is cache-inclusive; Anthropic's input_tokens
		// is additive and excludes the 4 cached tokens, which are reported
		// separately as cache_read_input_tokens.
		expect(messageDeltaLine).toContain('"input_tokens":8');
		expect(messageDeltaLine).toContain('"cache_read_input_tokens":4');
	});

	it("translates cached input usage additively so input_tokens excludes cache reads", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.3-codex" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.3-codex",
					usage: {
						input_tokens: 100,
						output_tokens: 20,
						input_tokens_details: { cached_tokens: 30 },
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"')) as string;
		const payload = JSON.parse(messageDeltaLine.slice("data: ".length));

		expect(payload.usage.cache_read_input_tokens).toBe(30);
		expect(payload.usage.input_tokens).toBe(70);
		// The additive input_tokens plus the cache read must reconstruct the
		// original cache-inclusive total Codex reported.
		expect(
			payload.usage.input_tokens + payload.usage.cache_read_input_tokens,
		).toBe(100);
	});

	it("normalizes message_delta usage and delta defaults when missing", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 5, output_tokens: 2 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageDeltaLine).not.toBeUndefined();
		const dataPrefix = "data: ";
		expect(messageDeltaLine?.startsWith(dataPrefix)).toBeTrue();
		const payload = JSON.parse(
			(messageDeltaLine as string).slice(dataPrefix.length),
		);
		expect(payload.usage.input_tokens).toBe(5);
		expect(payload.usage.output_tokens).toBe(2);
		expect(payload.usage.cache_read_input_tokens).toBe(0);
		expect(payload.usage.cache_creation_input_tokens).toBe(0);
		expect(payload.delta.stop_reason).toBe("end_turn");
		expect(payload.delta.stop_sequence).toBe(null);
	});

	it("successful JSON responses pass through unchanged", async () => {
		const provider = new CodexProvider();
		const body = JSON.stringify({
			type: "message",
			message: { role: "assistant", content: [] },
		});
		const response = new Response(body, {
			status: 200,
			headers: { "content-type": "application/json" },
		});

		const transformed = await provider.processResponse(response, null);
		expect(transformed.headers.get("content-type")).toContain(
			"application/json",
		);
		expect(await transformed.text()).toBe(body);
	});

	it("returns Anthropic JSON for non-streaming requests when upstream returns SSE", async () => {
		const provider = new CodexProvider();
		const requestId = "req_non_stream_1";
		const originalRequest = new Request("https://example.test/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-clankermux-request-id": requestId,
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				max_tokens: 16,
				stream: false,
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			}),
		});
		await provider.transformRequestBody(originalRequest);

		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 0,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "Hi" }),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 7, output_tokens: 2 },
				},
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-clankermux-request-id": requestId,
				"x-clankermux-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		expect(transformed.headers.get("content-type")).toContain(
			"application/json",
		);
		const payload = JSON.parse(await transformed.text()) as Record<
			string,
			unknown
		>;
		expect(payload.type).toBe("message");
		expect(payload.role).toBe("assistant");
		expect(payload.content).toEqual([{ type: "text", text: "Hi" }]);
		expect(payload.usage).toEqual({
			input_tokens: 7,
			output_tokens: 2,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		});
	});

	it("preserves tool_use content in non-streaming SSE->JSON conversion", async () => {
		const provider = new CodexProvider();
		const requestId = "req_non_stream_tool_1";
		const originalRequest = new Request("https://example.test/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-clankermux-request-id": requestId,
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				max_tokens: 16,
				stream: false,
				tools: [
					{
						name: "search",
						description: "search",
						input_schema: {
							type: "object",
							properties: { query: { type: "string" } },
						},
					},
				],
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			}),
		});
		await provider.transformRequestBody(originalRequest);

		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_tool", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"query":"hel',
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: 'lo"}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 9, output_tokens: 4 },
				},
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-clankermux-request-id": requestId,
				"x-clankermux-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const payload = JSON.parse(await transformed.text()) as Record<
			string,
			unknown
		>;
		expect(payload.content).toEqual([
			{
				type: "tool_use",
				id: "call_1",
				name: "search",
				input: { query: "hello" },
			},
		]);
		expect(payload.stop_reason).toBe("tool_use");
	});

	it("maps response.completed usage into Claude-compatible context_window using model metadata", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.3-codex-spark" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.3-codex-spark",
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						input_tokens_details: {
							cached_tokens: 25,
							cache_creation_input_tokens: 10,
						},
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageDeltaLine).toContain('"context_window"');
		expect(messageDeltaLine).toContain('"cache_read_input_tokens":25');
		expect(messageDeltaLine).toContain('"cache_creation_input_tokens":10');
		expect(messageDeltaLine).toContain('"context_window_size":128000');
	});

	it("synthesizes context_window for a dated model via the family-window fallback", async () => {
		const provider = new CodexProvider();
		// The Codex backend returns a dated variant of a known model. Routing
		// already resolves the dated suffix; the response-side context_window
		// synthesis must too, so the client gauge / compaction signal is present.
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.6-sol-2026-05-13" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.6-sol-2026-05-13",
					usage: {
						input_tokens: 100,
						output_tokens: 50,
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageDeltaLine).toContain('"context_window"');
		expect(messageDeltaLine).toContain('"context_window_size":353000');
	});

	it("omits context_window when model metadata is unavailable", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "unknown-model" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "unknown-model",
					usage: {
						input_tokens: 12,
						output_tokens: 3,
						input_tokens_details: { cached_tokens: 4 },
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageDeltaLine).not.toContain('"context_window"');
		expect(messageDeltaLine).toContain('"output_tokens":3');
	});

	it("fallback message_start includes top-level usage", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 0,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "hello" }),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageStartLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_start"'));
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageStartLine).not.toBeUndefined();
		const payload = JSON.parse(
			(messageStartLine as string).slice("data: ".length),
		);
		expect(payload.usage.input_tokens).toBe(0);
		expect(payload.usage.output_tokens).toBe(0);
		expect(payload.usage.cache_read_input_tokens).toBe(0);
		expect(payload.usage.cache_creation_input_tokens).toBe(0);
		expect(payload.message.usage.input_tokens).toBe(0);
		expect(payload.message.usage.output_tokens).toBe(0);
		expect(messageDeltaLine).not.toBeUndefined();
		expect(messageDeltaLine).toContain('"usage":{');
		expect(messageDeltaLine).toContain('"input_tokens":0');
		expect(messageDeltaLine).toContain('"output_tokens":0');
		expect(messageDeltaLine).toContain(
			'"delta":{"stop_reason":"end_turn","stop_sequence":null,"usage":{',
		);
	});

	it("includes cache_creation_input_tokens in synthesized context_window when present", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.5" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.5",
					usage: {
						input_tokens: 42,
						output_tokens: 7,
						input_tokens_details: {
							cached_tokens: 5,
							cache_creation_input_tokens: 9,
						},
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageDeltaLine).not.toBeUndefined();
		expect(messageDeltaLine).toContain('"cache_creation_input_tokens":9');
		expect(messageDeltaLine).toContain('"context_window"');
		expect(messageDeltaLine).toContain('"context_window_size":272000');
	});

	it("treats successful missing-content-type SSE bodies as streams", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 0,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "hello" }),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 2, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: {},
		});

		const transformed = await provider.processResponse(response, null);
		expect(transformed.headers.get("content-type")).toContain(
			"text/event-stream",
		);
		const transformedBody = await transformed.text();
		expect(transformedBody).toContain("event: message_start");
		expect(transformedBody).toContain("event: message_delta");
		expect(transformedBody).toContain(
			'"usage":{"input_tokens":2,"output_tokens":1',
		);
	});

	it("passes through successful missing-content-type unknown bodies", async () => {
		const provider = new CodexProvider();
		const response = new Response("ok", {
			status: 200,
			headers: {},
		});

		const transformed = await provider.processResponse(response, null);
		expect(transformed.headers.get("content-type")).toBeNull();
		expect(await transformed.text()).toBe("ok");
	});

	it("returns Anthropic JSON for non-streaming missing-content-type SSE bodies", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 0,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "hello" }),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 2, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "x-clankermux-request-stream": "false" },
		});

		const transformed = await provider.processResponse(response, null);
		expect(transformed.headers.get("content-type")).toContain(
			"application/json",
		);
		const payload = await transformed.json();
		expect(payload.content).toEqual([{ type: "text", text: "hello" }]);
		expect(payload.usage).toEqual({
			input_tokens: 2,
			output_tokens: 1,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		});
	});

	it("surfaces Codex SSE errors instead of fabricating an empty streaming success", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_failed", model: "gpt-5.5" },
			}),
			...eventLine("response.failed", {
				response: {
					status: "failed",
					error: {
						type: "invalid_request_error",
						code: "context_length_exceeded",
						message: "Input is too large",
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();

		expect(transformedBody).toContain("event: error");
		expect(transformedBody).toContain("Input is too large");
		expect(transformedBody).toContain("context_length_exceeded");
		expect(transformedBody).not.toContain("event: message_delta");
		expect(transformedBody).not.toContain("event: message_stop");
	});

	it("does not emit terminal events when response.completed arrives after response.failed", async () => {
		const provider = new CodexProvider();
		// A malformed upstream stream: response.failed sets the terminal/error
		// state, then a stray response.completed follows. The completed handler
		// must NOT append message_delta/message_stop after the error terminal —
		// that would be an invalid SSE sequence (terminal events after an error).
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_failed", model: "gpt-5.5" },
			}),
			...eventLine("response.failed", {
				response: {
					status: "failed",
					error: {
						type: "invalid_request_error",
						code: "context_length_exceeded",
						message: "Input is too large",
					},
				},
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.5",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();

		expect(transformedBody).toContain("event: error");
		expect(transformedBody).toContain("Input is too large");
		expect(transformedBody).not.toContain("event: message_delta");
		expect(transformedBody).not.toContain("event: message_stop");
	});

	it("surfaces Codex SSE errors as JSON errors for non-streaming clients", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_failed", model: "gpt-5.5" },
			}),
			...eventLine("response.failed", {
				response: {
					status: "failed",
					error: {
						type: "invalid_request_error",
						message: "Codex failed",
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-clankermux-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.json();

		expect(transformed.status).toBe(400);
		expect(body).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "Codex failed",
			},
		});
	});

	it("maps non-streaming Codex context-window SSE errors to non-retryable bad requests", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_failed", model: "gpt-5.5" },
			}),
			...eventLine("error", {
				type: "error",
				code: "context_length_exceeded",
				message: "Input is too large",
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-clankermux-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.json();

		expect(transformed.status).toBe(400);
		expect(body).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "Input is too large",
				code: "context_length_exceeded",
			},
		});
	});

	it("passes through non-streaming error responses", async () => {
		const provider = new CodexProvider();
		const response = new Response('{"error":"bad_request"}', {
			status: 400,
			headers: { "content-type": "application/json" },
		});

		const processed = await provider.processResponse(response, null);

		expect(processed.status).toBe(400);
		expect(await processed.text()).toBe('{"error":"bad_request"}');
	});

	it("omits empty Read.pages from streaming tool-call arguments", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "Read" },
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"file_path":"/tmp/full.diff","offset":0,',
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '"limit":2000,"pages":""}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "Read" },
				output_index: 0,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();

		expect(transformedBody).toContain(
			'"partial_json":"{\\"file_path\\":\\"/tmp/full.diff\\",\\"offset\\":0,\\"limit\\":2000}"',
		);
		expect(transformedBody).not.toContain('\\"pages\\"');
	});

	it("omits invalid WebSearch domain filters from streaming tool-call arguments", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "WebSearch" },
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"query":"earnings","allowed_domains":[],',
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '"blocked_domains":[""]}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "WebSearch" },
				output_index: 0,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();

		expect(transformedBody).toContain(
			'"partial_json":"{\\"query\\":\\"earnings\\"}"',
		);
		expect(transformedBody).not.toContain("allowed_domains");
		expect(transformedBody).not.toContain("blocked_domains");
	});

	it("omits invalid WebSearch domain filters from non-streaming tool_use input", async () => {
		const provider = new CodexProvider();
		const requestId = "req_non_stream_websearch_domains";
		const originalRequest = new Request("https://example.test/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-clankermux-request-id": requestId,
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				max_tokens: 16,
				stream: false,
				tools: [
					{
						name: "WebSearch",
						description: "search",
						input_schema: {
							type: "object",
							properties: {
								allowed_domains: { type: "array", items: { type: "string" } },
								blocked_domains: { type: "array", items: { type: "string" } },
							},
						},
					},
				],
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			}),
		});
		await provider.transformRequestBody(originalRequest);

		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_tool", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "WebSearch" },
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta:
					'{"query":"earnings","allowed_domains":["reuters.com"],"blocked_domains":["seekingalpha.com"]}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "WebSearch" },
				output_index: 0,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 9, output_tokens: 4 },
				},
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-clankermux-request-id": requestId,
				"x-clankermux-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const payload = JSON.parse(await transformed.text()) as Record<
			string,
			unknown
		>;
		expect(payload.content).toEqual([
			{
				type: "tool_use",
				id: "call_1",
				name: "WebSearch",
				input: { query: "earnings", allowed_domains: ["reuters.com"] },
			},
		]);
	});

	it("preserves non-object tool arguments in non-streaming SSE-to-JSON conversion", async () => {
		const provider = new CodexProvider();
		const requestId = "req_non_stream_non_object_tool_input";
		const originalRequest = new Request("https://example.test/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-clankermux-request-id": requestId,
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				max_tokens: 16,
				stream: false,
				tools: [
					{
						name: "generic_tool",
						description: "generic",
						input_schema: { type: "object" },
					},
				],
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			}),
		});
		await provider.transformRequestBody(originalRequest);

		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_tool", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: {
					type: "function_call",
					call_id: "call_1",
					name: "generic_tool",
				},
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: "null",
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: {
					type: "function_call",
					call_id: "call_1",
					name: "generic_tool",
				},
				output_index: 0,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 9, output_tokens: 4 },
				},
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-clankermux-request-id": requestId,
				"x-clankermux-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const payload = JSON.parse(await transformed.text()) as Record<
			string,
			unknown
		>;
		expect(payload.content).toEqual([
			{
				type: "tool_use",
				id: "call_1",
				name: "generic_tool",
				input: null,
			},
		]);
	});
});

describe("CodexProvider upstream error code classification", () => {
	const errorForCode = async (code: string) => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("error", {
				type: "error",
				code,
				message: `Codex reported ${code}`,
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-clankermux-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const body = (await transformed.json()) as {
			error: { type: string; code?: string };
		};
		return { status: transformed.status, body };
	};

	it("maps rate_limit_exceeded to rate_limit_error / 429", async () => {
		const { status, body } = await errorForCode("rate_limit_exceeded");
		expect(body.error.type).toBe("rate_limit_error");
		expect(status).toBe(429);
	});

	it("maps insufficient_quota to rate_limit_error / 429", async () => {
		const { status, body } = await errorForCode("insufficient_quota");
		expect(body.error.type).toBe("rate_limit_error");
		expect(status).toBe(429);
	});

	it("maps server_is_overloaded to overloaded_error / 529", async () => {
		const { status, body } = await errorForCode("server_is_overloaded");
		expect(body.error.type).toBe("overloaded_error");
		expect(status).toBe(529);
	});

	it("maps slow_down to overloaded_error / 529", async () => {
		const { status, body } = await errorForCode("slow_down");
		expect(body.error.type).toBe("overloaded_error");
		expect(status).toBe(529);
	});

	it("maps context_length_exceeded to invalid_request_error / 400", async () => {
		const { status, body } = await errorForCode("context_length_exceeded");
		expect(body.error.type).toBe("invalid_request_error");
		expect(status).toBe(400);
	});

	it("maps cyber_policy to invalid_request_error / 400", async () => {
		const { status, body } = await errorForCode("cyber_policy");
		expect(body.error.type).toBe("invalid_request_error");
		expect(status).toBe(400);
	});

	it("maps usage_not_included to permission_error / 403", async () => {
		const { status, body } = await errorForCode("usage_not_included");
		expect(body.error.type).toBe("permission_error");
		expect(status).toBe(403);
	});

	it("maps server_error to api_error / 502", async () => {
		const { status, body } = await errorForCode("server_error");
		expect(body.error.type).toBe("api_error");
		expect(status).toBe(502);
	});

	it("keeps unknown codes on the 502 fallback (not miscategorized)", async () => {
		// Our tree echoes the raw upstream type when a code isn't in the map, so
		// the load-bearing regression is that an unrecognized code neither maps
		// to a retry-class Anthropic type nor changes the default 502 status.
		const { status, body } = await errorForCode("some_brand_new_code");
		expect(status).toBe(502);
		expect(
			[
				"rate_limit_error",
				"overloaded_error",
				"invalid_request_error",
				"permission_error",
			].includes(body.error.type),
		).toBe(false);
	});

	it("forces invalid_request_error / 400 for message-detected context overflow without a code", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.failed", {
				response: {
					status: "failed",
					error: {
						// Generic upstream type + no context_length_exceeded code:
						// only the message-regex fallback can force invalid_request_error.
						type: "api_error",
						message:
							"Your input exceeds the context window of this model. Please adjust your input and try again.",
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-clankermux-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const body = (await transformed.json()) as {
			error: { type: string; message: string };
		};

		expect(transformed.status).toBe(400);
		expect(body.error.type).toBe("invalid_request_error");
		expect(body.error.message).toBe(
			"Your input exceeds the context window of this model. Please adjust your input and try again.",
		);
	});
});

describe("CodexProvider.transformRequestBody", () => {
	it("maps sonnet-family models to the default Codex model", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(body.model).toBe("gpt-5.6-terra");
	});

	it("maps fable and mythos models to the top Codex tier", async () => {
		const provider = new CodexProvider();
		for (const model of ["claude-fable-5", "claude-mythos-5"]) {
			const request = new Request("https://example.com/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model,
					max_tokens: 10,
					messages: [{ role: "user", content: "hello" }],
				}),
			});

			const transformed = await provider.transformRequestBody(
				request,
				undefined,
			);
			const body = await transformed.json();

			expect(body.model).toBe("gpt-5.6-sol");
		}
	});

	it("uses account sonnet mapping for sonnet-family models", async () => {
		const provider = new CodexProvider();
		const account = {
			model_mappings: JSON.stringify({ sonnet: "gpt-5.3-codex-spark" }),
		} as Parameters<typeof provider.transformRequestBody>[1];
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, account);
		const body = await transformed.json();

		expect(body.model).toBe("gpt-5.3-codex-spark");
	});

	it("uses first model when account mapping value is an ordered array", async () => {
		const provider = new CodexProvider();
		const account = {
			model_mappings: JSON.stringify({
				sonnet: ["gpt-5.3-codex-spark", "gpt-5.4"],
			}),
		} as Parameters<typeof provider.transformRequestBody>[1];
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, account);
		const body = await transformed.json();

		expect(body.model).toBe("gpt-5.3-codex-spark");
	});

	it("uses default Codex mapping for families missing from account mappings", async () => {
		const provider = new CodexProvider();
		const account = {
			model_mappings: JSON.stringify({ sonnet: "gpt-5.3-codex-spark" }),
		} as Parameters<typeof provider.transformRequestBody>[1];
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-haiku",
				max_tokens: 10,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, account);
		const body = await transformed.json();

		expect(body.model).toBe("gpt-5.6-luna");
	});

	it("passes through unknown model names unchanged", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "gpt-5.4-mini",
				max_tokens: 10,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(body.model).toBe("gpt-5.4-mini");
	});
});

describe("CodexProvider prompt_cache_key derivation", () => {
	// Test files are excluded from typecheck, so a minimal account shape is fine.
	const codexAccount = (overrides: Record<string, unknown> = {}) =>
		({
			id: "codex-1",
			name: "codex-test",
			provider: "codex",
			api_key: null,
			refresh_token: null,
			access_token: null,
			expires_at: null,
			created_at: Date.now(),
			request_count: 0,
			total_requests: 0,
			priority: 20,
			model_mappings: null,
			custom_endpoint: null,
			...overrides,
		}) as unknown as Parameters<CodexProvider["transformRequestBody"]>[1];

	const transform = async (
		payload: Record<string, unknown>,
		account?: Parameters<CodexProvider["transformRequestBody"]>[1],
	) => {
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 10,
				metadata: {
					user_id: JSON.stringify({
						session_id: "11111111-1111-4111-8111-111111111111",
					}),
				},
				messages: [{ role: "user", content: "hello" }],
				...payload,
			}),
		});
		return new CodexProvider()
			.transformRequestBody(request, account)
			.then((r) => r.json());
	};

	it("attaches a conversation key by default (always-on) for OpenAI endpoints", async () => {
		// account === undefined resolves to the default chatgpt.com endpoint,
		// which is an OpenAI host, so the key is attached with no env flag.
		const noAccount = await transform({});
		const openaiAccount = await transform(
			{},
			codexAccount({ custom_endpoint: "https://api.openai.com/v1" }),
		);
		expect(noAccount.prompt_cache_key).toMatch(
			/^clankermux-convo-[0-9a-f]{45}$/,
		);
		expect(openaiAccount.prompt_cache_key).toMatch(
			/^clankermux-convo-[0-9a-f]{45}$/,
		);
	});

	it("omits prompt_cache_key for custom/self-hosted OpenAI-compatible endpoints", async () => {
		const body = await transform(
			{},
			codexAccount({
				custom_endpoint: "https://my-openai-proxy.example.com/v1",
			}),
		);
		expect(body.prompt_cache_key).toBeUndefined();
	});

	it("omits prompt_cache_key for malformed or absent session metadata", async () => {
		const noMeta = await transform({ metadata: { user_id: "not-json" } });
		expect(noMeta.prompt_cache_key).toBeUndefined();
		const badUuid = await transform({
			metadata: { user_id: JSON.stringify({ session_id: "not-a-uuid" }) },
		});
		expect(badUuid.prompt_cache_key).toBeUndefined();
		const absent = await transform({ metadata: undefined });
		expect(absent.prompt_cache_key).toBeUndefined();
	});

	it("conversation keys are stable across turns and distinct across conversations", async () => {
		const turn1 = await transform({
			system: "main loop system prompt",
			messages: [{ role: "user", content: "task A" }],
		});
		// Same conversation one turn later: identical first message, longer tail.
		const turn2 = await transform({
			system: "main loop system prompt",
			messages: [
				{ role: "user", content: "task A" },
				{ role: "assistant", content: "working on it" },
				{ role: "user", content: "continue" },
			],
		});
		// Sibling subagent: same session, different first message.
		const sibling = await transform({
			system: "main loop system prompt",
			messages: [{ role: "user", content: "task B" }],
		});

		expect(turn1.prompt_cache_key).toMatch(/^clankermux-convo-[0-9a-f]{45}$/);
		expect((turn1.prompt_cache_key as string).length).toBeLessThanOrEqual(64);
		expect(turn1.prompt_cache_key).not.toContain("11111111");
		expect(turn2.prompt_cache_key).toBe(turn1.prompt_cache_key);
		expect(sibling.prompt_cache_key).not.toBe(turn1.prompt_cache_key);
	});

	it("keeps the same key when only instructions differ (system prompt is volatile)", async () => {
		// Claude Code's system prompt embeds volatile content (current date, cwd,
		// git-status snapshot), so instructions must NOT participate in the key —
		// otherwise the key re-shards mid-conversation (midnight rollover, a new
		// commit) and splits the cache. Same session + same first input with
		// DIFFERENT instructions must yield the SAME key.
		const first = await transform({
			system: "main loop system prompt @ 2026-07-15",
			messages: [{ role: "user", content: "task A" }],
		});
		const laterSameConvo = await transform({
			system: "main loop system prompt @ 2026-07-16 (new commit abc123)",
			messages: [{ role: "user", content: "task A" }],
		});
		expect(first.prompt_cache_key).toMatch(/^clankermux-convo-[0-9a-f]{45}$/);
		expect(laterSameConvo.prompt_cache_key).toBe(first.prompt_cache_key);
	});

	it("differing session ids produce differing keys, case-insensitively", async () => {
		const withSession = (sessionId: string) =>
			transform({
				metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
			});
		const lower = await withSession("11111111-1111-4111-8111-111111111111");
		const upper = await withSession(
			"11111111-1111-4111-8111-111111111111".toUpperCase(),
		);
		const different = await withSession("22222222-2222-4222-8222-222222222222");
		expect(upper.prompt_cache_key).toBe(lower.prompt_cache_key);
		expect(different.prompt_cache_key).not.toBe(lower.prompt_cache_key);
	});
});

describe("CodexProvider native Responses passthrough", () => {
	const nativeBody = {
		model: "gpt-5.5-codex",
		instructions: "Be brief.",
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Hi" }],
			},
		],
		tools: [
			{ type: "web_search" },
			{ type: "function", name: "lookup", parameters: { type: "object" } },
		],
		tool_choice: "auto",
		parallel_tool_calls: false,
		reasoning: { effort: "low" },
		previous_response_id: "resp_prev",
		store: true,
		stream: false,
	};

	function makeNativeRequest(extraHeaders: Record<string, string> = {}) {
		return new Request("https://chatgpt.com/backend-api/codex/responses", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[NATIVE_RESPONSES_REQUEST_HEADER]: "1",
				...extraHeaders,
			},
			body: JSON.stringify(nativeBody),
		});
	}

	const rawCodexSse = sseBody([
		...eventLine("response.created", {
			response: { id: "resp_1", model: "gpt-5.5-codex" },
		}),
		...eventLine("response.output_text.delta", { delta: "Hello" }),
		...eventLine("response.completed", {
			response: {
				model: "gpt-5.5-codex",
				usage: { input_tokens: 1, output_tokens: 1 },
			},
		}),
	]);

	it("forwards a native-flagged body with ONLY the 3 patches applied", async () => {
		const provider = new CodexProvider();
		const transformed = await provider.transformRequestBody(
			makeNativeRequest(),
			undefined,
		);
		const body = await transformed.json();

		// The 3 patches: stream forced, store forced, previous_response_id dropped.
		expect(body.stream).toBe(true);
		expect(body.store).toBe(false);
		expect("previous_response_id" in body).toBe(false);

		// Everything else is forwarded verbatim — no Anthropic→Codex translation,
		// no model mapping, built-in tool types survive.
		expect(body.model).toBe("gpt-5.5-codex");
		expect(body.instructions).toBe("Be brief.");
		expect(body.input).toEqual(nativeBody.input);
		expect(body.tools).toEqual(nativeBody.tools);
		expect(body.tool_choice).toBe("auto");
		expect(body.parallel_tool_calls).toBe(false);
		expect(body.reasoning).toEqual({ effort: "low" });

		// Stream-intent header parity with the normal path.
		expect(transformed.headers.get("x-clankermux-request-stream")).toBe("true");
		// The native flag stays on the transformed request so the proxy can relay
		// it onto the response for processResponse — the proxy strips it from the
		// outbound request before the upstream fetch, so it never reaches the
		// backend (see native-responses-passthrough.test.ts).
		expect(transformed.headers.get(NATIVE_RESPONSES_REQUEST_HEADER)).toBe("1");
	});

	it("parse-failure fallback strips the native flag so the response can never be mis-marked native", async () => {
		const provider = new CodexProvider();
		const request = new Request(
			"https://chatgpt.com/backend-api/codex/responses",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					[NATIVE_RESPONSES_REQUEST_HEADER]: "1",
				},
				body: "{not json",
			},
		);

		const transformed = await provider.transformRequestBody(request, undefined);

		// The flag is gone — the proxy's relay read sees a non-native request.
		expect(transformed.headers.get(NATIVE_RESPONSES_REQUEST_HEADER)).toBeNull();
		// Body forwarded unchanged (defensive; the proxy validates the native
		// body before setting the flag, so this branch should never fire).
		expect(await transformed.text()).toBe("{not json");
	});

	it("non-flagged request still runs the Anthropic→Codex translation", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [{ role: "user", content: "hello" }],
				tools: [{ name: "lookup", input_schema: { type: "object" } }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(body.model).toBe("gpt-5.6-terra");
		expect(body.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "hello" }] },
		]);
		expect(body.tools).toEqual([
			{
				type: "function",
				name: "lookup",
				description: undefined,
				parameters: { type: "object" },
			},
		]);
	});

	it("processResponse returns the raw Codex SSE untransformed with the marker (response flag)", async () => {
		const provider = new CodexProvider();
		const response = new Response(rawCodexSse, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-clankermux-request-id": "req-native-1",
				"x-clankermux-request-stream": "true",
				[NATIVE_RESPONSES_REQUEST_HEADER]: "1",
			},
		});

		const out = await provider.processResponse(response, null);
		const text = await out.text();

		// Body identical to upstream — no Anthropic events synthesized.
		expect(text).toBe(rawCodexSse);
		expect(text).not.toContain("message_start");
		// Stage B marker present; internal headers sanitized away.
		expect(out.headers.get(NATIVE_RESPONSES_RESPONSE_HEADER)).toBe("1");
		expect(out.headers.get("x-clankermux-request-id")).toBeNull();
		expect(out.headers.get(NATIVE_RESPONSES_REQUEST_HEADER)).toBeNull();
	});

	it("processResponse sets the SSE content-type when the upstream omits it (live backend quirk)", async () => {
		// The real Codex backend frequently returns SSE WITHOUT a content-type
		// header (the translated path's sniffing fix-up exists for exactly this).
		// The native branch must apply the same fix-up — without it the proxy's
		// isStreamingResponse() check fails, the response takes the non-stream
		// path, and SSE usage collection never runs (live bug: request recorded
		// with no model/tokens).
		const provider = new CodexProvider();
		const response = new Response(rawCodexSse, {
			status: 200,
			headers: {
				// NO content-type — mirrors the live backend.
				"x-clankermux-request-id": "req-native-ct",
				"x-clankermux-request-stream": "true",
				[NATIVE_RESPONSES_REQUEST_HEADER]: "1",
			},
		});

		const out = await provider.processResponse(response, null);

		expect(out.headers.get("content-type")).toContain("text/event-stream");
		expect(out.headers.get(NATIVE_RESPONSES_RESPONSE_HEADER)).toBe("1");
		expect(await out.text()).toBe(rawCodexSse);
	});

	it("processResponse falls back to the requestStreamById native entry", async () => {
		const provider = new CodexProvider();
		// Register the native entry via the request-side transform (request-id set).
		await provider.transformRequestBody(
			makeNativeRequest({ "x-clankermux-request-id": "req-native-2" }),
			undefined,
		);

		// Response carries the request id but NOT the relayed native flag header.
		const response = new Response(rawCodexSse, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-clankermux-request-id": "req-native-2",
			},
		});

		const out = await provider.processResponse(response, null);
		expect(out.headers.get(NATIVE_RESPONSES_RESPONSE_HEADER)).toBe("1");
		expect(await out.text()).toBe(rawCodexSse);
	});

	it("processResponse keeps the existing error path for non-200 native responses", async () => {
		const provider = new CodexProvider();
		const errorBody = JSON.stringify({
			error: { type: "rate_limit_error", message: "slow down" },
		});
		const response = new Response(errorBody, {
			status: 429,
			headers: {
				"content-type": "application/json",
				"x-clankermux-request-id": "req-native-3",
				[NATIVE_RESPONSES_REQUEST_HEADER]: "1",
			},
		});

		const out = await provider.processResponse(response, null);

		expect(out.status).toBe(429);
		expect(out.headers.get(NATIVE_RESPONSES_RESPONSE_HEADER)).toBeNull();
		expect(await out.text()).toBe(errorBody);
	});

	it("processResponse still transforms non-native Codex SSE to Anthropic events", async () => {
		const provider = new CodexProvider();
		const response = new Response(rawCodexSse, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-clankermux-request-stream": "true",
			},
		});

		const out = await provider.processResponse(response, null);
		const text = await out.text();

		expect(text).toContain("message_start");
		expect(out.headers.get(NATIVE_RESPONSES_RESPONSE_HEADER)).toBeNull();
	});
});

describe("normalizeCodexInputUsage", () => {
	it("subtracts cached tokens from the cache-inclusive total", () => {
		const result = normalizeCodexInputUsage(100, 30);
		expect(result.totalInputTokens).toBe(100);
		expect(result.inputTokens).toBe(70);
		expect(result.cacheReadInputTokens).toBe(30);
	});

	it("treats a missing or non-numeric total as zero", () => {
		expect(normalizeCodexInputUsage(undefined, 5)).toEqual({
			totalInputTokens: 0,
			inputTokens: 0,
			cacheReadInputTokens: 0,
		});
		expect(normalizeCodexInputUsage(Number.NaN, 5)).toEqual({
			totalInputTokens: 0,
			inputTokens: 0,
			cacheReadInputTokens: 0,
		});
	});

	it("treats a missing or negative cached count as zero", () => {
		expect(normalizeCodexInputUsage(10, undefined)).toEqual({
			totalInputTokens: 10,
			inputTokens: 10,
			cacheReadInputTokens: 0,
		});
		expect(normalizeCodexInputUsage(10, -5)).toEqual({
			totalInputTokens: 10,
			inputTokens: 10,
			cacheReadInputTokens: 0,
		});
	});

	it("clamps a cached count larger than the total instead of going negative", () => {
		const result = normalizeCodexInputUsage(10, 25);
		expect(result.inputTokens).toBe(0);
		expect(result.cacheReadInputTokens).toBe(10);
	});
});

describe("CodexProvider response.incomplete stop reasons", () => {
	it("maps response.incomplete with a content_filter reason to a refusal stop_reason", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_incomplete", model: "gpt-5.5" },
			}),
			...eventLine("response.incomplete", {
				response: {
					model: "gpt-5.5",
					status: "incomplete",
					incomplete_details: { reason: "content_filter" },
					usage: { input_tokens: 3, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		expect(body).toContain('"stop_reason":"refusal"');
		expect(body).toContain("event: message_delta");
		expect(body).toContain("event: message_stop");
	});

	it("maps response.incomplete with a non-content_filter reason to max_tokens", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_incomplete", model: "gpt-5.5" },
			}),
			...eventLine("response.incomplete", {
				response: {
					model: "gpt-5.5",
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
					usage: { input_tokens: 3, output_tokens: 512 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		expect(body).toContain('"stop_reason":"max_tokens"');
	});

	it("treats a response.completed event carrying status incomplete the same as response.incomplete", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_incomplete", model: "gpt-5.5" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.5",
					status: "incomplete",
					incomplete_details: { reason: "unknown_future_reason" },
					usage: { input_tokens: 3, output_tokens: 10 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		expect(body).toContain('"stop_reason":"max_tokens"');
	});

	it("never resolves an incomplete response with a pending tool call to a success stop_reason", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_incomplete", model: "gpt-5.5" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.incomplete", {
				response: {
					model: "gpt-5.5",
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
					usage: { input_tokens: 3, output_tokens: 50 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		expect(body).not.toContain('"stop_reason":"tool_use"');
		expect(body).not.toContain('"stop_reason":"end_turn"');
		expect(body).toContain('"stop_reason":"max_tokens"');
	});
});

describe("parseCodexUsageHeaders", () => {
	it("normalizes primary and secondary codex quota headers", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "11",
			"x-codex-primary-window-minutes": "10080",
			"x-codex-primary-reset-at": "1775000000",
			"x-codex-secondary-used-percent": "4",
			"x-codex-secondary-window-minutes": "300",
			"x-codex-secondary-reset-at": "1774600000",
		});

		const usage = parseCodexUsageHeaders(headers);

		expect(usage).not.toBeNull();
		expect(usage?.five_hour).toEqual({
			utilization: 4,
			resets_at: new Date(1774600000 * 1000).toISOString(),
		});
		expect(usage?.seven_day).toEqual({
			utilization: 11,
			resets_at: new Date(1775000000 * 1000).toISOString(),
		});
	});

	it("treats zero secondary window as an empty placeholder", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "11",
			"x-codex-primary-window-minutes": "10080",
			"x-codex-primary-reset-at": "1775000000",
			"x-codex-secondary-used-percent": "0",
			"x-codex-secondary-window-minutes": "0",
			"x-codex-secondary-reset-at": "1774600000",
		});

		const usage = parseCodexUsageHeaders(headers);

		expect(usage).toEqual({
			five_hour: {
				utilization: 0,
				resets_at: new Date(1774600000 * 1000).toISOString(),
			},
			seven_day: {
				utilization: 11,
				resets_at: new Date(1775000000 * 1000).toISOString(),
			},
		});
	});

	it("returns null when no Codex usage headers are present", () => {
		expect(parseCodexUsageHeaders(new Headers())).toBeNull();
	});

	it("drops invalid reset timestamps instead of throwing", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "12",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": "1e309",
		});

		expect(parseCodexUsageHeaders(headers)).toEqual({
			five_hour: { utilization: 12, resets_at: null },
			seven_day: { utilization: 0, resets_at: null },
		});
	});
});

describe("parseCodexUsageHeaders reset-after handling", () => {
	it("uses the supplied base time for relative reset headers", () => {
		const baseTimeMs = Date.UTC(2026, 2, 27, 16, 0, 0);
		const headers = new Headers({
			"x-codex-primary-used-percent": "12",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-after-seconds": "600",
		});

		const usage = parseCodexUsageHeaders(headers, {
			baseTimeMs,
			allowRelativeResetAfter: true,
		});

		expect(usage?.five_hour?.resets_at).toBe(
			new Date(baseTimeMs + 600_000).toISOString(),
		);
	});
});

describe("parseCodexUsageHeaders per-model scoped limits", () => {
	it("emits a weekly_scoped limits entry from real bengalfox headers", () => {
		const headers = new Headers({
			"x-codex-active-limit": "premium",
			"x-codex-primary-window-minutes": "10080",
			"x-codex-primary-used-percent": "21",
			"x-codex-primary-reset-at": "1785258194",
			"x-codex-secondary-window-minutes": "0",
			"x-codex-secondary-used-percent": "0",
			"x-codex-secondary-reset-after-seconds": "0",
			"x-codex-bengalfox-limit-name": "GPT-5.3-Codex-Spark",
			"x-codex-bengalfox-primary-window-minutes": "10080",
			"x-codex-bengalfox-primary-used-percent": "0",
			"x-codex-bengalfox-primary-reset-at": "1785335948",
			"x-codex-bengalfox-secondary-window-minutes": "0",
			"x-codex-bengalfox-secondary-used-percent": "0",
		});

		const usage = parseCodexUsageHeaders(headers);

		expect(usage).not.toBeNull();
		// Regular un-prefixed weekly window is unchanged.
		expect(usage?.seven_day).toEqual({
			utilization: 21,
			resets_at: new Date(1785258194 * 1000).toISOString(),
		});
		expect(usage?.limits).toHaveLength(1);
		expect(usage?.limits?.[0]).toEqual({
			kind: "weekly_scoped",
			group: "codex",
			percent: 0,
			resets_at: new Date(1785335948 * 1000).toISOString(),
			scope: {
				model: {
					id: "GPT-5.3-Codex-Spark",
					display_name: "GPT-5.3-Codex-Spark",
				},
			},
			is_active: true,
		});
	});

	it("discovers multiple families deterministically", () => {
		const headers = new Headers({
			"x-codex-primary-window-minutes": "10080",
			"x-codex-primary-used-percent": "21",
			"x-codex-primary-reset-at": "1785258194",
			"x-codex-otterpaw-limit-name": "Some-Model",
			"x-codex-otterpaw-primary-window-minutes": "10080",
			"x-codex-otterpaw-primary-used-percent": "5",
			"x-codex-otterpaw-primary-reset-at": "1900000000",
			"x-codex-bengalfox-limit-name": "GPT-5.3-Codex-Spark",
			"x-codex-bengalfox-primary-window-minutes": "10080",
			"x-codex-bengalfox-primary-used-percent": "0",
			"x-codex-bengalfox-primary-reset-at": "1785335948",
		});

		const usage = parseCodexUsageHeaders(headers);

		// Alphabetical family order: bengalfox before otterpaw.
		expect(usage?.limits).toHaveLength(2);
		expect(usage?.limits?.map((l) => l.scope?.model?.display_name)).toEqual([
			"GPT-5.3-Codex-Spark",
			"Some-Model",
		]);
		expect(usage?.limits?.[1]).toEqual({
			kind: "weekly_scoped",
			group: "codex",
			percent: 5,
			resets_at: new Date(1900000000 * 1000).toISOString(),
			scope: { model: { id: "Some-Model", display_name: "Some-Model" } },
			is_active: true,
		});
	});

	it("omits limits when no family headers are present", () => {
		const headers = new Headers({
			"x-codex-primary-window-minutes": "10080",
			"x-codex-primary-used-percent": "21",
			"x-codex-primary-reset-at": "1785258194",
		});

		const usage = parseCodexUsageHeaders(headers);

		expect(usage).not.toBeNull();
		expect(usage?.limits).toBeUndefined();
	});

	it("does not emit a family whose weekly window is an empty placeholder", () => {
		const headers = new Headers({
			"x-codex-primary-window-minutes": "10080",
			"x-codex-primary-used-percent": "21",
			"x-codex-primary-reset-at": "1785258194",
			"x-codex-otterpaw-limit-name": "Placeholder-Model",
			"x-codex-otterpaw-primary-window-minutes": "0",
			"x-codex-otterpaw-primary-used-percent": "0",
			"x-codex-otterpaw-secondary-window-minutes": "0",
			"x-codex-otterpaw-secondary-used-percent": "0",
		});

		const usage = parseCodexUsageHeaders(headers);

		expect(usage).not.toBeNull();
		expect(usage?.limits).toBeUndefined();
	});
});

describe("count_tokens synthetic response", () => {
	it("returns synthetic 200 with input_tokens for valid JSON body", async () => {
		const provider = new CodexProvider();
		const req = new Request("https://clankermux.local/codex/count_tokens", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				messages: [{ role: "user", content: "hello" }],
				model: "claude-opus-4-5",
				max_tokens: 100,
			}),
		});
		const result = await provider.transformRequestBody(req);
		expect(result.headers.get("x-clankermux-synthetic-response")).toBe("true");
		expect(result.headers.get("x-clankermux-synthetic-status")).toBe("200");
		const body = (await result.json()) as { input_tokens: number };
		expect(body.input_tokens).toBeGreaterThanOrEqual(1);
		expect(typeof body.input_tokens).toBe("number");
	});

	it("returns synthetic 400 for malformed JSON", async () => {
		const provider = new CodexProvider();
		const req = new Request("https://clankermux.local/codex/count_tokens", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not-json{",
		});
		const result = await provider.transformRequestBody(req);
		expect(result.headers.get("x-clankermux-synthetic-response")).toBe("true");
		expect(result.headers.get("x-clankermux-synthetic-status")).toBe("400");
		const body = (await result.json()) as {
			type: string;
			error: { type: string };
		};
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("invalid_request_error");
	});

	it("returns synthetic 400 for non-JSON content-type", async () => {
		const provider = new CodexProvider();
		const req = new Request("https://clankermux.local/codex/count_tokens", {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: "hello",
		});
		const result = await provider.transformRequestBody(req);
		expect(result.headers.get("x-clankermux-synthetic-response")).toBe("true");
		expect(result.headers.get("x-clankermux-synthetic-status")).toBe("400");
	});

	it("returns at least 1 input_token even for tiny body", async () => {
		const provider = new CodexProvider();
		const req = new Request("https://clankermux.local/codex/count_tokens", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		const result = await provider.transformRequestBody(req);
		const body = (await result.json()) as { input_tokens: number };
		expect(body.input_tokens).toBeGreaterThanOrEqual(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tranche 3: tool_choice honoring, StructuredOutput forcing, and tool_result
// serialization fidelity (upstream 543bb543, 02f66d92, 2704e310, 02408f72,
// 31aa0d73). Our translator previously (a) sent no tool_choice at all,
// (b) dropped image/structured tool_result blocks and could throw on a null
// block, and (c) grouped message blocks instead of preserving source order.
// ─────────────────────────────────────────────────────────────────────────────

interface T3CodexBody {
	input: Array<Record<string, unknown>>;
	tools?: Array<{ name: string }>;
	tool_choice?: unknown;
	parallel_tool_calls?: boolean;
}

async function t3transform(body: unknown): Promise<T3CodexBody> {
	const provider = new CodexProvider();
	const request = new Request("https://example.com/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const out = await provider.transformRequestBody(request, undefined);
	return (await out.json()) as T3CodexBody;
}

const t3outputs = (input: T3CodexBody["input"]) =>
	input.filter((it) => it.type === "function_call_output");

/** Minimal valid history: one Task call awaiting its result. */
function t3taskTurn(
	resultContent: unknown,
	extra: Record<string, unknown> = {},
): unknown {
	return {
		model: "claude-opus-4-8",
		max_tokens: 10,
		messages: [
			{ role: "user", content: "run it" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "t1", name: "Task", input: {} }],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						...(resultContent === "__omit__" ? {} : { content: resultContent }),
						...extra,
					},
				],
			},
		],
	};
}

describe("CodexProvider Tranche 3 — StructuredOutput forcing", () => {
	it("forces StructuredOutput tool_choice when the schema tool is present", async () => {
		const body = await t3transform({
			model: "claude-haiku-4-5-20251001",
			max_tokens: 10,
			messages: [{ role: "user", content: "return structured output" }],
			tools: [
				{
					name: "StructuredOutput",
					description: "Return the validated payload.",
					input_schema: { type: "object" },
				},
			],
		});
		expect(body.tools?.map((t) => t.name)).toContain("StructuredOutput");
		expect(body.tool_choice).toEqual({
			type: "function",
			name: "StructuredOutput",
		});
	});

	it("does not force tool_choice for ordinary tool-enabled requests", async () => {
		const body = await t3transform({
			model: "claude-haiku-4-5-20251001",
			max_tokens: 10,
			messages: [{ role: "user", content: "read a file" }],
			tools: [{ name: "Read", description: "Read a file.", input_schema: {} }],
		});
		expect(body.tool_choice).toBeUndefined();
	});

	it("lets an explicit tool_choice override the StructuredOutput fallback", async () => {
		const body = await t3transform({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [{ role: "user", content: "return text" }],
			tools: [{ name: "StructuredOutput", input_schema: {} }],
			tool_choice: { type: "none" },
		});
		expect(body.tool_choice).toBe("none");
	});
});

describe("CodexProvider Tranche 3 — tool_choice mapping", () => {
	it.each([
		[{ type: "auto" }, "auto"],
		[{ type: "any" }, "required"],
		[{ type: "none" }, "none"],
		[
			{ type: "tool", name: "Read" },
			{ type: "function", name: "Read" },
		],
	] as const)("maps Anthropic tool_choice %j to Codex", async (choice, expected) => {
		const body = await t3transform({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [{ role: "user", content: "read a file" }],
			tools: [{ name: "Read", input_schema: { type: "object" } }],
			tool_choice: choice,
		});
		expect(body.tool_choice).toEqual(expected);
	});

	it("maps disable_parallel_tool_use to parallel_tool_calls=false (auto)", async () => {
		const body = await t3transform({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [{ role: "user", content: "hi" }],
			tools: [{ name: "Read", input_schema: { type: "object" } }],
			tool_choice: { type: "auto", disable_parallel_tool_use: true },
		});
		expect(body.tool_choice).toBe("auto");
		expect(body.parallel_tool_calls).toBe(false);
	});

	it("maps any + disable_parallel_tool_use to required + parallel_tool_calls=false", async () => {
		const body = await t3transform({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [{ role: "user", content: "hi" }],
			tools: [{ name: "Read", input_schema: { type: "object" } }],
			tool_choice: { type: "any", disable_parallel_tool_use: true },
		});
		expect(body.tool_choice).toBe("required");
		expect(body.parallel_tool_calls).toBe(false);
	});

	it("leaves parallel_tool_calls unset when the flag is absent", async () => {
		const body = await t3transform({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [{ role: "user", content: "hi" }],
			tools: [{ name: "Read", input_schema: { type: "object" } }],
			tool_choice: { type: "auto" },
		});
		expect(body.parallel_tool_calls).toBeUndefined();
	});

	it("rejects a named tool_choice absent from tools", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-opus-4-8",
				max_tokens: 10,
				messages: [{ role: "user", content: "hi" }],
				tools: [{ name: "Read", input_schema: { type: "object" } }],
				tool_choice: { type: "tool", name: "WebSearch" },
			}),
		});
		await expect(provider.transformRequestBody(request)).rejects.toThrow(
			"tool_choice references unknown tool: WebSearch",
		);
	});

	it("rejects a named tool_choice when no tools are present", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-opus-4-8",
				max_tokens: 10,
				messages: [{ role: "user", content: "hi" }],
				tool_choice: { type: "tool", name: "Read" },
			}),
		});
		await expect(provider.transformRequestBody(request)).rejects.toThrow(
			/tool_choice/,
		);
	});

	it("rejects an unsupported tool_choice variant instead of coercing it", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-opus-4-8",
				max_tokens: 10,
				messages: [{ role: "user", content: "hi" }],
				tools: [{ name: "Read", input_schema: { type: "object" } }],
				tool_choice: { type: "bogus", name: "Read" },
			}),
		});
		await expect(provider.transformRequestBody(request)).rejects.toThrow(
			/tool_choice/,
		);
	});
});

describe("CodexProvider Tranche 3 — tool_result serialization fidelity", () => {
	it("renders image blocks as a bounded placeholder, not the base64 payload", async () => {
		const body = await t3transform(
			t3taskTurn([
				{
					type: "image",
					source: { type: "base64", media_type: "image/png", data: "AAAA" },
				},
			]),
		);
		const out = t3outputs(body.input)[0]?.output as string;
		expect(out).toBe("[image content not supported in Codex tool results]");
		expect(out).not.toContain("AAAA");
	});

	it("preserves small structured (non-text) blocks as JSON", async () => {
		const body = await t3transform(
			t3taskTurn([{ type: "tool_reference", tool_name: "TaskCreate" }]),
		);
		expect(t3outputs(body.input)[0]?.output).toBe(
			'{"type":"tool_reference","tool_name":"TaskCreate"}',
		);
	});

	it("caps oversized structured blocks with an omission marker", async () => {
		const bigData = "A".repeat(200_000);
		const body = await t3transform(
			t3taskTurn([
				{
					type: "document",
					source: {
						type: "base64",
						media_type: "application/pdf",
						data: bigData,
					},
				},
			]),
		);
		const out = t3outputs(body.input)[0]?.output as string;
		expect(out.length).toBeLessThan(10_000);
		expect(out).not.toContain(bigData);
		expect(out).toContain("omitted");
	});

	it("marks errored tool results with an explicit error prefix", async () => {
		const body = await t3transform(
			t3taskTurn([{ type: "text", text: "boom" }], { is_error: true }),
		);
		expect(t3outputs(body.input)[0]?.output).toBe("[tool error] boom");
	});

	it("leaves successful tool results unmarked", async () => {
		const body = await t3transform(
			t3taskTurn([{ type: "text", text: "fine" }]),
		);
		expect(t3outputs(body.input)[0]?.output).toBe("fine");
	});

	it("degrades missing/null/non-array content to empty output instead of throwing", async () => {
		for (const content of ["__omit__", null, { oops: true }]) {
			const body = await t3transform(t3taskTurn(content));
			expect(Array.isArray(body.input)).toBe(true);
			expect(t3outputs(body.input)[0]?.output).toBe("");
		}
	});

	it("skips null blocks inside a content array but keeps surviving text", async () => {
		const body = await t3transform(
			t3taskTurn([null, { type: "text", text: "ok" }]),
		);
		expect(t3outputs(body.input)[0]?.output).toBe("ok");
	});
});

describe("CodexProvider Tranche 3 — source-order preservation", () => {
	it("keeps a tool_result before the follow-up text in the same message", async () => {
		const body = await t3transform({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [
				{ role: "user", content: "run it" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "t1", name: "Task", input: {} }],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							content: [{ type: "text", text: "finding" }],
						},
						{ type: "text", text: "now summarize the finding" },
					],
				},
			],
		});
		const outputIdx = body.input.findIndex(
			(it) => it.type === "function_call_output",
		);
		const followupIdx = body.input.findIndex(
			(it) =>
				it.role === "user" &&
				Array.isArray(it.content) &&
				(it.content as Array<Record<string, unknown>>).some(
					(c) => c.text === "now summarize the finding",
				),
		);
		expect(outputIdx).toBeGreaterThanOrEqual(0);
		expect(followupIdx).toBeGreaterThan(outputIdx);
	});

	it("keeps a tool_use before the follow-up text in an assistant message", async () => {
		const body = await t3transform({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "t1", name: "Bash", input: {} },
						{ type: "text", text: "dispatched, waiting" },
					],
				},
			],
		});
		const callIdx = body.input.findIndex((it) => it.type === "function_call");
		const textIdx = body.input.findIndex(
			(it) =>
				it.role === "assistant" &&
				Array.isArray(it.content) &&
				(it.content as Array<Record<string, unknown>>).some(
					(c) => c.text === "dispatched, waiting",
				),
		);
		expect(callIdx).toBeGreaterThanOrEqual(0);
		expect(textIdx).toBeGreaterThan(callIdx);
	});
});

describe("CodexProvider refreshToken auth-error classification", () => {
	afterEach(() => {
		spyOn(globalThis, "fetch").mockRestore();
	});

	// Test files are excluded from typecheck, so a minimal account shape is fine.
	const account = (overrides: Record<string, unknown> = {}) =>
		({
			id: "codex-1",
			name: "codex-test",
			provider: "codex",
			refresh_token: "rt-old",
			...overrides,
		}) as unknown as Parameters<CodexProvider["refreshToken"]>[0];

	const mockTokenResponse = (body: unknown, status: number) =>
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(typeof body === "string" ? body : JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
		);

	it("throws OAuthRefreshTokenError on invalid_grant (revoked/expired token)", async () => {
		mockTokenResponse(
			{
				error: "invalid_grant",
				error_description: "Token has been expired or revoked.",
			},
			400,
		);
		const provider = new CodexProvider();
		await expect(
			provider.refreshToken(account(), "cid"),
		).rejects.toBeInstanceOf(OAuthRefreshTokenError);
	});

	it("treats client-level errors (unauthorized_client) as transient/generic, not per-account reauth", async () => {
		// invalid_client / unauthorized_client describe the OAuth CLIENT config,
		// not an individual account's refresh token — reauth (through the same
		// shared client) can't fix them, so they must NOT pause the account.
		mockTokenResponse({ error: "unauthorized_client" }, 400);
		const provider = new CodexProvider();
		const err = await provider
			.refreshToken(account(), "cid")
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(OAuthRefreshTokenError);
	});

	it("throws OAuthRefreshTokenError on refresh_token_reused (existing behavior)", async () => {
		mockTokenResponse({ error: "refresh_token_reused" }, 400);
		const provider = new CodexProvider();
		await expect(
			provider.refreshToken(account(), "cid"),
		).rejects.toBeInstanceOf(OAuthRefreshTokenError);
	});

	it("throws a generic (non-OAuthRefreshTokenError) error on a transient server_error", async () => {
		mockTokenResponse({ error: "server_error" }, 500);
		const provider = new CodexProvider();
		const err = await provider
			.refreshToken(account(), "cid")
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(OAuthRefreshTokenError);
	});

	it("throws a generic (non-OAuthRefreshTokenError) error on a 503 with no JSON body", async () => {
		mockTokenResponse("Service Unavailable", 503);
		const provider = new CodexProvider();
		const err = await provider
			.refreshToken(account(), "cid")
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(OAuthRefreshTokenError);
	});

	it("throws OAuthRefreshTokenError on a non-JSON text/plain body containing invalid_grant", async () => {
		// Regression guard (Finding 7): a terminal marker in a non-JSON body must
		// still be classified as terminal rather than a generic retryable error.
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("error: invalid_grant — token revoked", { status: 400 }),
		);
		const provider = new CodexProvider();
		await expect(
			provider.refreshToken(account(), "cid"),
		).rejects.toBeInstanceOf(OAuthRefreshTokenError);
	});

	it("throws a generic error on a non-JSON text/plain body with no terminal marker", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("bad request", { status: 400 }),
		);
		const provider = new CodexProvider();
		const err = await provider
			.refreshToken(account(), "cid")
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(OAuthRefreshTokenError);
	});

	it("returns the rotated tokens on a successful refresh", async () => {
		mockTokenResponse(
			{
				access_token: "at-new",
				refresh_token: "rt-new",
				expires_in: 3600,
			},
			200,
		);
		const provider = new CodexProvider();
		const before = Date.now();
		const result = await provider.refreshToken(account(), "cid");
		expect(result.accessToken).toBe("at-new");
		expect(result.refreshToken).toBe("rt-new");
		expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
	});
});
