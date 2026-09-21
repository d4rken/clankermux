import { describe, expect, it } from "bun:test";
import {
	anthropicToOllama,
	isOllamaCloudEndpoint,
	ollamaChunkToAnthropicSSE,
	ollamaResponseToAnthropic,
	type SSEStreamState,
} from "../ollama-transformer";

function freshState(): SSEStreamState {
	return {
		messageStarted: false,
		contentBlockIndex: 0,
		lastTextContent: "",
		hasEmittedContentBlockStart: false,
	};
}

describe("ollama-transformer", () => {
	describe("anthropicToOllama", () => {
		it("converts simple text messages", () => {
			const result = anthropicToOllama({
				model: "gemma3",
				messages: [{ role: "user", content: "Hello" }],
			});
			expect(result.model).toBe("gemma3");
			expect(result.messages).toHaveLength(1);
			expect(result.messages[0].content).toBe("Hello");
		});

		it("converts system prompt from separate field", () => {
			const result = anthropicToOllama({
				model: "llama3",
				system: "You are a helpful assistant",
				messages: [{ role: "user", content: "Hi" }],
			});
			expect(result.messages[0].role).toBe("system");
			expect(result.messages[0].content).toBe("You are a helpful assistant");
		});

		it("converts array system prompt", () => {
			const result = anthropicToOllama({
				model: "llama3",
				system: [
					{ type: "text", text: "Rule 1" },
					{ type: "text", text: "Rule 2" },
				],
				messages: [{ role: "user", content: "Hi" }],
			});
			expect(result.messages[0].content).toBe("Rule 1\nRule 2");
		});

		it("handles multi-turn conversation", () => {
			const result = anthropicToOllama({
				model: "gemma3",
				messages: [
					{ role: "user", content: "What is 2+2?" },
					{ role: "assistant", content: "4" },
					{ role: "user", content: "Thanks" },
				],
			});
			expect(result.messages).toHaveLength(3);
			expect(result.messages[0].role).toBe("user");
			expect(result.messages[1].role).toBe("assistant");
			expect(result.messages[2].role).toBe("user");
		});

		it("defaults stream to true", () => {
			const result = anthropicToOllama({
				model: "gemma3",
				messages: [{ role: "user", content: "Hi" }],
			});
			expect(result.stream).toBe(true);
		});

		it("respects stream=false", () => {
			const result = anthropicToOllama({
				model: "gemma3",
				messages: [{ role: "user", content: "Hi" }],
				stream: false,
			});
			expect(result.stream).toBe(false);
		});

		it("passes through temperature and top_p as options", () => {
			const result = anthropicToOllama({
				model: "gemma3",
				messages: [{ role: "user", content: "Hi" }],
				temperature: 0.7,
				top_p: 0.9,
			});
			expect(result.options?.temperature).toBe(0.7);
			expect(result.options?.top_p).toBe(0.9);
		});

		it("maps max_tokens to num_predict", () => {
			const result = anthropicToOllama({
				model: "gemma3",
				messages: [{ role: "user", content: "Hi" }],
				max_tokens: 100,
			});
			expect(result.options?.num_predict).toBe(100);
		});

		it("handles content blocks with thinking tags", () => {
			const result = anthropicToOllama({
				model: "qwen3",
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "Let me think..." },
							{ type: "text", text: "The answer is 42" },
						],
					},
				],
			});
			expect(result.messages[0].content).toBe(
				"<thinking>Let me think...</thinking>\nThe answer is 42",
			);
		});

		it("converts tools to Ollama format", () => {
			const result = anthropicToOllama({
				model: "gemma3",
				messages: [{ role: "user", content: "What is the weather?" }],
				tools: [
					{
						type: "function",
						function: {
							name: "get_weather",
							description: "Get current weather",
							parameters: {
								type: "object",
								properties: { location: { type: "string" } },
							},
						},
					},
				],
			});
			expect(result.tools).toHaveLength(1);
			expect(result.tools?.[0].function.name).toBe("get_weather");
		});

		it("handles empty messages", () => {
			const result = anthropicToOllama({
				model: "test",
				messages: [],
			});
			expect(result.messages).toHaveLength(0);
		});

		it("handles missing model", () => {
			const result = anthropicToOllama({
				messages: [{ role: "user", content: "Hi" }],
			});
			expect(result.model).toBe("unknown");
		});
	});

	describe("ollamaChunkToAnthropicSSE", () => {
		it("emits message_start on first text chunk", () => {
			const state = freshState();
			const sse = ollamaChunkToAnthropicSSE(
				{
					model: "gemma3",
					message: { role: "assistant", content: "Hello" },
					done: false,
				},
				"test123",
				state,
			);
			expect(sse).toContain("event: message_start");
			expect(sse).toContain("event: content_block_start");
			expect(sse).toContain("event: content_block_delta");
			expect(sse).toContain("text_delta");
			expect(sse).toContain("Hello");
		});

		it("emits delta only for new text on cumulative chunks", () => {
			const state = freshState();
			// First chunk
			ollamaChunkToAnthropicSSE(
				{
					model: "gemma3",
					message: { role: "assistant", content: "Hel" },
					done: false,
				},
				"test123",
				state,
			);
			// Second chunk (cumulative)
			const sse2 = ollamaChunkToAnthropicSSE(
				{
					model: "gemma3",
					message: { role: "assistant", content: "Hello" },
					done: false,
				},
				"test123",
				state,
			);
			// Should only emit delta for "lo" (not "Hello" again)
			expect(sse2).toContain("lo");
			expect(sse2).not.toContain("Hel");
		});

		it("converts done chunk to message_delta + message_stop with content_block_stop", () => {
			const state = freshState();
			// First emit a text chunk to open a content block
			ollamaChunkToAnthropicSSE(
				{
					model: "gemma3",
					message: { role: "assistant", content: "Hello" },
					done: false,
				},
				"test123",
				state,
			);
			const sse = ollamaChunkToAnthropicSSE(
				{
					model: "gemma3",
					message: { role: "assistant", content: "" },
					done: true,
					done_reason: "stop",
				},
				"test123",
				state,
			);
			expect(sse).toContain("event: content_block_stop");
			expect(sse).toContain("event: message_delta");
			expect(sse).toContain("event: message_stop");
			expect(sse).toContain("stop");
		});

		it("states NO token counts, rather than a count of zero", () => {
			// Ollama reports none. A fabricated 0 is a positive claim that none
			// were consumed, which the persisted row publishes and a client
			// settles its budget against; absence keeps the row honest.
			const state = freshState();
			const start = ollamaChunkToAnthropicSSE(
				{
					model: "gemma3",
					message: { role: "assistant", content: "Hi" },
					done: false,
				},
				"test123",
				state,
			);
			const startUsage = JSON.parse(
				/data: (.*"type":"message_start".*)/.exec(start)?.[1] ?? "{}",
			).message.usage;
			expect(startUsage.input_tokens).toBeUndefined();

			const end = ollamaChunkToAnthropicSSE(
				{
					model: "gemma3",
					message: { role: "assistant", content: "" },
					done: true,
					done_reason: "stop",
				},
				"test123",
				state,
			);
			const delta = JSON.parse(
				/data: (.*"type":"message_delta".*)/.exec(end)?.[1] ?? "{}",
			);
			// message_delta is where a provider states its authoritative counts.
			expect(delta.usage).toBeUndefined();
			expect(delta.delta.stop_reason).toBe("stop");
		});

		it("emits message_start even for empty non-done chunk", () => {
			const state = freshState();
			const sse = ollamaChunkToAnthropicSSE(
				{
					model: "gemma3",
					message: { role: "assistant", content: "" },
					done: false,
				},
				"test123",
				state,
			);
			// message_start should always be emitted to initialize the stream
			expect(sse).toContain("event: message_start");
			// No content delta for empty content
			expect(sse).not.toContain("content_block_delta");
		});
	});

	describe("ollamaResponseToAnthropic", () => {
		it("converts non-streaming text response", () => {
			const result = ollamaResponseToAnthropic({
				model: "gemma3",
				message: { role: "assistant", content: "Hello world" },
				done: true,
			});
			expect(result.type).toBe("message");
			expect(result.role).toBe("assistant");
			const content = result.content;
			expect(content).toHaveLength(1);
			if (!Array.isArray(content)) throw new Error("expected content blocks");
			expect(content[0]).toEqual({
				type: "text",
				text: "Hello world",
			});
			expect(result.model).toBe("gemma3");
			expect(result.stop_reason).toBe("end_turn");
		});

		it("states no usage at all rather than a zero vector", () => {
			const result = ollamaResponseToAnthropic({
				model: "gemma3",
				message: { role: "assistant", content: "Hello world" },
				done: true,
			});
			expect(result.usage).toBeUndefined();
		});
	});

	describe("isOllamaCloudEndpoint", () => {
		it("detects ollama.com as cloud", () => {
			expect(isOllamaCloudEndpoint("https://ollama.com")).toBe(true);
			expect(isOllamaCloudEndpoint("https://ollama.com/api/chat")).toBe(true);
		});

		it("rejects localhost as cloud", () => {
			expect(isOllamaCloudEndpoint("http://localhost:11434")).toBe(false);
			expect(isOllamaCloudEndpoint("http://127.0.0.1:11434")).toBe(false);
		});

		it("rejects invalid URLs", () => {
			expect(isOllamaCloudEndpoint("not-a-url")).toBe(false);
		});
	});
});
