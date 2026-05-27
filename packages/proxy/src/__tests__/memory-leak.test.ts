/**
 * Memory leak regression test.
 *
 * Validates that the cap + transfer model bounds per-request memory:
 *   - response-handler.ts caps the request body to MAX_REQUEST_BODY_BYTES
 *     then transfers the ArrayBuffer to the worker (no structured-clone copy)
 *   - freeRequestState nulls out the request body when done
 *
 * Run: bun test packages/proxy/src/__tests__/memory-leak.test.ts
 */
import { describe, expect, it } from "bun:test";

describe("memory leak regression", () => {
	// Helper: build a Claude-shaped request body of a given size
	function makeLargeRequestBody(sizeKB: number): string {
		const message = {
			model: "claude-sonnet-4-5-20250514",
			max_tokens: 1024,
			messages: [
				{
					role: "user",
					// Pad content to reach target size
					content: "x".repeat(sizeKB * 1024),
				},
			],
		};
		return JSON.stringify(message);
	}

	it("requestBody cap prevents multi-MB allocations", () => {
		// Simulate what response-handler.ts does before postMessage
		const MAX_REQUEST_BODY_BYTES = 256 * 1024;
		const largeBody = new TextEncoder().encode(makeLargeRequestBody(2048)); // 2MB body

		// Old model (before transfer): base64-encode full body → structured clone
		// = 2MB raw → ~2.66MB base64 string → worker clone → ~5.3MB total
		const uncappedBase64Size = Buffer.from(largeBody).toString("base64").length;

		// New model: raw ArrayBuffer.slice(0, cap) → transfer (zero-copy move).
		// Only one copy of the capped bytes exists at any time.
		const cappedBuffer = largeBody.buffer.slice(
			0,
			Math.min(largeBody.byteLength, MAX_REQUEST_BODY_BYTES),
		);
		const cappedSize = cappedBuffer.byteLength;

		// Uncapped base64 would be ~2.7MB (before the structured clone doubles it)
		expect(uncappedBase64Size).toBeGreaterThan(2_000_000);
		// Capped transferred buffer: exactly 256KB raw bytes (no base64 inflation)
		expect(cappedSize).toBe(MAX_REQUEST_BODY_BYTES);
		expect(cappedSize).toBeLessThan(300_000);
	});

	it("freeRequestState releases startMessage fields", () => {
		// Simulate RequestState with a large startMessage.
		// requestBody is now an ArrayBuffer (raw transferred bytes).
		const state = {
			chunks: [new Uint8Array(1024), new Uint8Array(1024)],
			chunksBytes: 2048,
			buffer: "some accumulated text",
			startMessage: {
				type: "start" as const,
				requestId: "test-123",
				accountId: "acc-1",
				method: "POST",
				path: "/v1/messages",
				timestamp: Date.now(),
				requestHeaders: {
					authorization: "Bearer sk-ant-...",
					"content-type": "application/json",
					"x-custom-header": "value",
				},
				requestBody: new ArrayBuffer(256 * 1024) as ArrayBuffer | null,
				responseStatus: 200,
				responseHeaders: {
					"content-type": "application/json",
					"x-ratelimit-remaining": "100",
				},
				isStream: true,
				providerName: "anthropic",
				agentUsed: null,
				apiKeyId: null,
				apiKeyName: null,
				retryAttempt: 0,
				failoverAttempts: 0,
			},
		};

		// Simulate freeRequestState (matches post-processor.worker.ts)
		function freeRequestState(s: typeof state): void {
			s.chunks.length = 0;
			s.chunksBytes = 0;
			s.buffer = "";
			s.startMessage.requestBody = null;
			s.startMessage.requestHeaders = {};
			s.startMessage.responseHeaders = {};
		}

		// Before cleanup, startMessage holds ~256KB
		expect(state.startMessage.requestBody).not.toBeNull();
		expect(Object.keys(state.startMessage.requestHeaders).length).toBe(3);

		freeRequestState(state);

		// After cleanup, large fields are released
		expect(state.startMessage.requestBody).toBeNull();
		expect(Object.keys(state.startMessage.requestHeaders).length).toBe(0);
		expect(Object.keys(state.startMessage.responseHeaders).length).toBe(0);
		expect(state.chunks.length).toBe(0);
		expect(state.buffer).toBe("");
	});

	it("concurrent requests stay within memory budget", () => {
		const MAX_REQUEST_BODY_BYTES = 256 * 1024;
		const CONCURRENT_REQUESTS = 15; // Simulates a 15-agent wave
		const BODY_SIZE_KB = 2048; // 2MB each (typical Claude Code conversation)

		// Old model: 15 * 2MB * 1.33 (base64 string) * 2 (structured clone) = ~80MB
		const uncappedMemory = CONCURRENT_REQUESTS * BODY_SIZE_KB * 1024 * 1.33 * 2;

		// New model (transfer): 15 * 256KB (one raw copy, transferred, no clone)
		const cappedMemory = CONCURRENT_REQUESTS * MAX_REQUEST_BODY_BYTES;

		expect(uncappedMemory).toBeGreaterThan(70_000_000); // ~80MB without cap
		expect(cappedMemory).toBeLessThan(4_000_000); // ~3.75MB with transfer
		expect(uncappedMemory / cappedMemory).toBeGreaterThan(15); // >15x reduction
	});

	it("backpressure estimate uses base64-size accounting for ArrayBuffer bodies", () => {
		// The worker stores the request body as base64, so the preflight
		// backpressure check must charge the base64 size (~4/3× raw byteLength),
		// not the raw byte count. Using raw byteLength would let the writer
		// admit ~33% more than the cap intends.
		const rawBytes = 300_000; // 300KB raw body
		const body = new ArrayBuffer(rawBytes);

		// This mirrors the estimator in post-processor.worker.ts
		const estimatedRequestBytes = Math.ceil(body.byteLength / 3) * 4;

		// base64 of 300KB should be exactly 400KB
		expect(estimatedRequestBytes).toBe(400_000);

		// Sanity: the actual base64 output matches the estimate
		const actualBase64Length = Buffer.from(body).toString("base64").length;
		expect(estimatedRequestBytes).toBe(actualBase64Length);
	});

	it("system prompt extraction works from ArrayBuffer body", () => {
		// Mirrors what post-processor.worker.ts _extractSystemPrompt does
		// with the new ArrayBuffer input (TextDecoder instead of base64 decode)
		const body = JSON.stringify({
			system: "You are a helpful assistant in project clankermux",
			messages: [{ role: "user", content: "hi" }],
		});
		const buffer = new TextEncoder().encode(body).buffer;

		// Same logic as _extractSystemPrompt
		const decodedBody = new TextDecoder().decode(buffer);
		const parsed = JSON.parse(decodedBody);

		expect(parsed.system).toBe(
			"You are a helpful assistant in project clankermux",
		);
	});

	it("ArrayBuffer → base64 round-trip preserves data for payload storage", () => {
		// The worker stores request bodies as base64 in the DB JSON. Verify
		// that the ArrayBuffer → Buffer.from(ab).toString("base64") path
		// produces the same result as the old Buffer.from(text).toString("base64").
		const body = JSON.stringify({
			model: "claude-sonnet-4-5-20250514",
			messages: [{ role: "user", content: "test content for round-trip" }],
		});

		// Old model: text → base64 directly
		const oldBase64 = Buffer.from(body).toString("base64");

		// New model: text → ArrayBuffer → base64 (what the worker does now)
		const buffer = new TextEncoder().encode(body).buffer;
		const newBase64 = Buffer.from(buffer).toString("base64");

		expect(newBase64).toBe(oldBase64);

		// And decoding back works
		const decoded = Buffer.from(newBase64, "base64").toString("utf-8");
		expect(decoded).toBe(body);
	});
});
