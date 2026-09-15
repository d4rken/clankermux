import { describe, expect, it } from "bun:test";
import { CodexProvider } from "./provider";

// Attachment blocks on the Anthropic→Codex translated path. Images become
// Responses `input_image` items; documents have no Responses representation we
// have evidence this backend accepts, so they become a visible marker rather
// than vanishing.

const messagesRequest = (messages: unknown[]) =>
	new Request("https://example.com/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: "gpt-6-astra", max_tokens: 10, messages }),
	});

const translate = async (messages: unknown[]) => {
	const result = await new CodexProvider().transformRequestBody(
		messagesRequest(messages),
	);
	return (await result.json()) as {
		input: {
			role?: string;
			content?: { type: string; [key: string]: unknown }[];
		}[];
	};
};

describe("CodexProvider attachment translation", () => {
	it("translates a base64 image into an input_image data URL beside its text", async () => {
		const body = await translate([
			{
				role: "user",
				content: [
					{ type: "text", text: "what is in this screenshot?" },
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: "iVBORw0KGgo",
						},
					},
				],
			},
		]);

		// One message wrapper: an image is message content, so it joins the text
		// batch instead of splitting the turn.
		expect(body.input).toHaveLength(1);
		expect(body.input[0].content).toEqual([
			{ type: "input_text", text: "what is in this screenshot?" },
			{ type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo" },
		]);
	});

	it("keeps source order when the image precedes the text", async () => {
		const body = await translate([
			{
				role: "user",
				content: [
					{
						type: "image",
						source: { type: "base64", media_type: "image/jpeg", data: "AAAA" },
					},
					{ type: "text", text: "describe it" },
				],
			},
		]);

		expect(body.input[0].content).toEqual([
			{ type: "input_image", image_url: "data:image/jpeg;base64,AAAA" },
			{ type: "input_text", text: "describe it" },
		]);
	});

	it("forwards a url-source image as the bare URL", async () => {
		const body = await translate([
			{
				role: "user",
				content: [
					{
						type: "image",
						source: { type: "url", url: "https://example.com/shot.png" },
					},
				],
			},
		]);

		expect(body.input[0].content).toEqual([
			{ type: "input_image", image_url: "https://example.com/shot.png" },
		]);
	});

	it("rejects an image on an assistant message instead of reshaping the turn", async () => {
		// Responses has no image sibling for `output_text`. Coercing it to a user
		// item would rewrite who said what, and dropping it is the defect this
		// change exists to remove — so the request fails with a stated reason.
		await expect(
			new CodexProvider().transformRequestBody(
				messagesRequest([
					{
						role: "assistant",
						content: [
							{
								type: "image",
								source: { type: "base64", media_type: "image/png", data: "AA" },
							},
						],
					},
				]),
			),
		).rejects.toThrow(/assistant/i);
	});

	it("rejects a url source whose scheme the backend cannot fetch", async () => {
		// A url source is handed to the backend to fetch. `file:`/`blob:` would
		// point it at whatever host serves the request, so only network schemes
		// pass — matching what the chat-completions ingress accepts.
		for (const url of [
			"file:///etc/passwd",
			"blob:abc",
			"data:image/png;base64,AA",
		]) {
			await expect(
				new CodexProvider().transformRequestBody(
					messagesRequest([
						{
							role: "user",
							content: [{ type: "image", source: { type: "url", url } }],
						},
					]),
				),
			).rejects.toThrow(/image source url scheme/i);
		}
	});

	it("rejects an image whose source it cannot turn into a URL", async () => {
		await expect(
			new CodexProvider().transformRequestBody(
				messagesRequest([
					{
						role: "user",
						content: [{ type: "image", source: { type: "file" } }],
					},
				]),
			),
		).rejects.toThrow(/image source/i);
	});

	it("replaces a document block with a marker naming what was removed", async () => {
		const body = await translate([
			{
				role: "user",
				content: [
					{ type: "text", text: "summarise the attachment" },
					{
						type: "document",
						source: {
							type: "base64",
							media_type: "application/pdf",
							data: "JVBERi0x".repeat(1000),
						},
					},
				],
			},
		]);

		const content = body.input[0].content ?? [];
		expect(content).toHaveLength(2);
		expect(content[1]).toEqual({
			type: "input_text",
			text: "[application/pdf document removed: not supported on this backend]",
		});
		// Bounded: the base64 payload must not ride along inside the marker.
		expect(JSON.stringify(content[1]).length).toBeLessThan(200);
	});

	it("names a document without a media_type as unknown rather than dropping it", async () => {
		const body = await translate([
			{
				role: "user",
				content: [{ type: "document", source: { type: "text" } }],
			},
		]);

		expect(body.input[0].content).toEqual([
			{
				type: "input_text",
				text: "[document removed: not supported on this backend]",
			},
		]);
	});
});
