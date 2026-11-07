import { describe, expect, it } from "bun:test";
import { isImageInputRefusal } from "../image-input-refusal";

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

describe("isImageInputRefusal", () => {
	it.each([
		[
			"DeepSeek",
			400,
			{
				error: {
					message:
						"Failed to deserialize the JSON body into the target type: messages[0]: unknown variant `image_url`, expected `text`",
				},
			},
		],
		[
			"OpenRouter-shaped 404",
			404,
			{ error: { message: "No endpoints found that support image input" } },
		],
		[
			"a model without vision",
			400,
			{ error: { message: "This model does not support image input." } },
		],
		["top-level detail", 400, { detail: "Image content is not supported" }],
		[
			"pydantic loc/msg split",
			400,
			{
				detail: [
					{
						loc: ["body", "messages", 0, "content", 1, "image_url"],
						msg: "Extra inputs are not permitted",
					},
				],
			},
		],
	])("matches %s", async (_label, status, body) => {
		expect(await isImageInputRefusal(json(status, body))).toBe(true);
	});

	it.each([
		[
			"a malformed image",
			400,
			{ error: { message: "Invalid image_url: invalid base64 data" } },
		],
		[
			"an oversized image",
			400,
			{ error: { message: "Image exceeds the maximum size, not supported" } },
		],
		[
			"a policy refusal",
			400,
			{ error: { message: "Image not supported: blocked by content policy" } },
		],
		[
			"a cache_control rejection",
			400,
			{ error: { message: "cache_control: Extra inputs are not permitted" } },
		],
		["a model-not-found 404", 404, { error: { message: "Model not found" } }],
		[
			"another status",
			422,
			{ error: { message: "This model does not support image input." } },
		],
	])("ignores %s", async (_label, status, body) => {
		expect(await isImageInputRefusal(json(status, body))).toBe(false);
	});

	it("ignores a non-JSON body", async () => {
		const res = new Response("image input not supported", { status: 400 });
		expect(await isImageInputRefusal(res)).toBe(false);
	});

	it("leaves the response body readable", async () => {
		const res = json(400, {
			error: { message: "This model does not support image input." },
		});
		await isImageInputRefusal(res);
		expect(((await res.json()) as { error: object }).error).toBeDefined();
	});
});
