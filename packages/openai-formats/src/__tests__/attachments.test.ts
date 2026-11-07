import { describe, expect, it } from "bun:test";
import { IMAGE_REMOVED_MARKER, replaceImageParts } from "../attachments";
import type { OpenAIRequest } from "../types";

describe("replaceImageParts", () => {
	it("replaces every image_url part with the removal marker in place", () => {
		const body: OpenAIRequest = {
			model: "deepseek-chat",
			messages: [
				{ role: "tool", tool_call_id: "c1", content: "shot taken" },
				{
					role: "user",
					content: [
						{
							type: "image_url",
							image_url: { url: "data:image/png;base64,AA" },
						},
						{
							type: "text",
							text: "what is this?",
							cache_control: { type: "ephemeral" },
						},
						{ type: "image_url", image_url: { url: "https://x/y.png" } },
					],
				},
			],
		};
		expect(replaceImageParts(body)).toBe(2);
		expect(body.messages[1]?.content).toEqual([
			{ type: "text", text: IMAGE_REMOVED_MARKER },
			{
				type: "text",
				text: "what is this?",
				cache_control: { type: "ephemeral" },
			},
			{ type: "text", text: IMAGE_REMOVED_MARKER },
		]);
		expect(body.messages[0]?.content).toBe("shot taken");
	});

	it("reports zero for a body without images", () => {
		expect(
			replaceImageParts({
				model: "m",
				messages: [{ role: "user", content: "hi" }],
			}),
		).toBe(0);
	});

	it("tolerates a body that is not a chat request", () => {
		expect(replaceImageParts({ input: [] } as unknown as OpenAIRequest)).toBe(
			0,
		);
	});
});
