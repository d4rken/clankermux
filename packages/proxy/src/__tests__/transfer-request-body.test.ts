/**
 * Real-Worker smoke test for ArrayBuffer transfer semantics.
 *
 * Mock workers can't validate that postMessage(msg, [transferable]) actually
 * detaches the sender-side buffer and moves ownership to the worker — mocks
 * just copy the reference. This test spins up a real Bun Worker (via a
 * minimal echo blob) to prove:
 *   (a) the sender-side ArrayBuffer is detached (byteLength === 0) after posting
 *   (b) the worker receives the bytes intact
 *
 * This is the only test that validates the transfer mechanism end-to-end.
 *
 * Run: bun test packages/proxy/src/__tests__/transfer-request-body.test.ts
 */
import { describe, expect, it } from "bun:test";

describe("usage worker request-body transfer", () => {
	it("transfers the ArrayBuffer (detaches sender, worker receives bytes intact)", async () => {
		// Minimal echo worker: receives a message with an ArrayBuffer body,
		// decodes it and posts back the decoded text + byteLength. This validates
		// Bun's transfer semantics directly, without booting the full
		// post-processor worker (which needs a DB + tiktoken).
		const workerSource = `
			self.onmessage = (ev) => {
				const body = ev.data.requestBody;
				self.postMessage({
					decoded: new TextDecoder().decode(body),
					byteLength: body.byteLength,
				});
			};
		`;
		const blob = new Blob([workerSource], { type: "text/javascript" });
		const url = URL.createObjectURL(blob);
		const worker = new Worker(url);

		try {
			const original = '{"system":"transfer-me","messages":[]}';
			const bytes = new TextEncoder().encode(original);
			// .slice() returns a fresh standalone ArrayBuffer — same pattern
			// response-handler.ts uses to avoid detaching the caller's body.
			const buffer = bytes.buffer.slice(0) as ArrayBuffer;

			const received = new Promise<{ decoded: string; byteLength: number }>(
				(resolve, reject) => {
					worker.onmessage = (ev: MessageEvent) => resolve(ev.data);
					worker.onerror = (err: ErrorEvent) => reject(err);
				},
			);

			worker.postMessage({ type: "start", requestBody: buffer }, [buffer]);

			// (a) Sender-side buffer is detached after transfer.
			expect(buffer.byteLength).toBe(0);

			// (b) Worker received the bytes intact.
			const result = await received;
			expect(result.byteLength).toBe(bytes.byteLength);
			expect(result.decoded).toBe(original);
		} finally {
			worker.terminate();
			URL.revokeObjectURL(url);
		}
	});

	it("null requestBody needs no transfer list", () => {
		// Mirrors the 503 pool-exhausted path in proxy.ts: requestBody is null,
		// so no transferable is produced and postMessage is called without a
		// transfer list. This is a pure type/shape test — no worker needed.
		const startMessage = {
			type: "start" as const,
			messageId: crypto.randomUUID(),
			requestId: "req-null-body",
			requestBody: null as ArrayBuffer | null,
		};

		const transfer = startMessage.requestBody
			? [startMessage.requestBody]
			: undefined;

		expect(transfer).toBeUndefined();
		expect(startMessage.requestBody).toBeNull();
	});

	it("slice() produces a safe-to-transfer copy without detaching the original", () => {
		// response-handler.ts uses requestBody.slice() to create a fresh copy
		// for transfer. This verifies slice() doesn't touch the original and
		// produces an independent ArrayBuffer.
		const original = new TextEncoder().encode("test payload");
		const sourceBuffer = original.buffer as ArrayBuffer;

		const copy = sourceBuffer.slice(
			0,
			Math.min(sourceBuffer.byteLength, 4 * 1024 * 1024),
		);

		// Original is untouched
		expect(sourceBuffer.byteLength).toBe(original.byteLength);
		// Copy is independent
		expect(copy.byteLength).toBe(sourceBuffer.byteLength);
		expect(new TextDecoder().decode(copy)).toBe("test payload");

		// Mutating the copy doesn't affect the original
		new Uint8Array(copy)[0] = 0xff;
		expect(original[0]).not.toBe(0xff);
	});
});
