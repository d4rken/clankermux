import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import {
	buildPayloadFrame,
	envelopeFromPayloadFrame,
	payloadFrameBytes,
} from "./payload-frame";

const skeletonOf = (meta: unknown) =>
	JSON.stringify({
		request: { headers: { "user-agent": "claude-cli/2.1" }, body: null },
		response: { status: 200, headers: {}, body: null },
		meta,
	});

/** The same parts in the legacy text form (`request_payloads.json`). */
const textEnvelope = (
	meta: unknown,
	req: Uint8Array | null,
	resp: Uint8Array | null,
) =>
	JSON.stringify({
		request: {
			headers: { "user-agent": "claude-cli/2.1" },
			body: req?.byteLength ? Buffer.from(req).toString("base64") : null,
		},
		response: {
			status: 200,
			headers: {},
			body: resp?.byteLength ? Buffer.from(resp).toString("base64") : null,
		},
		meta,
	});

describe("payload frame", () => {
	it("matches the documented layout", () => {
		const frame = buildPayloadFrame(
			JSON.stringify({ request: { body: null }, response: { body: null } }),
			new TextEncoder().encode("hi"),
			[],
		);
		expect(Buffer.from(frame.subarray(0, 12)).toString("hex")).toBe(
			"3200000002000000ffffffff",
		);
		expect(Buffer.from(frame.subarray(-2)).toString()).toBe("hi");
	});

	it("rebuilds the text envelope exactly: binary bodies, non-ASCII meta, chunk boundaries", () => {
		const meta = { project: "日本語-プロジェクト", emoji: "🚀", n: 1 };
		const req = randomBytes(4099);
		const resp = randomBytes(10_000);
		const chunks = [
			resp.subarray(0, 1),
			resp.subarray(1, 4097),
			resp.subarray(4097),
		];
		const frame = buildPayloadFrame(skeletonOf(meta), req, chunks);
		expect(JSON.stringify(envelopeFromPayloadFrame(frame))).toBe(
			textEnvelope(meta, req, resp),
		);
	});

	it("stores absent and empty bodies as null", () => {
		for (const req of [null, new Uint8Array(0)]) {
			const frame = buildPayloadFrame(skeletonOf({}), req, [new Uint8Array(0)]);
			expect(Buffer.from(frame.subarray(4, 12)).toString("hex")).toBe(
				"ffffffffffffffff",
			);
			expect(JSON.stringify(envelopeFromPayloadFrame(frame))).toBe(
				textEnvelope({}, null, null),
			);
		}
	});

	it("allocates exactly the frame and copies the bodies", () => {
		const req = new Uint8Array([1, 2, 3]);
		const skeleton = skeletonOf({ project: "日本語" });
		const chunks = [Uint8Array.of(4), Uint8Array.of(5, 6)];
		expect(buildPayloadFrame(skeleton, req, chunks).byteLength).toBe(
			payloadFrameBytes(skeleton, req, chunks),
		);

		const frame = buildPayloadFrame(skeletonOf({}), req, []);
		expect(frame.byteOffset).toBe(0);
		expect(frame.buffer.byteLength).toBe(frame.byteLength);
		req[0] = 9;
		expect(frame[frame.byteLength - 3]).toBe(1);
	});

	it("reads a frame that sits inside a larger buffer", () => {
		const frame = buildPayloadFrame(skeletonOf({}), Uint8Array.of(7), []);
		const padded = new Uint8Array(frame.byteLength + 8);
		padded.set(frame, 4);
		const view = padded.subarray(4, 4 + frame.byteLength);
		expect(envelopeFromPayloadFrame(view).request.body).toBe("Bw==");
	});

	it("rejects corrupt frames", () => {
		const frame = buildPayloadFrame(skeletonOf({}), Uint8Array.of(7), []);
		const header = (bytes: Uint8Array) =>
			new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

		expect(() => envelopeFromPayloadFrame(frame.subarray(0, 8))).toThrow(
			"shorter than its header",
		);
		const trailing = new Uint8Array(frame.byteLength + 1);
		trailing.set(frame);
		expect(() => envelopeFromPayloadFrame(trailing)).toThrow("do not match");
		expect(() => envelopeFromPayloadFrame(frame.subarray(0, -1))).toThrow(
			"do not match",
		);

		const zeroLength = frame.slice();
		header(zeroLength).setUint32(4, 0, true);
		header(zeroLength).setUint32(0, header(frame).getUint32(0, true) + 1, true);
		expect(() => envelopeFromPayloadFrame(zeroLength)).toThrow("zero-length");

		const notEnvelope = buildPayloadFrame(
			JSON.stringify({ request: {} }),
			null,
			[],
		);
		expect(() => envelopeFromPayloadFrame(notEnvelope)).toThrow(
			"not an envelope",
		);
		const filledBody = buildPayloadFrame(
			JSON.stringify({ request: { body: "x" }, response: { body: null } }),
			null,
			[],
		);
		expect(() => envelopeFromPayloadFrame(filledBody)).toThrow(
			"not an envelope",
		);
	});
});
