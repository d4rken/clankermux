import { describe, expect, it } from "bun:test";
import { GrokSubscriptionProvider } from "../provider";
import { indexContentBlockDeltas } from "../response-stream";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

// Captured from cli-chat-proxy.grok.com: the deltas carry no `index`.
const XAI_STREAM = [
	'event: message_start\ndata: {"type":"message_start","message":{"id":"m","content":[]}}\n\n',
	'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
	'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"pi"}}\n\n',
	': xai-usage {"output_tokens":1}\n\n',
	'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"-ok"}}\n\n',
	'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
	'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t","name":"Bash","input":{}}}\n\n',
	'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"command\\":1}"}}\n\n',
	'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
	'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

function dataEvents(text: string): Record<string, unknown>[] {
	return text
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => JSON.parse(line.slice(6)));
}

describe("indexContentBlockDeltas", () => {
	it("gives each delta the index of the block it belongs to", async () => {
		const text = await new Response(
			indexContentBlockDeltas(streamOf(XAI_STREAM)),
		).text();
		const deltas = dataEvents(text).filter(
			(e) => e.type === "content_block_delta",
		);
		expect(deltas.map((d) => d.index)).toEqual([0, 0, 1]);
		expect(deltas[0]).toEqual({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "pi" },
		});
	});

	it("survives events split across chunk boundaries and keeps every other line", async () => {
		const whole = XAI_STREAM.join("");
		const chunks: string[] = [];
		for (let i = 0; i < whole.length; i += 7)
			chunks.push(whole.slice(i, i + 7));
		const text = await new Response(
			indexContentBlockDeltas(streamOf(chunks)),
		).text();
		expect(text).toContain(': xai-usage {"output_tokens":1}\n');
		expect(text).toContain("event: message_stop\n");
		expect(
			dataEvents(text)
				.filter((e) => e.type === "content_block_delta")
				.map((d) => d.index),
		).toEqual([0, 0, 1]);
	});

	it("leaves a delta that already names its block untouched", async () => {
		const line =
			'data: {"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":"x"}}\n\n';
		const text = await new Response(
			indexContentBlockDeltas(
				streamOf([
					'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
					line,
				]),
			),
		).text();
		expect(text).toEndWith(line);
	});
});

describe("GrokSubscriptionProvider.processResponse", () => {
	it("indexes deltas on a streamed response", async () => {
		const processed = await new GrokSubscriptionProvider().processResponse(
			new Response(streamOf(XAI_STREAM), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
			null,
		);
		const deltas = dataEvents(await processed.text()).filter(
			(e) => e.type === "content_block_delta",
		);
		expect(deltas.map((d) => d.index)).toEqual([0, 0, 1]);
	});

	it("passes a JSON response body through unchanged", async () => {
		const processed = await new GrokSubscriptionProvider().processResponse(
			new Response('{"type":"message"}', {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
			null,
		);
		expect(await processed.text()).toBe('{"type":"message"}');
	});
});
