import { describe, expect, test } from "bun:test";
import {
	getNativeResponsesRequestContext,
	NATIVE_RESPONSES_RESPONSE_HEADER,
} from "@clankermux/types";
import { handleResponsesRequest } from "../handler";
import type { HandleProxyFn } from "../types";

const ANTHROPIC_MESSAGE_BODY = JSON.stringify({
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: "claude-haiku-4-5",
	content: [{ type: "text", text: "Hello" }],
	stop_reason: "end_turn",
	stop_sequence: null,
	usage: { input_tokens: 10, output_tokens: 5 },
});

describe("handleResponsesRequest", () => {
	test("Test 1: invalid request (no input field) → 400", async () => {
		const mockHandleProxy: HandleProxyFn = async () =>
			new Response("should not be called", { status: 200 });

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({ model: "claude-haiku-4-5" }), // no input
			headers: { "Content-Type": "application/json" },
		});

		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);
		expect(resp.status).toBe(400);

		const body = await resp.json();
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("invalid_request_error");
	});

	test("Test 2: non-streaming path → calls handleProxy with /v1/messages, returns translated response", async () => {
		let capturedUrl: URL | null = null;

		const mockHandleProxy: HandleProxyFn = async (_req, url) => {
			capturedUrl = url;
			return new Response(ANTHROPIC_MESSAGE_BODY, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Hi" }],
					},
				],
				stream: false,
			}),
			headers: { "Content-Type": "application/json" },
		});

		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);

		expect(capturedUrl?.pathname).toBe("/v1/messages");
		expect(resp.status).toBe(200);

		const body = await resp.json();
		expect(body.object).toBe("response");
		expect(Array.isArray(body.output)).toBe(true);
		expect(body.output[0].type).toBe("message");
	});

	test("Test 2b: sets the no-official-Anthropic floor header on the synthetic request", async () => {
		let denyHeader: string | null = null;

		const mockHandleProxy: HandleProxyFn = async (req) => {
			denyHeader = req.headers.get("x-clankermux-deny-official-anthropic");
			return new Response(ANTHROPIC_MESSAGE_BODY, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Hi" }],
					},
				],
				stream: false,
			}),
			headers: { "Content-Type": "application/json" },
		});

		await handleResponsesRequest(req, new URL(req.url), mockHandleProxy, {});

		// Codex CLI traffic must be marked so the proxy never routes it to a
		// Claude account — independent of any API-key pin or auth config.
		expect(denyHeader).toBe("1");
	});

	test("Test 3: error passthrough → if handleProxy returns 429, handler returns 429", async () => {
		const mockHandleProxy: HandleProxyFn = async () =>
			new Response("rate limited", { status: 429 });

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Hi" }],
					},
				],
			}),
			headers: { "Content-Type": "application/json" },
		});

		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);
		expect(resp.status).toBe(429);
	});

	test("Test 4: streaming path → returns a text/event-stream response", async () => {
		const sseBody =
			"event: message_start\ndata: " +
			JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: "claude-haiku-4-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			}) +
			"\n\n" +
			"event: content_block_start\ndata: " +
			JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}) +
			"\n\n" +
			"event: content_block_delta\ndata: " +
			JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Hello" },
			}) +
			"\n\n" +
			"event: content_block_stop\ndata: " +
			JSON.stringify({
				type: "content_block_stop",
				index: 0,
			}) +
			"\n\n" +
			"event: message_delta\ndata: " +
			JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 5 },
			}) +
			"\n\n" +
			"event: message_stop\ndata: " +
			JSON.stringify({ type: "message_stop" }) +
			"\n\n";

		const mockHandleProxy: HandleProxyFn = async () =>
			new Response(sseBody, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Hi" }],
					},
				],
				stream: true,
			}),
			headers: { "Content-Type": "application/json" },
		});

		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);
		expect(resp.headers.get("content-type")).toContain("text/event-stream");

		// Read body and verify the translation actually ran
		const rawBody = await resp.text();
		expect(rawBody).toContain("response.created");
		expect(rawBody).toContain("response.completed");
	});

	describe("native Responses passthrough (Stage B, response leg)", () => {
		// Raw Codex-backend Responses SSE — distinctively NOT Anthropic SSE and
		// carrying the backend's own response id, which must survive untouched.
		const RAW_CODEX_SSE = [
			"event: response.created",
			`data: ${JSON.stringify({
				type: "response.created",
				response: { id: "resp_backend_1", model: "gpt-5.5-codex" },
			})}`,
			"",
			"event: response.output_text.delta",
			`data: ${JSON.stringify({
				type: "response.output_text.delta",
				delta: "Hello",
			})}`,
			"",
			"event: response.completed",
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					id: "resp_backend_1",
					usage: { input_tokens: 3, output_tokens: 2 },
				},
			})}`,
			"",
			"",
		].join("\n");

		function streamingRequest(stream: boolean): Request {
			return new Request("http://localhost/v1/responses", {
				method: "POST",
				body: JSON.stringify({
					model: "gpt-5.5-codex",
					input: [
						{
							type: "message",
							role: "user",
							content: [{ type: "input_text", text: "Hi" }],
						},
					],
					stream,
				}),
				headers: { "Content-Type": "application/json" },
			});
		}

		test("marked 200 SSE → returned as-is (same bytes), marker header stripped", async () => {
			const mockHandleProxy: HandleProxyFn = async () =>
				new Response(RAW_CODEX_SSE, {
					status: 200,
					headers: {
						"Content-Type": "text/event-stream",
						[NATIVE_RESPONSES_RESPONSE_HEADER]: "1",
						"x-other-header": "kept",
					},
				});

			const resp = await handleResponsesRequest(
				streamingRequest(true),
				new URL("http://localhost/v1/responses"),
				mockHandleProxy,
				{},
			);

			expect(resp.status).toBe(200);
			// Internal marker must NOT leak to the client; other headers survive.
			expect(resp.headers.get(NATIVE_RESPONSES_RESPONSE_HEADER)).toBeNull();
			expect(resp.headers.get("content-type")).toContain("text/event-stream");
			expect(resp.headers.get("x-other-header")).toBe("kept");

			// The SAME bytes reach the client — no translation, no responseId
			// substitution: the backend's own response id survives.
			const rawBody = await resp.text();
			expect(rawBody).toBe(RAW_CODEX_SSE);
			expect(rawBody).toContain("resp_backend_1");
		});

		test("unmarked 200 SSE → still translated via the stream translator (regression)", async () => {
			const anthropicSse =
				"event: message_start\ndata: " +
				JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_1",
						type: "message",
						role: "assistant",
						model: "claude-haiku-4-5",
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				}) +
				"\n\n" +
				"event: message_delta\ndata: " +
				JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 5 },
				}) +
				"\n\n" +
				"event: message_stop\ndata: " +
				JSON.stringify({ type: "message_stop" }) +
				"\n\n";

			const mockHandleProxy: HandleProxyFn = async () =>
				new Response(anthropicSse, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});

			const resp = await handleResponsesRequest(
				streamingRequest(true),
				new URL("http://localhost/v1/responses"),
				mockHandleProxy,
				{},
			);

			expect(resp.status).toBe(200);
			const rawBody = await resp.text();
			// Translation ran: Responses vocabulary out, Anthropic vocabulary gone.
			expect(rawBody).toContain("response.created");
			expect(rawBody).toContain("response.completed");
			expect(rawBody).not.toContain("message_start");
		});

		test("marked response with body.stream false → warns and falls back to translation", async () => {
			// Should be impossible (Stage A only goes native when clientStream is
			// true) — the defensive fallback must still produce a translated
			// non-stream response from an Anthropic JSON body.
			const mockHandleProxy: HandleProxyFn = async () =>
				new Response(ANTHROPIC_MESSAGE_BODY, {
					status: 200,
					headers: {
						"Content-Type": "application/json",
						[NATIVE_RESPONSES_RESPONSE_HEADER]: "1",
					},
				});

			const resp = await handleResponsesRequest(
				streamingRequest(false),
				new URL("http://localhost/v1/responses"),
				mockHandleProxy,
				{},
			);

			expect(resp.status).toBe(200);
			expect(resp.headers.get(NATIVE_RESPONSES_RESPONSE_HEADER)).toBeNull();
			const body = await resp.json();
			// The JSON translation path ran, not the passthrough.
			expect(body.object).toBe("response");
			expect(Array.isArray(body.output)).toBe(true);
		});

		test("non-200 keeps error translation even if a marker were present (ordering)", async () => {
			// Stage A only marks 200s; should one ever arrive marked, the error
			// handling above the passthrough branch still wins.
			const mockHandleProxy: HandleProxyFn = async () =>
				new Response(
					JSON.stringify({
						type: "error",
						error: { type: "rate_limit_error", message: "slow down" },
					}),
					{
						status: 429,
						headers: {
							"Content-Type": "application/json",
							[NATIVE_RESPONSES_RESPONSE_HEADER]: "1",
						},
					},
				);

			const resp = await handleResponsesRequest(
				streamingRequest(true),
				new URL("http://localhost/v1/responses"),
				mockHandleProxy,
				{},
			);

			expect(resp.status).toBe(429);
			const body = await resp.json();
			expect(body.error.type).toBe("rate_limit_error");
			expect(body.error.message).toBe("slow down");
		});
	});

	describe("native Responses context attachment", () => {
		/**
		 * Drive the handler with the given Responses body and return the context
		 * attached to the synthetic Request that reached handleProxy.
		 */
		async function captureContext(bodyOverrides: Record<string, unknown>) {
			let capturedReq: Request | null = null;
			const mockHandleProxy: HandleProxyFn = async (req) => {
				capturedReq = req;
				return new Response(ANTHROPIC_MESSAGE_BODY, {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			};
			const req = new Request("http://localhost/v1/responses", {
				method: "POST",
				body: JSON.stringify({
					model: "gpt-5.5-codex",
					input: [
						{
							type: "message",
							role: "user",
							content: [{ type: "input_text", text: "Hi" }],
						},
					],
					...bodyOverrides,
				}),
				headers: { "Content-Type": "application/json" },
			});
			await handleResponsesRequest(req, new URL(req.url), mockHandleProxy, {});
			expect(capturedReq).not.toBeNull();
			return getNativeResponsesRequestContext(
				capturedReq as unknown as Request,
			);
		}

		test("attaches the original body with clientStream:true for stream:true", async () => {
			const ctx = await captureContext({
				stream: true,
				tools: [{ type: "web_search" }],
			});
			expect(ctx).toBeDefined();
			expect(ctx?.clientStream).toBe(true);
			const native = JSON.parse(ctx?.nativeBody ?? "{}");
			expect(native.model).toBe("gpt-5.5-codex");
			expect(native.tools).toEqual([{ type: "web_search" }]);
			expect(native.input).toEqual([
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Hi" }],
				},
			]);
		});

		test("clientStream:false for stream:false", async () => {
			const ctx = await captureContext({ stream: false });
			expect(ctx).toBeDefined();
			expect(ctx?.clientStream).toBe(false);
		});

		test("clientStream:false when stream is absent", async () => {
			const ctx = await captureContext({});
			expect(ctx).toBeDefined();
			expect(ctx?.clientStream).toBe(false);
		});

		test("carries the original reasoning.effort string", async () => {
			const ctx = await captureContext({ reasoning: { effort: "high" } });
			expect(ctx).toBeDefined();
			expect(ctx?.reasoningEffort).toBe("high");
		});

		test("reasoningEffort is null when reasoning.effort is absent or non-string", async () => {
			expect((await captureContext({}))?.reasoningEffort).toBeNull();
			expect(
				(await captureContext({ reasoning: {} }))?.reasoningEffort,
			).toBeNull();
			expect(
				(
					await captureContext({
						reasoning: { effort: 3 as unknown as string },
					})
				)?.reasoningEffort,
			).toBeNull();
		});

		test("string input is normalized in the attached nativeBody", async () => {
			const ctx = await captureContext({ input: "plain text", stream: true });
			expect(ctx).toBeDefined();
			const native = JSON.parse(ctx?.nativeBody ?? "{}");
			expect(native.input).toEqual([
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "plain text" }],
				},
			]);
		});
	});
});
