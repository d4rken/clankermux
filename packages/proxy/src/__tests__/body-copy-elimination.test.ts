/**
 * Guards for two per-request copy eliminations. Both replaced a defensive full
 * copy of a multi-megabyte body with a zero-copy path, so the only property
 * that matters is that the bytes coming out are unchanged. These tests pin that
 * directly rather than asserting on the mechanism.
 */

import { describe, expect, it } from "bun:test";
import { RequestBodyContext } from "../request-body-context";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("RequestBodyContext.getBuffer — encode without the defensive slice", () => {
	function naive(body: unknown): Uint8Array {
		return encoder.encode(JSON.stringify(body));
	}

	it("returns bytes identical to a plain encode after a mutation", () => {
		const body = { model: "a", messages: [{ role: "user", content: "hi" }] };
		const ctx = RequestBodyContext.fromParsed(null, structuredClone(body));
		ctx.setModel("claude-opus-5");

		const got = new Uint8Array(ctx.getBuffer() as ArrayBuffer);
		const want = naive({ ...body, model: "claude-opus-5" });
		expect(got).toEqual(want);
	});

	it("returns an exactly-sized buffer, with no slack from the encoder", () => {
		const ctx = RequestBodyContext.fromParsed(null, {
			model: "m",
			pad: "x".repeat(5000),
		});
		const buf = ctx.getBuffer() as ArrayBuffer;
		const expected = naive({ model: "m", pad: "x".repeat(5000) }).byteLength;
		// A shared or oversized buffer would leak unrelated bytes to whoever sends
		// this body upstream.
		expect(buf.byteLength).toBe(expected);
	});

	it("round-trips multi-byte UTF-8 without truncation", () => {
		// Byte length != character length here, which is exactly where an
		// offset/length mistake in a zero-copy path shows up.
		const content = "héllo 世界 🌍 café";
		const ctx = RequestBodyContext.fromParsed(null, { model: "m", content });
		ctx.setModel("m2");

		const decoded = JSON.parse(
			decoder.decode(ctx.getBuffer() as ArrayBuffer),
		) as { content: string; model: string };
		expect(decoded.content).toBe(content);
		expect(decoded.model).toBe("m2");
	});

	it("survives a body large enough to exercise the real size range", () => {
		const messages = Array.from({ length: 400 }, (_, i) => ({
			role: i % 2 === 0 ? "user" : "assistant",
			content: "lorem ipsum dolor sit amet ".repeat(30),
		}));
		const ctx = RequestBodyContext.fromParsed(null, { model: "m", messages });
		ctx.setModel("m2");

		const buf = ctx.getBuffer() as ArrayBuffer;
		expect(buf.byteLength).toBe(naive({ model: "m2", messages }).byteLength);
		const reparsed = JSON.parse(decoder.decode(buf)) as {
			messages: unknown[];
		};
		expect(reparsed.messages).toHaveLength(400);
	});

	it("re-encodes after each mutation rather than serving a stale buffer", () => {
		const ctx = RequestBodyContext.fromParsed(null, { model: "one" });
		const first = decoder.decode(ctx.getBuffer() as ArrayBuffer);
		ctx.setModel("two");
		const second = decoder.decode(ctx.getBuffer() as ArrayBuffer);

		expect(JSON.parse(first).model).toBe("one");
		expect(JSON.parse(second).model).toBe("two");
	});
});

describe("payload envelope base64 — wrapping instead of copying", () => {
	/**
	 * `Buffer.from(uint8array)` copies; `Buffer.from(buffer, byteOffset,
	 * byteLength)` wraps the same memory. The recorder now uses the wrapping
	 * form. These pin the equivalence, including the offset case that today's
	 * callers never produce — `reqBytes` is currently always an exactly-sized
	 * fresh array, so a future change to how it is built is precisely what would
	 * break a zero-copy path that ignored byteOffset.
	 */
	const wrap = (u8: Uint8Array): string =>
		Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString("base64");
	const copy = (u8: Uint8Array): string => Buffer.from(u8).toString("base64");

	it("produces identical base64 for an exactly-sized array", () => {
		const u8 = new Uint8Array(4096);
		for (let i = 0; i < u8.length; i++) u8[i] = (i * 31) % 256;
		expect(wrap(u8)).toBe(copy(u8));
	});

	it("respects byteOffset for a view into a larger buffer", () => {
		const backing = new Uint8Array(1024);
		for (let i = 0; i < backing.length; i++) backing[i] = i % 256;
		const view = backing.subarray(100, 500);

		expect(wrap(view)).toBe(copy(view));
		// And must not smuggle in the bytes on either side of the view.
		expect(Buffer.from(wrap(view), "base64")).toEqual(
			Buffer.from(backing.subarray(100, 500)),
		);
	});

	it("round-trips arbitrary binary bytes, including NUL and high bytes", () => {
		const u8 = new Uint8Array([0, 1, 127, 128, 254, 255, 0, 0, 65]);
		expect(wrap(u8)).toBe(copy(u8));
		expect(new Uint8Array(Buffer.from(wrap(u8), "base64"))).toEqual(u8);
	});

	it("handles an empty view without producing padding artefacts", () => {
		const u8 = new Uint8Array(0);
		expect(wrap(u8)).toBe(copy(u8));
		expect(wrap(u8)).toBe("");
	});
});
