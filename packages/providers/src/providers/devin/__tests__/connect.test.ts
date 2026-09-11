import { describe, expect, it } from "bun:test";
import { gzipSync } from "node:zlib";
import { DevinRpcError, decodeConnect, encodeConnect } from "../connect";

async function collect(body: ReadableStream<Uint8Array>) {
	const frames = [];
	for await (const frame of decodeConnect(body)) frames.push(frame);
	return frames;
}
function chunks(bytes: Uint8Array, size = 1) {
	return new ReadableStream<Uint8Array>({
		start(c) {
			for (let i = 0; i < bytes.length; i += size)
				c.enqueue(bytes.slice(i, i + size));
			c.close();
		},
	});
}
describe("Devin Connect framing", () => {
	it("preserves cancellation instead of reporting missing frames", async () => {
		const controller = new AbortController();
		const source = new ReadableStream<Uint8Array>();
		const result = decodeConnect(source, controller.signal).next();
		const reason = new DOMException("Disconnected", "AbortError");
		controller.abort(reason);
		await expect(result).rejects.toBe(reason);
	});
	it("handles split headers, compressed frames and clean end-stream envelopes", async () => {
		const data = new TextEncoder().encode("hello");
		const bytes = Buffer.concat([
			encodeConnect(gzipSync(data), 1),
			encodeConnect(new TextEncoder().encode("{}"), 2),
		]);
		expect(await collect(chunks(bytes))).toEqual([data]);
	});
	it("rejects HTTP-200 quota errors, incomplete frames and missing trailers", async () => {
		const error = encodeConnect(
			new TextEncoder().encode(
				JSON.stringify({
					error: { code: "resource_exhausted", message: "quota exhausted" },
				}),
			),
			2,
		);
		try {
			await collect(chunks(error));
			throw new Error("should reject");
		} catch (e) {
			expect(e).toBeInstanceOf(DevinRpcError);
			expect((e as DevinRpcError).status).toBe(429);
		}
		await expect(collect(chunks(new Uint8Array([0, 0, 0])))).rejects.toThrow(
			"truncated",
		);
		await expect(
			collect(chunks(encodeConnect(new Uint8Array([1])))),
		).rejects.toThrow("end-stream");
		await expect(
			collect(chunks(encodeConnect(new TextEncoder().encode("invalid"), 2))),
		).rejects.toThrow("trailer");
	});
	it("rejects oversized lengths before buffering and releases upstream on return", async () => {
		await expect(
			collect(chunks(new Uint8Array([0, 127, 255, 255, 255]))),
		).rejects.toThrow("limit");
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(encodeConnect(new Uint8Array([1])));
			},
			cancel() {
				cancelled = true;
			},
		});
		for await (const _frame of decodeConnect(body)) break;
		expect(cancelled).toBe(true);
	});
});
