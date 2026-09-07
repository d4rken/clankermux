import { describe, expect, it } from "bun:test";
import { peekZaiOverload, recoverZaiOverload } from "../zai-overload";

const error = 'data: {"error":{"code":1305,"message":"overloaded"}}\n\n';
function sse(chunks: string[]) {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(c) {
				for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
				c.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

describe("Zai leading SSE overload", () => {
	it("recognizes a split, multiline CRLF error after a heartbeat", async () => {
		expect(
			await peekZaiOverload(
				sse([
					': ping\r\n\r\ndata: {"error":\r\ndata: {"code":',
					"1305}}\r\n\r\n",
				]),
			),
		).toBe(true);
	});
	it("leaves the original bytes readable", async () => {
		const response = sse([error]);
		expect(await peekZaiOverload(response)).toBe(true);
		expect(await response.text()).toBe(error);
	});
	it("does not retry after model output, including when a later error shares its chunk", async () => {
		const response = sse([`data: {"type":"message_start"}\n\n${error}`]);
		expect(await peekZaiOverload(response)).toBe(false);
	});
	it("does not confuse quoted error payloads with root error objects", async () => {
		expect(
			await peekZaiOverload(
				sse([
					`data: ${JSON.stringify({ choices: [{ delta: { content: error } }] })}\n\n`,
				]),
			),
		).toBe(false);
	});
	it("stops on the first healthy frame without waiting for EOF or the deadline", async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(c) {
					controller = c;
					c.enqueue(
						new TextEncoder().encode('data: {"type":"message_start"}\n\n'),
					);
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);
		const started = Date.now();
		expect(await peekZaiOverload(response)).toBe(false);
		expect(Date.now() - started).toBeLessThan(250);
		controller.close();
		await response.text();
	});
	it("bounds a stalled peek while preserving data arriving after the deadline", async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(c) {
					controller = c;
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);
		const started = Date.now();
		expect(await peekZaiOverload(response, undefined, 20)).toBe(false);
		expect(Date.now() - started).toBeLessThan(250);
		controller.enqueue(new TextEncoder().encode("late data"));
		controller.close();
		expect(await response.text()).toBe("late data");
	});
	it("bounds inspection and ignores overload outside the byte cap", async () => {
		expect(
			await peekZaiOverload(sse([`:${"x".repeat(5000)}\n\n${error}`])),
		).toBe(false);
	});
	it("propagates abort without waiting for the peek deadline", async () => {
		const controller = new AbortController();
		const response = new Response(new ReadableStream(), {
			headers: { "content-type": "text/event-stream" },
		});
		const pending = peekZaiOverload(response, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow();
		await response.body?.cancel();
	});
	it("retries once and returns a successful retry", async () => {
		let calls = 0;
		const result = await recoverZaiOverload(sse([error]), async () => {
			calls++;
			return sse(['data: {"type":"message_start"}\n\n']);
		});
		expect(calls).toBe(1);
		expect(result.status).toBe(200);
		await result.text();
	});
	it("converts repeated overload into 529, not quota exhaustion", async () => {
		const result = await recoverZaiOverload(sse([error]), async () =>
			sse([error]),
		);
		expect(result.status).toBe(529);
		expect((await result.json()).error.code).toBe(1305);
	});
	it("does not inspect non-SSE retries or non-200 responses", async () => {
		const result = await recoverZaiOverload(sse([error]), async () =>
			Response.json({ error: { code: 1305 } }, { status: 401 }),
		);
		expect(result.status).toBe(401);
		expect(await peekZaiOverload(new Response(error, { status: 429 }))).toBe(
			false,
		);
	});
});
