import { describe, expect, it } from "bun:test";
import { buildSyntheticCountTokensRequest } from "./synthetic-count-tokens";

const request = (body: unknown) =>
	new Request("https://clankermux.local/openrouter/count_tokens", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
const body = (content: unknown) => ({
	model: "deepseek/deepseek-v4-pro",
	messages: [{ role: "user", content }],
});
async function count(value: unknown) {
	const result = await buildSyntheticCountTokensRequest(request(value));
	expect(result.headers.get("x-clankermux-synthetic-status")).toBe("200");
	return (await result.json()).input_tokens as number;
}

describe("local token estimate", () => {
	it("preserves the existing text heuristic, including system and tool definitions", async () => {
		const value = {
			...body("hello"),
			system: "Be concise",
			tools: [{ name: "read", input_schema: { type: "object" } }],
		};
		expect(await count(value)).toBe(
			Math.ceil(JSON.stringify(value).length / 3),
		);
	});
	it("counts nested tool-result images independently of base64 size", async () => {
		const value = (size: number) =>
			body([
				{
					type: "tool_result",
					tool_use_id: "read-1",
					content: [
						{
							type: "image",
							source: {
								type: "base64",
								media_type: "image/png",
								data: "A".repeat(size),
							},
						},
					],
				},
			]);
		const small = await count(value(100));
		expect(await count(value(100_000))).toBe(small);
		expect(small).toBeGreaterThanOrEqual(2000);
		expect(small).toBeLessThan(2500);
	});
	it.each([
		null,
		[],
		{},
		{ model: "m", messages: null },
		body(null),
		body([null]),
	])("rejects malformed request structure: %j", async (value) => {
		const result = await buildSyntheticCountTokensRequest(request(value));
		expect(result.headers.get("x-clankermux-synthetic-status")).toBe("400");
		expect((await result.json()).error.type).toBe("invalid_request_error");
	});
	it("requires no inference-only max_tokens and counts an empty message", async () => {
		expect(await count(body(""))).toBeGreaterThanOrEqual(1);
	});
});
