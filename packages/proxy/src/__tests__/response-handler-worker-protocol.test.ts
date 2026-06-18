import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { cacheBodyStore } from "../cache-body-store";
import { forwardToClient } from "../response-handler";
// Captured at module-load time (BEFORE any mock.module) so the finalize-failure
// test can restore the REAL usage-collector afterward — a dynamic import while
// the mock is active would just return the mocked module again.
import * as realUsageCollector from "../usage-collector";

/**
 * Inline usage-collection contract (post worker-retirement).
 *
 * The post-processor worker is gone: forwardToClient now feeds a per-request
 * UsageState inline and finalizes it AFTER transport finish. These tests assert
 * that contract — there is no postMessage anywhere; the RequestRecorder.begin /
 * captureResponseChunk / finishTransport / attachUsageSummary calls and the
 * cacheBodyStore.onSummary / discardStaged staging signals are the observable
 * surface now.
 */

// Production passes requestBody as a real ArrayBuffer (RequestBodyContext
// .getBuffer() returns ArrayBuffer | null). Encode test bodies the same way so
// .slice() yields a transferable ArrayBuffer rather than a Uint8Array.
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
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("forwardToClient inline usage collection", () => {
	function createCtx(storePayloads = true) {
		// Record the order of finishTransport vs attachUsageSummary so a test can
		// assert R3 (finishTransport FIRST, finalize resolves AFTER).
		const callOrder: string[] = [];
		const recorderBeginMetas: Array<Record<string, unknown>> = [];
		const attached: Array<Record<string, unknown>> = [];
		const requestRecorder = {
			begin: mock((meta: Record<string, unknown>) =>
				recorderBeginMetas.push(meta),
			),
			captureResponseChunk: mock(() => {}),
			finishTransport: mock(() => {
				callOrder.push("finishTransport");
			}),
			attachUsageSummary: mock(
				(_id: string, summary: Record<string, unknown>) => {
					callOrder.push("attachUsageSummary");
					attached.push(summary);
				},
			),
			markUsageUnavailable: mock(() => {}),
			recordSynthetic: mock(() => {}),
			sweep: mock(() => {}),
			dispose: mock(() => {}),
		};

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
			requestRecorder,
		} as unknown as import("../handlers").ProxyContext;

		return { ctx, requestRecorder, recorderBeginMetas, attached, callOrder };
	}

	afterEach(() => {
		mock.restore();
	});

	it("begins recording with a messageId-free RecordMeta (no worker postMessage)", async () => {
		const { ctx, recorderBeginMetas } = createCtx();

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
		expect(recorderBeginMetas.length).toBe(1);
		expect(recorderBeginMetas[0].requestId).toBe("req-1");
	});

	it("strips client identity headers from the recorded request headers", async () => {
		const { ctx, recorderBeginMetas } = createCtx();

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

		const requestHeaders = recorderBeginMetas[0].requestHeaders as Record<
			string,
			string
		>;
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

	it("passes a null request body to the recorder when payload storage is disabled", async () => {
		const { ctx, recorderBeginMetas } = createCtx(false);

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

		expect(recorderBeginMetas[0].requestBody).toBeNull();
		expect(recorderBeginMetas[0].project).toBe("main-thread-project");
	});

	it("passes the capped request body to the recorder when payload storage is enabled", async () => {
		const { ctx, recorderBeginMetas } = createCtx(true);
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

		expect(recorderBeginMetas[0].requestBody).toBeInstanceOf(ArrayBuffer);
		expect(
			new TextDecoder().decode(
				recorderBeginMetas[0].requestBody as ArrayBuffer,
			),
		).toBe(requestBody);
		expect(recorderBeginMetas[0].project).toBeNull();
	});

	it("does not record (recorder.begin) when the request is filtered (.well-known 404)", async () => {
		const { ctx, recorderBeginMetas } = createCtx();

		await forwardToClient(
			{
				requestId: "req-wellknown",
				method: "GET",
				path: "/.well-known/anything",
				account: null,
				requestHeaders: new Headers(),
				requestBody: null,
				response: new Response(null, { status: 404 }),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);

		expect(recorderBeginMetas.length).toBe(0);
	});

	it("streaming: feeds chunks to the recorder, finishes transport, then attaches usage", async () => {
		const { ctx, requestRecorder, attached } = createCtx();
		ctx.provider.isStreamingResponse = () => true;

		const enc = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					enc.encode(
						`event: message_start\ndata: ${JSON.stringify({
							type: "message_start",
							message: {
								model: "claude-opus-4-8",
								usage: { input_tokens: 100, output_tokens: 1 },
							},
						})}\n\n`,
					),
				);
				controller.enqueue(
					enc.encode(
						`event: content_block_delta\ndata: ${JSON.stringify({
							type: "content_block_delta",
							delta: { type: "text_delta", text: "hello world" },
						})}\n\n`,
					),
				);
				controller.enqueue(
					enc.encode(
						`event: message_delta\ndata: ${JSON.stringify({
							type: "message_delta",
							usage: { output_tokens: 42 },
						})}\n\n`,
					),
				);
				controller.close();
			},
		});

		const response = await forwardToClient(
			{
				requestId: "req-stream",
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

		// Drain the client stream (single-reader pass-through drives the analytics).
		await response.text();
		// The recorder captured each chunk for Request History.
		expect(requestRecorder.captureResponseChunk).toHaveBeenCalled();
		// finishTransport fires at stream end; usage attaches after the async finalize.
		expect(requestRecorder.finishTransport).toHaveBeenCalled();
		await waitFor(() => attached.length > 0);

		const summary = attached[0] as {
			requestId: string;
			usage: { model?: string; inputTokens?: number; outputTokens?: number };
		};
		expect(summary.requestId).toBe("req-stream");
		expect(summary.usage.model).toBe("claude-opus-4-8");
		expect(summary.usage.inputTokens).toBe(100);
		// message_delta count is authoritative (not the message_start placeholder).
		expect(summary.usage.outputTokens).toBe(42);
	});

	it("R3: finishTransport is called BEFORE finalize resolves (attachUsageSummary)", async () => {
		const { ctx, callOrder, attached } = createCtx();

		await forwardToClient(
			{
				requestId: "req-order",
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: toArrayBuffer("{}"),
				response: new Response(
					JSON.stringify({
						model: "claude-opus-4-8",
						usage: { input_tokens: 10, output_tokens: 5 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);

		await waitFor(() => attached.length > 0);
		// finishTransport must be observed strictly before attachUsageSummary.
		expect(callOrder[0]).toBe("finishTransport");
		expect(callOrder).toContain("attachUsageSummary");
		expect(callOrder.indexOf("finishTransport")).toBeLessThan(
			callOrder.indexOf("attachUsageSummary"),
		);
	});

	it("non-stream success drives cacheBodyStore.onSummary with the cacheCreation tokens", async () => {
		const { ctx, attached } = createCtx();
		const onSummary = spyOn(cacheBodyStore, "onSummary");

		await forwardToClient(
			{
				requestId: "req-cache-summary",
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: toArrayBuffer("{}"),
				response: new Response(
					JSON.stringify({
						model: "claude-opus-4-8",
						usage: {
							input_tokens: 10,
							cache_creation_input_tokens: 7,
							output_tokens: 5,
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);

		await waitFor(() => attached.length > 0);
		// onSummary now also receives cacheRead tokens (none in this body → 0,
		// the usage-collector default) and the model, used to route keyed sessions
		// into the session bridge.
		expect(onSummary).toHaveBeenCalledWith(
			"req-cache-summary",
			7,
			0,
			"claude-opus-4-8",
		);
	});
});

/**
 * Failure path: a rejected finalize must discard the staged body AND persist the
 * row immediately usage-waived via markUsageUnavailable (B5 — not left for the
 * grace timer, which a shutdown drain+dispose could lose). We force the
 * rejection by mocking the usage-collector's finalizeUsage to throw, then assert
 * discardStaged + markUsageUnavailable fired and attachUsageSummary did NOT.
 */
describe("forwardToClient finalize-failure path", () => {
	afterEach(() => {
		mock.restore();
		// mock.restore() does NOT undo mock.module — restore the REAL usage-collector
		// (captured at module load, above) so the finalize-reject mock can't leak
		// into other test files in the shared `bun test` process (it would otherwise
		// make finalizeUsage reject everywhere).
		mock.module("../usage-collector", () => realUsageCollector);
	});

	it("rejected finalize discards staged body, persists usage-waived, skips attachUsageSummary", async () => {
		// Mock the inline collector so finalize rejects. Re-import response-handler
		// AFTER the mock so its module-scope import binds the mocked finalizeUsage.
		mock.module("../usage-collector", () => ({
			createUsageState: () => ({}),
			feedChunk: () => {},
			feedNonStreamBody: () => {},
			finalizeUsage: () => Promise.reject(new Error("boom")),
		}));

		const { forwardToClient: forward } = await import("../response-handler");
		const { cacheBodyStore: store } = await import("../cache-body-store");
		const discardStaged = spyOn(store, "discardStaged");

		const attachUsageSummary = mock(() => {});
		const finishTransport = mock(() => {});
		const markUsageUnavailable = mock(() => {});
		const ctx = {
			provider: { name: "anthropic", isStreamingResponse: () => true },
			config: { getStorePayloads: () => true },
			refreshInFlight: new Map<string, Promise<string>>(),
			requestRecorder: {
				begin: mock(() => {}),
				captureResponseChunk: mock(() => {}),
				finishTransport,
				attachUsageSummary,
				markUsageUnavailable,
				recordSynthetic: mock(() => {}),
			},
		} as unknown as import("../handlers").ProxyContext;

		const enc = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(enc.encode("data: one\n\n"));
				controller.close();
			},
		});

		const response = await forward(
			{
				requestId: "req-reject",
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: enc.encode("{}").buffer as ArrayBuffer,
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

		// Drain the client stream so onEnd → finishTransport + finalize fire.
		await response.text();
		// finishTransport always runs first (never gated behind finalize).
		expect(finishTransport).toHaveBeenCalled();
		// The rejected finalize discards the staged body...
		await waitFor(() => discardStaged.mock.calls.length > 0);
		expect(discardStaged).toHaveBeenCalledWith("req-reject");
		// ...persists the row immediately usage-waived (B5)...
		await waitFor(() => markUsageUnavailable.mock.calls.length > 0);
		expect(markUsageUnavailable).toHaveBeenCalledWith("req-reject");
		// ...and never attaches usage.
		expect(attachUsageSummary).not.toHaveBeenCalled();
	});
});
