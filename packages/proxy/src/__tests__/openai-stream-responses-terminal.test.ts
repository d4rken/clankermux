import { describe, expect, test } from "bun:test";
import { transformStreamingResponse } from "@clankermux/openai-formats";
import {
	type HandleProxyFn,
	handleResponsesRequest,
} from "@clankermux/openai-responses-adapter";

/**
 * An OpenAI-compatible upstream converted to Anthropic SSE, then translated to
 * the Responses stream a /wire/openai client reads. Returns the terminal
 * events it carried.
 */
async function terminalsOf(
	deltas: Array<{ delta: Record<string, unknown>; finish_reason?: string }>,
	request: Record<string, unknown> = {},
): Promise<string[]> {
	const upstream = new Response(
		[
			...deltas.map((d) =>
				JSON.stringify({ model: "m", choices: [{ index: 0, ...d }] }),
			),
			"[DONE]",
		]
			.map((c) => `data: ${c}\n\n`)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
	const handleProxy: HandleProxyFn = async () =>
		transformStreamingResponse(upstream);
	const req = new Request("http://localhost/v1/responses", {
		method: "POST",
		body: JSON.stringify({ model: "m", input: "Hi", stream: true, ...request }),
		headers: { "Content-Type": "application/json" },
	});
	const raw = await (
		await handleResponsesRequest(req, new URL(req.url), handleProxy, {})
	).text();
	return raw
		.split("\n")
		.filter((line) =>
			/^event: response\.(completed|incomplete|failed)$/.test(line),
		);
}

describe("an OpenAI stream's end through the Responses translation", () => {
	test("an empty reply completes", async () => {
		expect(
			await terminalsOf([
				{ delta: { role: "assistant" } },
				{ delta: {}, finish_reason: "stop" },
			]),
		).toEqual(["event: response.completed"]);
	});

	const cutOff = [
		{ delta: { role: "assistant", content: "Hel" } },
		{ delta: {}, finish_reason: "length" },
	];

	test("a reply cut off by the client's own cap is incomplete", async () => {
		expect(await terminalsOf(cutOff, { max_output_tokens: 3 })).toEqual([
			"event: response.incomplete",
		]);
	});

	test("a reply cut off by the supplied cap completes", async () => {
		expect(await terminalsOf(cutOff)).toEqual(["event: response.completed"]);
	});
});
