import { describe, expect, it } from "bun:test";
import { ValidationError } from "@clankermux/core";
import { convertAnthropicRequestToOpenAI } from "../converters";
import type { AnthropicContentBlock, AnthropicRequest } from "../types";

const PNG = {
	type: "image",
	source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
} as const;
const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";

function convert(messages: AnthropicRequest["messages"]) {
	return convertAnthropicRequestToOpenAI({
		model: "qwen3.6-plus",
		max_tokens: 100,
		messages,
	}).messages;
}

function userBlocks(...blocks: unknown[]): AnthropicRequest["messages"] {
	return [{ role: "user", content: blocks as AnthropicContentBlock[] }];
}

describe("convertAnthropicRequestToOpenAI — message images", () => {
	it("keeps text and images in the order the client sent them", () => {
		expect(
			convert(
				userBlocks({ type: "text", text: "Before" }, PNG, {
					type: "text",
					text: "After",
				}),
			),
		).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "Before" },
					{ type: "image_url", image_url: { url: PNG_URL } },
					{ type: "text", text: "After" },
				],
			},
		]);
	});

	it("keeps an image-only user message", () => {
		expect(convert(userBlocks(PNG))).toEqual([
			{
				role: "user",
				content: [{ type: "image_url", image_url: { url: PNG_URL } }],
			},
		]);
	});

	it("forwards an http(s) url source verbatim", () => {
		const [msg] = convert(
			userBlocks({
				type: "image",
				source: { type: "url", url: "https://example.com/cat.png" },
			}),
		);
		expect(msg?.content).toEqual([
			{ type: "image_url", image_url: { url: "https://example.com/cat.png" } },
		]);
	});

	it("keeps cache_control on text parts beside an image", () => {
		const [msg] = convert(
			userBlocks(PNG, {
				type: "text",
				text: "Describe it",
				cache_control: { type: "ephemeral" },
			}),
		);
		expect(msg?.content).toEqual([
			{ type: "image_url", image_url: { url: PNG_URL } },
			{
				type: "text",
				text: "Describe it",
				cache_control: { type: "ephemeral" },
			},
		]);
	});

	it.each([
		["a file: url", { type: "url", url: "file:///etc/passwd" }],
		["base64 without media_type", { type: "base64", data: "iVBORw0KGgo=" }],
		["base64 without data", { type: "base64", media_type: "image/png" }],
		["a missing source", undefined],
	])("rejects %s instead of dropping the image", (_label, source) => {
		expect(() => convert(userBlocks({ type: "image", source }))).toThrow(
			ValidationError,
		);
	});

	it("rejects an image on an assistant message", () => {
		expect(() =>
			convert([
				{ role: "user", content: "hi" },
				{
					role: "assistant",
					content: [PNG] as unknown as AnthropicContentBlock[],
				},
			]),
		).toThrow(ValidationError);
	});
});

describe("convertAnthropicRequestToOpenAI — tool_result images", () => {
	const toolCallTurn = {
		role: "assistant" as const,
		content: [
			{ type: "tool_use" as const, id: "call_1", name: "shot", input: {} },
			{ type: "tool_use" as const, id: "call_2", name: "shot", input: {} },
		],
	};

	it("leaves a placeholder in the tool message and sends the image right after", () => {
		const messages = convert([
			{ role: "user", content: "take a screenshot" },
			toolCallTurn,
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_1",
						content: [{ type: "text", text: "captured" }, PNG],
					},
					{ type: "text", text: "what do you see?" },
				] as AnthropicContentBlock[],
			},
		]);
		expect(messages.slice(2)).toEqual([
			{
				role: "tool",
				tool_call_id: "call_1",
				content: "captured\n[image attached in the following message]",
			},
			{
				role: "user",
				content: [
					{ type: "image_url", image_url: { url: PNG_URL } },
					{ type: "text", text: "what do you see?" },
				],
			},
		]);
	});

	it("sends every tool message before the images they produced", () => {
		const second = {
			type: "image",
			source: { type: "url", url: "https://example.com/2.png" },
		};
		const messages = convert([
			{ role: "user", content: "go" },
			toolCallTurn,
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call_1", content: [PNG] },
					{ type: "tool_result", tool_use_id: "call_2", content: [second] },
				] as AnthropicContentBlock[],
			},
		]);
		expect(messages.slice(2).map((m) => m.role)).toEqual([
			"tool",
			"tool",
			"user",
		]);
		expect(messages[4]?.content).toEqual([
			{ type: "image_url", image_url: { url: PNG_URL } },
			{
				type: "image_url",
				image_url: { url: "https://example.com/2.png" },
			},
		]);
	});

	it("keeps each round's screenshot beside its own tool result", () => {
		const messages = convert([
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "a", name: "shot", input: {} }],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "a", content: [PNG] },
				] as AnthropicContentBlock[],
			},
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "b", name: "shot", input: {} }],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "b", content: "no image" },
				] as AnthropicContentBlock[],
			},
		]);
		expect(messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"user",
			"assistant",
			"tool",
		]);
	});

	it("rejects a tool_result image with an unusable source", () => {
		expect(() =>
			convert([
				{ role: "user", content: "go" },
				toolCallTurn,
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "call_1",
							content: [{ type: "image", source: { type: "base64" } }],
						},
					] as AnthropicContentBlock[],
				},
			]),
		).toThrow(ValidationError);
	});
});
