import { describe, expect, it, mock } from "bun:test";
import { forwardToClient } from "../response-handler";

describe("forwardToClient worker protocol", () => {
	// Production passes requestBody as a real ArrayBuffer (RequestBodyContext
	// .getBuffer() returns ArrayBuffer | null). Encode test bodies the same way
	// so .slice() yields a transferable ArrayBuffer rather than a Uint8Array.
	function toArrayBuffer(s: string): ArrayBuffer {
		const bytes = new TextEncoder().encode(s);
		return bytes.buffer.slice(
			bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength,
		) as ArrayBuffer;
	}

	async function waitFor(
		predicate: () => boolean,
		timeoutMs = 1000,
	): Promise<void> {
		const start = Date.now();
		while (!predicate()) {
			if (Date.now() - start > timeoutMs) {
				throw new Error("Timed out waiting for condition");
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	function createCtx(
		postMessage: (msg: Record<string, unknown>) => void,
		storePayloads = true,
	) {
		const usageWorker = {
			postMessage: mock(postMessage),
		} as unknown as import("../usage-worker-controller").UsageWorkerController;

		const ctx = {
			strategy: {},
			dbOps: {},
			runtime: { port: 8080, tlsEnabled: false },
			config: {
				getStorePayloads: () => storePayloads,
			},
			provider: {
				name: "anthropic",
				isStreamingResponse: () => false,
			},
			refreshInFlight: new Map<string, Promise<string>>(),
			asyncWriter: {},
			usageWorker,
		} as unknown as import("../handlers").ProxyContext;

		return { ctx, usageWorker };
	}

	it("sends start message with messageId", async () => {
		const posted: Array<Record<string, unknown>> = [];
		const { ctx, usageWorker } = createCtx((msg) => posted.push(msg));

		const response = await forwardToClient(
			{
				requestId: "req-1",
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: toArrayBuffer("{}"),
				response: new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);

		expect(response.status).toBe(200);
		expect(usageWorker.postMessage).toHaveBeenCalled();
		expect(posted.length).toBeGreaterThan(0);
		expect(posted[0].type).toBe("start");
		expect(typeof posted[0].messageId).toBe("string");
		expect((posted[0].messageId as string).length).toBeGreaterThan(0);
	});

	it("strips client identity headers from persisted request headers", async () => {
		const posted: Array<Record<string, unknown>> = [];
		const { ctx } = createCtx((msg) => posted.push(msg));

		await forwardToClient(
			{
				requestId: "req-identity-headers",
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({
					"content-type": "application/json",
					"x-claude-code-session-id": "claude-session-id",
					"thread-id": "codex-thread-id",
					"session-id": "codex-session-id",
					"x-client-request-id": "client-request-id",
					"x-codex-installation-id": "codex-installation-id",
					"x-codex-window-id": "codex-thread-id:1",
					"x-codex-turn-state": "turn-state-token",
					"chatgpt-account-id": "chatgpt-account-id",
					traceparent:
						"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
					tracestate: "vendor=value",
				}),
				requestBody: toArrayBuffer("{}"),
				response: new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);

		const requestHeaders = posted[0].requestHeaders as Record<string, string>;
		expect(requestHeaders["content-type"]).toBe("application/json");
		expect(requestHeaders["x-claude-code-session-id"]).toBeUndefined();
		expect(requestHeaders["thread-id"]).toBeUndefined();
		expect(requestHeaders["session-id"]).toBeUndefined();
		expect(requestHeaders["x-client-request-id"]).toBeUndefined();
		expect(requestHeaders["x-codex-installation-id"]).toBeUndefined();
		expect(requestHeaders["x-codex-window-id"]).toBeUndefined();
		expect(requestHeaders["x-codex-turn-state"]).toBeUndefined();
		expect(requestHeaders["chatgpt-account-id"]).toBeUndefined();
		expect(requestHeaders.traceparent).toBeUndefined();
		expect(requestHeaders.tracestate).toBeUndefined();
	});

	it("sends null requestBody when payload storage is disabled", async () => {
		const posted: Array<Record<string, unknown>> = [];
		const { ctx } = createCtx((msg) => posted.push(msg), false);

		await forwardToClient(
			{
				requestId: "req-no-payload",
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: toArrayBuffer(
					JSON.stringify({ system: "test", messages: [] }),
				),
				project: "main-thread-project",
				response: new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);

		expect(posted[0].type).toBe("start");
		expect(posted[0].requestBody).toBeNull();
		expect(posted[0].project).toBe("main-thread-project");
	});

	it("preserves requestBody when payload storage is enabled", async () => {
		const posted: Array<Record<string, unknown>> = [];
		const { ctx } = createCtx((msg) => posted.push(msg), true);
		const requestBody = JSON.stringify({ system: "test", messages: [] });

		await forwardToClient(
			{
				requestId: "req-payload",
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: toArrayBuffer(requestBody),
				project: null,
				response: new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);

		expect(posted[0].type).toBe("start");
		// requestBody is now a raw ArrayBuffer (transferred to the worker, then
		// base64-encoded there at save time) rather than a base64 string. These
		// are mock workers, so the buffer is not actually detached — we verify
		// shape and content, not the transfer itself (see the real-Worker smoke
		// test for that).
		expect(posted[0].requestBody).toBeInstanceOf(ArrayBuffer);
		expect(new TextDecoder().decode(posted[0].requestBody as ArrayBuffer)).toBe(
			requestBody,
		);
		expect(posted[0].project).toBeNull();
	});

	it("does not throw when worker is not ready", async () => {
		const usageWorker = {
			postMessage: mock(() => {
				throw new Error("worker not ready");
			}),
		} as unknown as import("../usage-worker-controller").UsageWorkerController;

		const ctx = {
			strategy: {},
			dbOps: {},
			runtime: { port: 8080, tlsEnabled: false },
			config: {},
			provider: {
				name: "anthropic",
				isStreamingResponse: () => false,
			},
			refreshInFlight: new Map<string, Promise<string>>(),
			asyncWriter: {},
			usageWorker,
		} as unknown as import("../handlers").ProxyContext;

		await expect(
			forwardToClient(
				{
					requestId: "req-2",
					method: "POST",
					path: "/v1/messages",
					account: null,
					requestHeaders: new Headers({ "content-type": "application/json" }),
					requestBody: toArrayBuffer("{}"),
					response: new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				ctx,
			),
		).resolves.toBeInstanceOf(Response);
	});

	it("tees streaming responses instead of cloning when no analytics stream exists", async () => {
		const originalClone = Response.prototype.clone;
		Response.prototype.clone = mock(() => {
			throw new Error("clone should not be called");
		}) as unknown as typeof Response.prototype.clone;

		try {
			const posted: Array<Record<string, unknown>> = [];
			const { ctx } = createCtx((msg) => posted.push(msg));
			ctx.provider.isStreamingResponse = () => true;

			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					const encoder = new TextEncoder();
					controller.enqueue(encoder.encode("data: one\n\n"));
					controller.enqueue(encoder.encode("data: two\n\n"));
					controller.close();
				},
			});

			const response = await forwardToClient(
				{
					requestId: "req-stream-tee",
					method: "POST",
					path: "/v1/messages",
					account: null,
					requestHeaders: new Headers({ "content-type": "application/json" }),
					requestBody: toArrayBuffer("{}"),
					response: new Response(body, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				ctx,
			);

			await expect(response.text()).resolves.toBe("data: one\n\ndata: two\n\n");
			await waitFor(() => posted.some((msg) => msg.type === "end"));

			const chunks = posted.filter((msg) => msg.type === "chunk");
			expect(chunks.length).toBe(2);
			expect(posted.at(-1)).toMatchObject({
				type: "end",
				requestId: "req-stream-tee",
				success: true,
			});
		} finally {
			Response.prototype.clone = originalClone;
		}
	});

	it("tees non-streaming responses instead of cloning analytics body", async () => {
		const originalClone = Response.prototype.clone;
		Response.prototype.clone = mock(() => {
			throw new Error("clone should not be called");
		}) as unknown as typeof Response.prototype.clone;

		try {
			const posted: Array<Record<string, unknown>> = [];
			const { ctx } = createCtx((msg) => posted.push(msg));
			const responseBody = JSON.stringify({ ok: true });

			const response = await forwardToClient(
				{
					requestId: "req-non-stream-tee",
					method: "POST",
					path: "/v1/messages",
					account: null,
					requestHeaders: new Headers({ "content-type": "application/json" }),
					requestBody: toArrayBuffer("{}"),
					response: new Response(responseBody, {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				ctx,
			);

			await expect(response.text()).resolves.toBe(responseBody);
			await waitFor(() => posted.some((msg) => msg.type === "end"));

			expect(posted.at(-1)).toMatchObject({
				type: "end",
				requestId: "req-non-stream-tee",
				responseBody: Buffer.from(responseBody).toString("base64"),
				success: true,
			});
		} finally {
			Response.prototype.clone = originalClone;
		}
	});
});
