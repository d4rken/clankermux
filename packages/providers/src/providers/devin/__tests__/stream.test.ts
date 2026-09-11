import { describe, expect, it } from "bun:test";
import { encodeConnect } from "../connect";
import { DevinProvider, getDevinReportedModel } from "../provider";
import { convertDevinResponse } from "../stream";
import {
	ChatToolCallSchema,
	GetChatMessageResponseSchema,
	ModelUsageStatsSchema,
	StopReason,
} from "../vendor/devin-proto";
import { create, toBinary } from "../vendor/protobuf";

function frame(
	fields: Parameters<typeof GetChatMessageResponseSchema.create>[0],
) {
	return encodeConnect(
		toBinary(
			GetChatMessageResponseSchema,
			create(GetChatMessageResponseSchema, fields),
		),
	);
}
const end = encodeConnect(new TextEncoder().encode("{}"), 2);
const quota = encodeConnect(
	new TextEncoder().encode(
		'{"error":{"code":"resource_exhausted","message":"quota exhausted"}}',
	),
	2,
);
function upstream(parts: Uint8Array[]) {
	return new Response(Buffer.concat(parts), {
		headers: { "content-type": "application/connect+proto" },
	});
}

describe("Devin response translation", () => {
	it("propagates the original request disconnect during a buffered response", async () => {
		const controller = new AbortController();
		const pending = convertDevinResponse(
			new Response(new ReadableStream<Uint8Array>()),
			{ model: "swe-2", stream: false, signal: controller.signal },
		);
		const reason = new DOMException("Disconnected", "AbortError");
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
	});
	it("rejects an explicit upstream failure even with a clean trailer", async () => {
		const response = await convertDevinResponse(
			upstream([
				frame({ deltaText: "partial", stopReason: StopReason.ERROR }),
				end,
			]),
			{ model: "swe-2", stream: false },
		);
		expect(response.status).toBe(502);
	});
	it("cancels a pending upstream read when the client disconnects", async () => {
		let cancelled = false;
		const source = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(frame({ deltaText: "hello" }));
			},
			cancel() {
				cancelled = true;
			},
		});
		const response = await convertDevinResponse(new Response(source), {
			model: "swe-2",
			stream: true,
		});
		const reader = response.body?.getReader();
		await reader.read();
		await reader.cancel();
		expect(cancelled).toBe(true);
	});
	it("produces a complete tool message with cumulative arguments and late usage", async () => {
		const response = await convertDevinResponse(
			upstream([
				frame({ messageId: "bot-1", deltaThinking: "Think" }),
				frame({ deltaSignature: "signature" }),
				frame({
					deltaToolCalls: [
						create(ChatToolCallSchema, {
							id: "tool-1",
							name: "read_file",
							argumentsJson: '{"path":',
						}),
					],
				}),
				frame({
					deltaToolCalls: [
						create(ChatToolCallSchema, { argumentsJson: '{"path":"x"}' }),
					],
					usage: create(ModelUsageStatsSchema, {
						inputTokens: 25n,
						outputTokens: 12n,
						cacheReadTokens: 7n,
					}),
					stopReason: StopReason.FUNCTION_CALL,
				}),
				end,
			]),
			{ model: "swe-2-high", stream: false },
		);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.stop_reason).toBe("tool_use");
		expect(body.content[1]).toEqual({
			type: "tool_use",
			id: "tool-1",
			name: "read_file",
			input: { path: "x" },
		});
		expect(body.content[0].signature).toContain("devin:");
		expect(body.usage).toMatchObject({
			input_tokens: 25,
			output_tokens: 12,
			cache_read_input_tokens: 7,
		});
	});
	it("normalizes an early quota trailer to HTTP 429 and a late one to an SSE error", async () => {
		expect(
			(
				await convertDevinResponse(upstream([quota]), {
					model: "swe-2",
					stream: true,
				})
			).status,
		).toBe(429);
		const late = await convertDevinResponse(
			upstream([frame({ deltaText: "partial" }), quota]),
			{ model: "swe-2", stream: true },
		);
		const text = await late.text();
		expect(text).toContain("event: error");
		expect(text).toContain("rate_limit_error");
		expect(text).not.toContain("event: message_stop");
	});
	it("does not report a truncated stream as a successful message", async () => {
		const response = await convertDevinResponse(
			upstream([frame({ deltaText: "partial" })]),
			{ model: "swe-2", stream: false },
		);
		expect(response.status).toBe(502);
		expect((await response.json()).type).toBe("error");
	});
});

it.each([
	false,
	true,
])("records only actual upstream model evidence, including late stream metadata (stream=%s)", async (stream) => {
	const provider = new DevinProvider();
	const request = new Request("https://server.codeium.com/chat", {
		headers: {
			"x-clankermux-upstream-model": "swe-2-high",
			"x-clankermux-request-stream": String(stream),
		},
	});
	const absent = await provider.normalizeUpstreamResponse(
		upstream([
			frame({ deltaText: "hello", stopReason: StopReason.STOP_PATTERN }),
			end,
		]),
		request,
	);
	await absent.text();
	expect(getDevinReportedModel(absent)).toBeNull();
	const actual = await provider.normalizeUpstreamResponse(
		upstream([
			frame({ deltaText: "hello" }),
			frame({
				actualModelUid: "swe-2-actual",
				stopReason: StopReason.STOP_PATTERN,
			}),
			end,
		]),
		request,
	);
	await actual.text();
	expect(getDevinReportedModel(actual)).toBe("swe-2-actual");
});
