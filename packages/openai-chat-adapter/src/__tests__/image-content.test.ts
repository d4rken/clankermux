import { describe, expect, it } from "bun:test";
import { ChatError } from "../errors";
import { translateChatRequest } from "../request";

// `/v1/chat/completions` ingress: OpenAI `image_url` content parts become
// Anthropic `image` blocks. The rejection this replaces was provider-independent,
// so it blocked images to every backend, including ones that serve them.

const translate = (messages: unknown[]) =>
	translateChatRequest({ model: "alias", messages });

describe("chat completions image content", () => {
	it("translates a data URL part into a base64 image block", () => {
		const { body } = translate([
			{
				role: "user",
				content: [
					{ type: "text", text: "what is this?" },
					{
						type: "image_url",
						image_url: { url: "data:image/png;base64,iVBORw0KGgo" },
					},
				],
			},
		]);

		expect(body.messages[0].content).toEqual([
			{ type: "text", text: "what is this?" },
			{
				type: "image",
				source: {
					type: "base64",
					media_type: "image/png",
					data: "iVBORw0KGgo",
				},
			},
		]);
	});

	it("translates an http URL part into a url image block", () => {
		const { body } = translate([
			{
				role: "user",
				content: [
					{
						type: "image_url",
						image_url: { url: "https://example.com/shot.png" },
					},
				],
			},
		]);

		expect(body.messages[0].content).toEqual([
			{
				type: "image",
				source: { type: "url", url: "https://example.com/shot.png" },
			},
		]);
	});

	it("accepts and ignores the OpenAI detail hint", () => {
		// `detail` tunes cost/fidelity on OpenAI and has no Anthropic counterpart.
		// Rejecting it would fail requests from every SDK that sets it by default.
		const { body } = translate([
			{
				role: "user",
				content: [
					{
						type: "image_url",
						image_url: { url: "https://example.com/a.png", detail: "high" },
					},
				],
			},
		]);

		expect(body.messages[0].content).toEqual([
			{
				type: "image",
				source: { type: "url", url: "https://example.com/a.png" },
			},
		]);
	});

	it("allows an image-only user message", () => {
		const { body } = translate([
			{
				role: "user",
				content: [
					{
						type: "image_url",
						image_url: { url: "https://example.com/a.png" },
					},
				],
			},
		]);

		expect(body.messages).toHaveLength(1);
		expect(body.messages[0].content).toHaveLength(1);
	});

	it("rejects an image part on a system message", () => {
		// The Anthropic `system` field carries text blocks only.
		expect(() =>
			translate([
				{
					role: "system",
					content: [
						{
							type: "image_url",
							image_url: { url: "https://example.com/a.png" },
						},
					],
				},
				{ role: "user", content: "hi" },
			]),
		).toThrow(ChatError);
	});

	it("rejects an image part on an assistant message", () => {
		expect(() =>
			translate([
				{ role: "user", content: "hi" },
				{
					role: "assistant",
					content: [
						{
							type: "image_url",
							image_url: { url: "https://example.com/a.png" },
						},
					],
				},
			]),
		).toThrow(/assistant/i);
	});

	it("rejects a URL scheme that is neither data: nor http(s)", () => {
		expect(() =>
			translate([
				{
					role: "user",
					content: [
						{ type: "image_url", image_url: { url: "file:///etc/passwd" } },
					],
				},
			]),
		).toThrow(/image url/i);
	});

	it("accepts a data URL carrying parameters before base64", () => {
		const { body } = translate([
			{
				role: "user",
				content: [
					{
						type: "image_url",
						image_url: { url: "data:image/png;charset=utf-8;base64,iVBOR" },
					},
				],
			},
		]);

		expect(body.messages[0].content).toEqual([
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: "iVBOR" },
			},
		]);
	});

	it("rejects a data URL that is not base64", () => {
		expect(() =>
			translate([
				{
					role: "user",
					content: [
						{
							type: "image_url",
							image_url: { url: "data:image/svg+xml,<svg/>" },
						},
					],
				},
			]),
		).toThrow(/image url/i);
	});

	it("still rejects a content part type it has no mapping for", () => {
		expect(() =>
			translate([
				{
					role: "user",
					content: [{ type: "input_audio", input_audio: { data: "AA" } }],
				},
			]),
		).toThrow(/only text and image/i);
	});
});
