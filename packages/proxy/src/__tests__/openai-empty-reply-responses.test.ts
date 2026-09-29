import { describe, expect, test } from "bun:test";
import { transformStreamingResponse } from "@clankermux/openai-formats";
import {
	type HandleProxyFn,
	handleResponsesRequest,
} from "@clankermux/openai-responses-adapter";

/**
 * An OpenAI-compatible upstream converted to Anthropic SSE, then translated to
 * the Responses stream a /wire/openai client reads.
 */
describe("an empty OpenAI reply through the Responses translation", () => {
	test("completes", async () => {
		const chunks = [
			{ choices: [{ index: 0, delta: { role: "assistant" } }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		];
		const upstream = new Response(
			[...chunks.map((c) => JSON.stringify({ model: "m", ...c })), "[DONE]"]
				.map((c) => `data: ${c}\n\n`)
				.join(""),
			{ headers: { "content-type": "text/event-stream" } },
		);
		const handleProxy: HandleProxyFn = async () =>
			transformStreamingResponse(upstream);
		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({ model: "m", input: "Hi", stream: true }),
			headers: { "Content-Type": "application/json" },
		});

		const raw = await (
			await handleResponsesRequest(req, new URL(req.url), handleProxy, {})
		).text();

		const terminals = raw
			.split("\n")
			.filter((line) =>
				/^event: response\.(completed|incomplete|failed)$/.test(line),
			);
		expect(terminals).toEqual(["event: response.completed"]);
	});
});
