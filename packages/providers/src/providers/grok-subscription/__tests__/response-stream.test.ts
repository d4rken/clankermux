import { describe, expect, it } from "bun:test";
import { GrokSubscriptionProvider } from "../provider";
import { numberContentBlocks } from "../response-stream";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

const event = (type: string, fields: Record<string, unknown> = {}) =>
	`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;

// The shape cli-chat-proxy.grok.com streams: every block starts and stops as
// index 0, and deltas carry no index at all.
const XAI_STREAM = [
	event("message_start", { message: { id: "m", content: [] } }),
	event("content_block_start", {
		index: 0,
		content_block: { type: "thinking", thinking: "" },
	}),
	event("content_block_delta", {
		delta: { type: "thinking_delta", thinking: "hm" },
	}),
	event("content_block_stop", { index: 0 }),
	event("content_block_start", {
		index: 0,
		content_block: { type: "text", text: "" },
	}),
	event("content_block_delta", { delta: { type: "text_delta", text: "run" } }),
	': xai-usage {"output_tokens":1}\n\n',
	event("content_block_stop", { index: 0 }),
	event("content_block_start", {
		index: 0,
		content_block: { type: "tool_use", id: "t", name: "exec", input: {} },
	}),
	event("content_block_delta", {
		delta: { type: "input_json_delta", partial_json: '{"cmd":"ls"}' },
	}),
	event("content_block_stop", { index: 0 }),
	event("message_stop"),
];

function blockEvents(text: string): [string, unknown][] {
	return text
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
		.filter((e) => String(e.type).startsWith("content_block_"))
		.map((e) => [e.type as string, e.index]);
}

const NUMBERED: [string, unknown][] = [
	["content_block_start", 0],
	["content_block_delta", 0],
	["content_block_stop", 0],
	["content_block_start", 1],
	["content_block_delta", 1],
	["content_block_stop", 1],
	["content_block_start", 2],
	["content_block_delta", 2],
	["content_block_stop", 2],
];

describe("numberContentBlocks", () => {
	it("numbers blocks in order and gives deltas and stops their block's number", async () => {
		const text = await new Response(
			numberContentBlocks(streamOf(XAI_STREAM)),
		).text();
		expect(blockEvents(text)).toEqual(NUMBERED);
	});

	it("survives events split across chunk boundaries and keeps every other line", async () => {
		const whole = XAI_STREAM.join("");
		const chunks: string[] = [];
		for (let i = 0; i < whole.length; i += 7)
			chunks.push(whole.slice(i, i + 7));
		const text = await new Response(
			numberContentBlocks(streamOf(chunks)),
		).text();
		expect(text).toContain(': xai-usage {"output_tokens":1}\n');
		expect(text).toContain("event: message_stop\n");
		expect(blockEvents(text)).toEqual(NUMBERED);
	});

	it("passes a stream that already numbers its blocks through byte for byte", async () => {
		const conforming = [
			event("content_block_start", {
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			event("content_block_delta", {
				index: 0,
				delta: { type: "text_delta", text: "x" },
			}),
			event("content_block_stop", { index: 0 }),
			event("content_block_start", {
				index: 1,
				content_block: { type: "text", text: "" },
			}),
			event("content_block_stop", { index: 1 }),
		];
		const text = await new Response(
			numberContentBlocks(streamOf(conforming)),
		).text();
		expect(text).toBe(conforming.join(""));
	});
});

describe("GrokSubscriptionProvider.processResponse", () => {
	it("numbers the blocks of a streamed response", async () => {
		const processed = await new GrokSubscriptionProvider().processResponse(
			new Response(streamOf(XAI_STREAM), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
			null,
		);
		expect(blockEvents(await processed.text())).toEqual(NUMBERED);
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
