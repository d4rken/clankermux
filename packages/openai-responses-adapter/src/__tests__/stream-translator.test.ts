import { describe, expect, spyOn, test } from "bun:test";
import { Logger } from "@clankermux/logger";
import { translateAnthropicStreamToResponses } from "../stream-translator";
import { ToolTranslation } from "../tool-translation";

async function collectSseEvents(
	response: Response,
): Promise<Array<{ event: string; data: unknown }>> {
	const text = await response.text();
	const events: Array<{ event: string; data: unknown }> = [];
	const rawEvents = text.split("\n\n").filter((s) => s.trim().length > 0);

	for (const rawEvent of rawEvents) {
		const lines = rawEvent.split("\n");
		let eventType = "message";
		let dataStr = "";
		for (const line of lines) {
			if (line.startsWith("event: ")) {
				eventType = line.slice(7).trim();
			} else if (line.startsWith("data: ")) {
				dataStr = line.slice(6).trim();
			}
		}
		if (dataStr) {
			events.push({ event: eventType, data: JSON.parse(dataStr) });
		}
	}

	return events;
}

function makeAnthropicStream(eventStrings: string[]): Response {
	const body = `${eventStrings.join("\n\n")}\n\n`;
	return new Response(body, {
		headers: { "Content-Type": "text/event-stream" },
	});
}

function sseEvent(type: string, data: unknown): string {
	return `event: ${type}\ndata: ${JSON.stringify(data)}`;
}

const TERMINAL_EVENTS = new Set([
	"response.completed",
	"response.incomplete",
	"response.failed",
]);

function isTerminal(event: string): boolean {
	return TERMINAL_EVENTS.has(event);
}

describe("translateAnthropicStreamToResponses", () => {
	test("does not invent cache misses when only writes are reported", async () => {
		for (const reads of [undefined, null, 0, -1]) {
			const events = await collectSseEvents(
				translateAnthropicStreamToResponses(
					makeAnthropicStream([
						sseEvent("message_start", {
							message: {
								usage: {
									input_tokens: 5,
									output_tokens: 0,
									cache_read_input_tokens: null,
									cache_creation_input_tokens: null,
								},
							},
						}),
						sseEvent("message_delta", {
							usage: {
								output_tokens: 2,
								cache_creation_input_tokens: 10,
								cache_read_input_tokens: reads,
							},
						}),
						sseEvent("message_stop", {}),
					]),
					"resp_write",
					"model",
				),
			);
			expect(events.at(-1)?.data).toMatchObject({
				response: {
					usage: {
						input_tokens: 15,
						output_tokens: 2,
						total_tokens: 17,
						input_tokens_details: { cache_write_tokens: 10 },
					},
				},
			});
			const data = events.at(-1)?.data as {
				response: { usage: { input_tokens_details: object } };
			};
			expect(data.response.usage.input_tokens_details).toEqual({
				cache_write_tokens: 10,
				...(reads === 0 ? { cached_tokens: 0 } : {}),
			});
		}
	});
	for (const terminal of ["message_stop", "error"] as const) {
		test(`merges final input and cache counts before ${terminal}`, async () => {
			const events = await collectSseEvents(
				translateAnthropicStreamToResponses(
					makeAnthropicStream([
						sseEvent("message_start", {
							message: { usage: { input_tokens: 0, output_tokens: 0 } },
						}),
						sseEvent("message_delta", {
							usage: {
								input_tokens: 12,
								output_tokens: 8,
								cache_read_input_tokens: 100,
								cache_creation_input_tokens: 30,
							},
						}),
						sseEvent("message_delta", { usage: { output_tokens: 9 } }),
						sseEvent("message_delta", { delta: { stop_reason: "end_turn" } }),
						sseEvent(
							terminal,
							terminal === "error"
								? { error: { type: "api_error", message: "interrupted" } }
								: {},
						),
					]),
					"resp_final_usage",
					"swe-2",
				),
			);
			expect(events.at(-1)?.event).toBe(
				terminal === "error" ? "response.failed" : "response.completed",
			);
			expect(events.at(-1)?.data).toMatchObject({
				response: {
					usage: {
						input_tokens: 142,
						output_tokens: 9,
						total_tokens: 151,
						input_tokens_details: {
							cached_tokens: 100,
							cache_write_tokens: 30,
						},
					},
				},
			});
		});
	}
	test("fails the response with the error's code, or its type when it has none", async () => {
		for (const [error, code] of [
			[
				{
					type: "invalid_request_error",
					message: "prompt is too long",
					code: "context_length_exceeded",
				},
				"context_length_exceeded",
			],
			[
				{ type: "overloaded_error", message: "prompt is too long" },
				"overloaded_error",
			],
			[
				{
					type: "invalid_request_error",
					message: "prompt is too long",
					code: "  context_length_exceeded  ",
				},
				"context_length_exceeded",
			],
			[
				{ type: "overloaded_error", message: "prompt is too long", code: "  " },
				"overloaded_error",
			],
		] as const) {
			const events = await collectSseEvents(
				translateAnthropicStreamToResponses(
					makeAnthropicStream([
						sseEvent("message_start", {
							message: { usage: { input_tokens: 1, output_tokens: 0 } },
						}),
						sseEvent("error", { type: "error", error }),
					]),
					"resp_code",
					"m",
				),
			);
			expect(events.at(-1)?.data).toMatchObject({
				type: "response.failed",
				response: { error: { code, message: "prompt is too long" } },
			});
		}
	});
	test("fails the response with defaults for a non-string or blank type and message, and caps type and code", async () => {
		for (const [error, expected] of [
			[
				{ type: 42, message: { nested: true } },
				{ code: "api_error", message: "An error occurred during streaming" },
			],
			[
				{ type: "   ", message: "   " },
				{ code: "api_error", message: "An error occurred during streaming" },
			],
			[
				{ type: "t".repeat(500), message: "m" },
				{ code: "t".repeat(128), message: "m" },
			],
			[
				{ type: "api_error", code: `  ${"c".repeat(500)}`, message: "m" },
				{ code: "c".repeat(128), message: "m" },
			],
		] as const) {
			const events = await collectSseEvents(
				translateAnthropicStreamToResponses(
					makeAnthropicStream([
						sseEvent("message_start", {
							message: { usage: { input_tokens: 1, output_tokens: 0 } },
						}),
						sseEvent("error", { type: "error", error }),
					]),
					"resp_bad",
					"m",
				),
			);
			expect(
				(events.at(-1)?.data as { response: { error: unknown } }).response
					.error,
			).toEqual(expected);
		}
	});
	test("preserves initial cache usage and output when final deltas omit those fields", async () => {
		const events = await collectSseEvents(
			translateAnthropicStreamToResponses(
				makeAnthropicStream([
					sseEvent("message_start", {
						message: {
							usage: {
								input_tokens: 10,
								output_tokens: 1,
								cache_read_input_tokens: 40,
								cache_creation_input_tokens: 20,
							},
						},
					}),
					sseEvent("message_delta", {
						usage: { input_tokens: 15, output_tokens: 7 },
					}),
					sseEvent("message_delta", {
						usage: { input_tokens: 0, cache_creation_input_tokens: 0 },
					}),
					sseEvent("message_stop", {}),
				]),
				"resp_partial_usage",
				"swe-2",
			),
		);
		expect(events.at(-1)?.data).toMatchObject({
			response: {
				usage: {
					input_tokens: 40,
					output_tokens: 7,
					total_tokens: 47,
					input_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 },
				},
			},
		});
	});
	for (const newline of ["\n", "\r\n"]) {
		test(`translates fragmented multiline SSE (${JSON.stringify(newline)})`, async () => {
			const frames = [
				[
					"message_start",
					{ message: { id: "msg_1", usage: { input_tokens: 17 } } },
				],
				[
					"content_block_start",
					{ index: 0, content_block: { type: "text", text: "" } },
				],
				[
					"content_block_delta",
					{ index: 0, delta: { type: "text_delta", text: "héllo" } },
				],
				["content_block_stop", { index: 0 }],
				[
					"message_delta",
					{ delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
				],
				["message_stop", {}],
			] as const;
			const wire = frames
				.map(
					([event, data]) =>
						`event:${event}${newline}: comment${newline}${JSON.stringify(
							data,
							null,
							2,
						)
							.split("\n")
							.map((line) => `data:${line}`)
							.join(newline)}${newline}${newline}`,
				)
				.join("");
			const bytes = new TextEncoder().encode(wire);
			let offset = 0;
			const upstream = new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						if (offset === bytes.length) controller.close();
						else controller.enqueue(bytes.slice(offset, ++offset));
					},
				}),
			);
			const events = await collectSseEvents(
				translateAnthropicStreamToResponses(upstream, "resp_sse", "test-model"),
			);
			expect(
				events.find((event) => event.event === "response.output_text.done")
					?.data,
			).toMatchObject({ text: "héllo" });
			expect(
				events.filter((event) => event.event === "response.completed"),
			).toHaveLength(1);
			expect(events.at(-1)?.data).toMatchObject({
				response: { usage: { input_tokens: 17, output_tokens: 3 } },
			});
		});
	}

	test("malformed SSE diagnostics exclude both event names and payloads", async () => {
		const warning = spyOn(Logger.prototype, "warn").mockImplementation(
			() => {},
		);
		try {
			const upstream = new Response(
				"event: secret-event\ndata: secret-prompt\n\n",
			);
			await translateAnthropicStreamToResponses(
				upstream,
				"resp_bad",
				"test-model",
			).text();
			expect(warning).toHaveBeenCalledWith(
				"Failed to parse upstream SSE event data",
			);
			expect(JSON.stringify(warning.mock.calls)).not.toContain("secret-");
		} finally {
			warning.mockRestore();
		}
	});

	test("valid JSON that fails event processing has a separate payload-free diagnostic", async () => {
		const warning = spyOn(Logger.prototype, "warn").mockImplementation(
			() => {},
		);
		try {
			const upstream = new Response("event: message_start\ndata: null\n\n");
			await translateAnthropicStreamToResponses(
				upstream,
				"resp_bad",
				"test-model",
			).text();
			expect(warning).toHaveBeenCalledWith(
				"Failed to process upstream SSE event",
			);
			expect(warning).not.toHaveBeenCalledWith(
				"Failed to parse upstream SSE event data",
			);
		} finally {
			warning.mockRestore();
		}
	});

	for (const newline of ["\n", "\r\n"]) {
		test(`flush preserves final undelimited usage (${JSON.stringify(newline)})`, async () => {
			const frames = [
				[
					"message_start",
					{ message: { id: "msg_eof", usage: { input_tokens: 5 } } },
				],
				[
					"content_block_start",
					{ index: 0, content_block: { type: "text", text: "" } },
				],
				[
					"content_block_delta",
					{ index: 0, delta: { type: "text_delta", text: "hi" } },
				],
				["content_block_stop", { index: 0 }],
				[
					"message_delta",
					{ delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
				],
			] as const;
			// No message_stop or final blank line: output_tokens must come from
			// processing the buffered message_delta, not the initial zero.
			const body = frames
				.map(
					([event, data]) =>
						`event: ${event}${newline}data: ${JSON.stringify(data)}`,
				)
				.join(newline + newline);
			const events = await collectSseEvents(
				translateAnthropicStreamToResponses(
					new Response(body),
					"resp_eof",
					"test-model",
				),
			);
			expect(
				events.find((event) => event.event === "response.output_text.delta")
					?.data,
			).toMatchObject({ delta: "hi" });
			expect(events.filter((event) => isTerminal(event.event))).toHaveLength(1);
			expect(events.at(-1)?.event).toBe("response.failed");
			expect(events.at(-1)?.data).toMatchObject({
				response: {
					status: "failed",
					usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
				},
			});
		});
	}

	test("simple text streaming — correct event sequence and content", async () => {
		const events = [
			sseEvent("message_start", {
				type: "message_start",
				message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } },
			}),
			sseEvent("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Hello" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: " world" },
			}),
			sseEvent("content_block_stop", {
				type: "content_block_stop",
				index: 0,
			}),
			sseEvent("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 5 },
			}),
			sseEvent("message_stop", { type: "message_stop" }),
		];

		const upstream = makeAnthropicStream(events);
		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_001",
			"claude-3-5-sonnet-20241022",
		);

		expect(result.headers.get("content-type")).toBe("text/event-stream");

		const parsed = await collectSseEvents(result);

		// First event: response.created
		expect(parsed[0].event).toBe("response.created");
		const created = parsed[0].data as Record<string, unknown>;
		expect(created.type).toBe("response.created");
		expect((created.response as Record<string, unknown>).status).toBe(
			"in_progress",
		);

		// Second event: response.in_progress
		expect(parsed[1].event).toBe("response.in_progress");

		// Third event: response.output_item.added (message item)
		expect(parsed[2].event).toBe("response.output_item.added");
		const added = parsed[2].data as Record<string, unknown>;
		expect((added.item as Record<string, unknown>).type).toBe("message");
		expect((added.item as Record<string, unknown>).role).toBe("assistant");

		// Fourth: response.content_part.added
		expect(parsed[3].event).toBe("response.content_part.added");

		// Fifth + sixth: response.output_text.delta
		expect(parsed[4].event).toBe("response.output_text.delta");
		const delta1 = parsed[4].data as Record<string, unknown>;
		expect(delta1.delta).toBe("Hello");

		expect(parsed[5].event).toBe("response.output_text.delta");
		const delta2 = parsed[5].data as Record<string, unknown>;
		expect(delta2.delta).toBe(" world");

		// Seventh: response.output_text.done with full accumulated text
		expect(parsed[6].event).toBe("response.output_text.done");
		const textDone = parsed[6].data as Record<string, unknown>;
		expect(textDone.type).toBe("response.output_text.done");
		expect(textDone.item_id).toBe("resp_001_msg_0");
		expect(textDone.output_index).toBe(0);
		expect(textDone.content_index).toBe(0);
		expect(textDone.text).toBe("Hello world");

		// Eighth: response.content_part.done
		expect(parsed[7].event).toBe("response.content_part.done");

		// Ninth: response.output_item.done with full text
		expect(parsed[8].event).toBe("response.output_item.done");
		const done = parsed[8].data as Record<string, unknown>;
		const doneItem = done.item as Record<string, unknown>;
		expect(doneItem.type).toBe("message");
		expect(doneItem.status).toBe("completed");
		const content = doneItem.content as Array<Record<string, unknown>>;
		expect(content[0].text).toBe("Hello world");

		// Last: response.completed with usage
		const lastEvent = parsed[parsed.length - 1];
		expect(lastEvent.event).toBe("response.completed");
		const doneFinal = lastEvent.data as Record<string, unknown>;
		const usage = (doneFinal.response as Record<string, unknown>)
			.usage as Record<string, number>;
		expect(usage.input_tokens).toBe(10);
		expect(usage.output_tokens).toBe(5);
		expect(usage.total_tokens).toBe(15);
	});

	test("tool call streaming — correct function_call item events", async () => {
		const events = [
			sseEvent("message_start", {
				type: "message_start",
				message: { id: "msg_2", usage: { input_tokens: 20, output_tokens: 0 } },
			}),
			sseEvent("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "call_1", name: "read_file" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"path":' },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '"/tmp/x"}' },
			}),
			sseEvent("content_block_stop", {
				type: "content_block_stop",
				index: 0,
			}),
			sseEvent("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "tool_use" },
				usage: { output_tokens: 8 },
			}),
			sseEvent("message_stop", { type: "message_stop" }),
		];

		const upstream = makeAnthropicStream(events);
		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_002",
			"claude-3-5-sonnet-20241022",
		);

		const parsed = await collectSseEvents(result);

		// output_item.added should be a function_call
		const addedEvent = parsed.find(
			(e) => e.event === "response.output_item.added",
		);
		expect(addedEvent).toBeDefined();
		const addedItem = (addedEvent?.data as Record<string, unknown>)
			.item as Record<string, unknown>;
		expect(addedItem.type).toBe("function_call");
		expect(addedItem.call_id).toBe("call_1");
		expect(addedItem.name).toBe("read_file");

		// function_call_arguments.delta events
		const argDeltas = parsed.filter(
			(e) => e.event === "response.function_call_arguments.delta",
		);
		expect(argDeltas.length).toBeGreaterThan(0);

		// output_item.done should have complete arguments
		const doneEvent = parsed.find(
			(e) => e.event === "response.output_item.done",
		);
		expect(doneEvent).toBeDefined();
		const doneItem = (doneEvent?.data as Record<string, unknown>)
			.item as Record<string, unknown>;
		expect(doneItem.type).toBe("function_call");
		expect(doneItem.status).toBe("completed");
		expect(doneItem.arguments).toBe('{"path":"/tmp/x"}');

		// response.completed at end
		const lastEvent = parsed[parsed.length - 1];
		expect(lastEvent.event).toBe("response.completed");
	});

	test("ignores deltas for intentionally omitted blocks without warning", async () => {
		const warning = spyOn(Logger.prototype, "warn").mockImplementation(
			() => {},
		);
		try {
			const events = await collectSseEvents(
				translateAnthropicStreamToResponses(
					makeAnthropicStream([
						sseEvent("message_start", {
							message: { id: "msg_thinking", usage: {} },
						}),
						sseEvent("content_block_start", {
							index: 0,
							content_block: { type: "thinking", thinking: "" },
						}),
						sseEvent("content_block_delta", {
							index: 0,
							delta: { type: "thinking_delta", thinking: "internal" },
						}),
						sseEvent("content_block_stop", { index: 0 }),
						sseEvent("content_block_start", {
							index: 1,
							content_block: { type: "text", text: "" },
						}),
						sseEvent("content_block_delta", {
							index: 1,
							delta: { type: "text_delta", text: "visible" },
						}),
						sseEvent("content_block_stop", { index: 1 }),
						sseEvent("message_stop", {}),
					]),
					"resp_thinking",
					"test-model",
				),
			);

			expect(warning).not.toHaveBeenCalledWith(
				"content_block_delta for unknown block index 0",
			);
			expect(warning).not.toHaveBeenCalledWith(
				"content_block_stop for unknown block index 0",
			);
			expect(
				events.find((event) => event.event === "response.output_text.delta")
					?.data,
			).toMatchObject({ output_index: 0, delta: "visible" });
		} finally {
			warning.mockRestore();
		}
	});

	test("warns when a delta has no preceding block start", async () => {
		const warning = spyOn(Logger.prototype, "warn").mockImplementation(
			() => {},
		);
		try {
			await translateAnthropicStreamToResponses(
				makeAnthropicStream([
					sseEvent("message_start", { message: { usage: {} } }),
					sseEvent("content_block_delta", {
						index: 0,
						delta: { type: "text_delta", text: "orphan" },
					}),
					sseEvent("message_stop", {}),
				]),
				"resp_orphan",
				"test-model",
			).text();
			expect(warning).toHaveBeenCalledWith(
				"content_block_delta for unknown block index 0",
			);
		} finally {
			warning.mockRestore();
		}
	});

	test("mixed text + tool — both message and function_call items emitted in order", async () => {
		const events = [
			sseEvent("message_start", {
				type: "message_start",
				message: { id: "msg_3", usage: { input_tokens: 15, output_tokens: 0 } },
			}),
			sseEvent("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Sure!" },
			}),
			sseEvent("content_block_stop", {
				type: "content_block_stop",
				index: 0,
			}),
			sseEvent("content_block_start", {
				type: "content_block_start",
				index: 1,
				content_block: { type: "tool_use", id: "call_2", name: "search" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 1,
				delta: { type: "input_json_delta", partial_json: '{"q":"x"}' },
			}),
			sseEvent("content_block_stop", {
				type: "content_block_stop",
				index: 1,
			}),
			sseEvent("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "tool_use" },
				usage: { output_tokens: 12 },
			}),
			sseEvent("message_stop", { type: "message_stop" }),
		];

		const upstream = makeAnthropicStream(events);
		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_003",
			"claude-3-5-sonnet-20241022",
		);

		const parsed = await collectSseEvents(result);

		const addedEvents = parsed.filter(
			(e) => e.event === "response.output_item.added",
		);
		expect(addedEvents).toHaveLength(2);
		expect(
			(
				(addedEvents[0].data as Record<string, unknown>).item as Record<
					string,
					unknown
				>
			).type,
		).toBe("message");
		expect(
			(
				(addedEvents[1].data as Record<string, unknown>).item as Record<
					string,
					unknown
				>
			).type,
		).toBe("function_call");

		const doneEvents = parsed.filter(
			(e) => e.event === "response.output_item.done",
		);
		expect(doneEvents).toHaveLength(2);

		// Last event is response.completed
		expect(parsed[parsed.length - 1].event).toBe("response.completed");
	});

	test("response.completed usage stats — input, output, total correct", async () => {
		const events = [
			sseEvent("message_start", {
				type: "message_start",
				message: { id: "msg_4", usage: { input_tokens: 42, output_tokens: 0 } },
			}),
			sseEvent("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "hi" },
			}),
			sseEvent("content_block_stop", {
				type: "content_block_stop",
				index: 0,
			}),
			sseEvent("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 17 },
			}),
			sseEvent("message_stop", { type: "message_stop" }),
		];

		const upstream = makeAnthropicStream(events);
		const result = translateAnthropicStreamToResponses(
			upstream,
			"resp_004",
			"test-model",
		);

		const parsed = await collectSseEvents(result);
		const doneEvent = parsed.find((e) => e.event === "response.completed");
		expect(doneEvent).toBeDefined();

		const resp = (doneEvent?.data as Record<string, unknown>)
			.response as Record<string, unknown>;
		const usage = resp.usage as Record<string, number>;
		expect(usage.input_tokens).toBe(42);
		expect(usage.output_tokens).toBe(17);
		expect(usage.total_tokens).toBe(59);
		expect(resp.id).toBe("resp_004");
		expect(resp.model).toBe("test-model");
		expect(resp.status).toBe("completed");
	});

	test("Anthropic ping is forwarded as an SSE comment, not a Responses event", async () => {
		const upstream = makeAnthropicStream([
			sseEvent("message_start", {
				type: "message_start",
				message: { id: "msg_p", usage: { input_tokens: 5, output_tokens: 0 } },
			}),
			sseEvent("ping", { type: "ping" }),
			sseEvent("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			sseEvent("ping", { type: "ping" }),
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "hi" },
			}),
			sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
			sseEvent("message_stop", { type: "message_stop" }),
		]);

		const raw = await translateAnthropicStreamToResponses(
			upstream,
			"resp_ping",
			"test-model",
		).text();

		// Each ping becomes a bare SSE comment. A comment carries no `event:` or
		// `data:` line, so a conformant client ignores it while any intermediary's
		// idle timer still sees bytes.
		expect(raw.split(": keepalive\n\n").length - 1).toBe(2);
		expect(raw).not.toContain("event: ping");
		expect(raw).not.toContain('"type":"ping"');
	});

	test("ping does not consume a sequence_number", async () => {
		const streamWith = (withPing: boolean) =>
			makeAnthropicStream([
				sseEvent("message_start", {
					type: "message_start",
					message: {
						id: "msg_a",
						usage: { input_tokens: 1, output_tokens: 0 },
					},
				}),
				...(withPing
					? [
							sseEvent("ping", { type: "ping" }),
							sseEvent("ping", { type: "ping" }),
						]
					: []),
				sseEvent("message_stop", { type: "message_stop" }),
			]);

		const seqOf = async (upstream: Response) =>
			(
				await collectSseEvents(
					translateAnthropicStreamToResponses(upstream, "resp_s", "m"),
				)
			).map((e) => (e.data as { sequence_number: number }).sequence_number);

		expect(await seqOf(streamWith(true))).toEqual(
			await seqOf(streamWith(false)),
		);
	});

	test("a leading ping keepalive precedes response.created without shifting it", async () => {
		const upstream = makeAnthropicStream([
			sseEvent("ping", { type: "ping" }),
			sseEvent("message_start", {
				type: "message_start",
				message: { id: "msg_l", usage: { input_tokens: 3, output_tokens: 0 } },
			}),
			sseEvent("message_stop", { type: "message_stop" }),
		]);

		const raw = await translateAnthropicStreamToResponses(
			upstream,
			"resp_lead",
			"m",
		).text();

		// The whole point of the keepalive is the pre-first-token gap, so it must
		// survive before any Responses event has been emitted. Asserted as a
		// prefix rather than by comparing indexOf results: a missing keepalive
		// gives -1, which would compare "before" everything and pass vacuously.
		expect(raw.startsWith(": keepalive\n\n")).toBe(true);
		expect(raw).toContain("event: response.created");
	});

	test.each([
		["message_stop", { type: "message_stop" }],
		[
			"error",
			{ type: "error", error: { type: "overloaded_error", message: "x" } },
		],
	])("no keepalive is emitted after a terminal %s", async (terminal, payload) => {
		const upstream = makeAnthropicStream([
			sseEvent("message_start", {
				type: "message_start",
				message: { id: "msg_t", usage: { input_tokens: 1, output_tokens: 0 } },
			}),
			sseEvent(terminal, payload),
			sseEvent("ping", { type: "ping" }),
			sseEvent("ping", { type: "ping" }),
		]);

		const raw = await translateAnthropicStreamToResponses(
			upstream,
			"resp_term",
			"m",
		).text();

		// Holding a finished connection open is how a hung request stays hung.
		expect(raw).not.toContain(": keepalive");
	});

	test("a ping either side of the terminal keeps only the pre-terminal one", async () => {
		const upstream = makeAnthropicStream([
			sseEvent("message_start", {
				type: "message_start",
				message: { id: "msg_b", usage: { input_tokens: 1, output_tokens: 0 } },
			}),
			sseEvent("ping", { type: "ping" }),
			sseEvent("message_stop", { type: "message_stop" }),
			sseEvent("ping", { type: "ping" }),
		]);

		const raw = await translateAnthropicStreamToResponses(
			upstream,
			"resp_both",
			"m",
		).text();

		expect(raw.split(": keepalive\n\n").length - 1).toBe(1);
		// The suppression must not have swallowed the terminal event itself.
		expect(raw).toContain("event: response.completed");
		expect(raw.indexOf(": keepalive")).toBeLessThan(
			raw.indexOf("event: response.completed"),
		);
	});
});

describe("terminal status", () => {
	/**
	 * A text block, then a tool_use block whose arguments were cut off at
	 * `{"path":"/tm`, then `tail`.
	 */
	function replyWithTool(tail: string[], closeTool = true): Response {
		return makeAnthropicStream([
			sseEvent("message_start", {
				message: { id: "msg_t", usage: { input_tokens: 9, output_tokens: 0 } },
			}),
			sseEvent("content_block_start", {
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			sseEvent("content_block_delta", {
				index: 0,
				delta: { type: "text_delta", text: "Reading it." },
			}),
			sseEvent("content_block_stop", { index: 0 }),
			sseEvent("content_block_start", {
				index: 1,
				content_block: {
					type: "tool_use",
					id: "toolu_1",
					name: "read",
					input: {},
				},
			}),
			sseEvent("content_block_delta", {
				index: 1,
				delta: { type: "input_json_delta", partial_json: '{"path":"/tm' },
			}),
			...(closeTool ? [sseEvent("content_block_stop", { index: 1 })] : []),
			...tail,
		]);
	}

	function ending(stopReason: string | null, outputTokens = 4): string[] {
		return [
			sseEvent("message_delta", {
				delta: { stop_reason: stopReason, stop_sequence: null },
				usage: { output_tokens: outputTokens },
			}),
			sseEvent("message_stop", {}),
		];
	}

	async function terminalOf(
		upstream: Response,
		options: { clientCappedOutput?: boolean } = {},
	) {
		const events = await collectSseEvents(
			translateAnthropicStreamToResponses(
				upstream,
				"resp_t",
				"test-model",
				undefined,
				options,
			),
		);
		const terminals = events.filter((event) => isTerminal(event.event));
		expect(terminals).toHaveLength(1);
		expect(events.at(-1)).toBe(terminals[0]);
		const terminal = terminals[0] as {
			event: string;
			data: { type: string; response: Record<string, unknown> };
		};
		expect(terminal.data.type).toBe(terminal.event);
		return terminal;
	}

	test("max_tokens under the client's own cap is incomplete for max_output_tokens", async () => {
		const terminal = await terminalOf(replyWithTool(ending("max_tokens")), {
			clientCappedOutput: true,
		});
		expect(terminal.event).toBe("response.incomplete");
		expect(terminal.data.response).toMatchObject({
			status: "incomplete",
			incomplete_details: { reason: "max_output_tokens" },
			usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
		});
		expect(terminal.data.response.error).toBeUndefined();
	});

	test("max_tokens under the supplied cap stays completed", async () => {
		const terminal = await terminalOf(replyWithTool(ending("max_tokens")));
		expect(terminal.event).toBe("response.completed");
		expect(terminal.data.response).toMatchObject({
			status: "completed",
			usage: { output_tokens: 4 },
		});
		expect(terminal.data.response.incomplete_details).toBeUndefined();
	});

	for (const clientCappedOutput of [false, true])
		test(`model_context_window_exceeded fails for context_length_exceeded (client cap: ${clientCappedOutput})`, async () => {
			const terminal = await terminalOf(
				replyWithTool(ending("model_context_window_exceeded")),
				{ clientCappedOutput },
			);
			expect(terminal.event).toBe("response.failed");
			expect(terminal.data.response).toMatchObject({
				status: "failed",
				error: {
					code: "context_length_exceeded",
					// The wording clients match to recognize an overflow.
					message:
						"Your input exceeds the context window of this model. Please adjust your input and try again.",
				},
				usage: { input_tokens: 9, output_tokens: 4 },
			});
		});

	test("EOF with a search in flight fails the search before the response", async () => {
		const events = await collectSseEvents(
			translateAnthropicStreamToResponses(
				makeAnthropicStream([
					sseEvent("message_start", {
						message: { usage: { input_tokens: 2, output_tokens: 0 } },
					}),
					sseEvent("content_block_start", {
						index: 0,
						content_block: {
							type: "server_tool_use",
							id: "srvtoolu_1",
							name: "web_search",
							input: { query: "bun" },
						},
					}),
					sseEvent("content_block_stop", { index: 0 }),
				]),
				"resp_s",
				"test-model",
			),
		);
		const done = events.findIndex(
			(event) => event.event === "response.output_item.done",
		);
		const failed = events.findIndex(
			(event) => event.event === "response.failed",
		);
		expect(done).toBeGreaterThan(-1);
		expect(failed).toBe(events.length - 1);
		expect(done).toBeLessThan(failed);
		expect(events[done]?.data).toMatchObject({
			item: { type: "web_search_call", status: "failed" },
		});
		expect(events[failed]?.data).toMatchObject({
			response: {
				error: { code: "stream_truncated" },
				output: [{ type: "web_search_call", status: "failed" }],
			},
		});
	});

	test("EOF mid tool_use fails with only the finished items", async () => {
		const terminal = await terminalOf(replyWithTool([], false));
		expect(terminal.event).toBe("response.failed");
		expect(terminal.data.response).toMatchObject({
			status: "failed",
			error: {
				code: "stream_truncated",
				message: expect.stringContaining("message_stop"),
			},
			usage: { input_tokens: 9, output_tokens: 0 },
		});
		expect(terminal.data.response.incomplete_details).toBeUndefined();
		expect(terminal.data.response.output).toEqual([
			expect.objectContaining({ type: "message", status: "completed" }),
		]);
	});

	test("EOF after a max_tokens message_delta still fails", async () => {
		const terminal = await terminalOf(
			replyWithTool([
				sseEvent("message_delta", {
					delta: { stop_reason: "max_tokens" },
					usage: { output_tokens: 4 },
				}),
			]),
		);
		expect(terminal.event).toBe("response.failed");
		expect(terminal.data.response).toMatchObject({
			status: "failed",
			usage: { output_tokens: 4 },
		});
	});

	test("an empty upstream body fails", async () => {
		const terminal = await terminalOf(new Response(""));
		expect(terminal.event).toBe("response.failed");
		expect(terminal.data.response.output).toEqual([]);
	});

	test("a successful response without a body fails as truncated", async () => {
		const translated = translateAnthropicStreamToResponses(
			new Response(null, { status: 200 }),
			"resp_t",
			"test-model",
		);
		expect(translated.status).toBe(200);
		expect(translated.headers.get("content-type")).toBe("text/event-stream");
		const events = await collectSseEvents(translated);
		expect(events.map((event) => event.event)).toEqual(["response.failed"]);
		expect(events[0]?.data).toMatchObject({
			response: { status: "failed", error: { code: "stream_truncated" } },
		});
	});

	for (const stopReason of [
		"tool_use",
		"end_turn",
		"stop_sequence",
		"pause_turn",
		"refusal",
		null,
	])
		test(`${stopReason} stays completed`, async () => {
			const terminal = await terminalOf(replyWithTool(ending(stopReason)), {
				clientCappedOutput: true,
			});
			expect(terminal.event).toBe("response.completed");
			expect(terminal.data.response).toMatchObject({
				status: "completed",
				usage: { input_tokens: 9, output_tokens: 4 },
			});
			expect(terminal.data.response.incomplete_details).toBeUndefined();
			expect(terminal.data.response.output).toEqual([
				expect.objectContaining({ type: "message" }),
				expect.objectContaining({
					type: "function_call",
					call_id: "toolu_1",
					status: "completed",
				}),
			]);
		});
});

describe("heartbeat", () => {
	const HEARTBEAT_MS = 40;
	// The guarantee is HEARTBEAT_MS plus one tick; the rest is scheduling slack.
	const SILENCE_BOUND = HEARTBEAT_MS * 2.5;
	const KEEPALIVE = ": keepalive\n\n";
	const MESSAGE_START = sseEvent("message_start", {
		type: "message_start",
		message: { id: "msg_hb", usage: { input_tokens: 1, output_tokens: 0 } },
	});
	const MESSAGE_STOP = sseEvent("message_stop", { type: "message_stop" });
	const TEXT_START = sseEvent("content_block_start", {
		index: 0,
		content_block: { type: "text", text: "" },
	});

	/** An upstream body the test writes as it goes. */
	function liveUpstream() {
		const encoder = new TextEncoder();
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start: (c) => {
					controller = c;
				},
			}),
			{ headers: { "Content-Type": "text/event-stream" } },
		);
		return {
			response,
			send: (text: string) => controller.enqueue(encoder.encode(text)),
			frame: (event: string) =>
				controller.enqueue(encoder.encode(`${event}\n\n`)),
			close: () => controller.close(),
			error: (reason: unknown) => controller.error(reason),
		};
	}

	type Chunk = { at: number; text: string };

	/** Reads a response to its end, timestamping each chunk on arrival. */
	function readTimed(response: Response) {
		const reader = (response.body as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		const chunks: Chunk[] = [];
		/** The read error, or undefined at a clean end. */
		const finished = (async (): Promise<unknown> => {
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) return undefined;
					chunks.push({
						at: performance.now(),
						text: decoder.decode(value, { stream: true }),
					});
				}
			} catch (err) {
				return err ?? new Error("read failed");
			}
		})();
		return {
			reader,
			chunks,
			finished,
			text: () => chunks.map((chunk) => chunk.text).join(""),
		};
	}

	function translate(
		upstream: Response,
		heartbeatMs = HEARTBEAT_MS,
		tools?: ToolTranslation,
	): Response {
		return translateAnthropicStreamToResponses(upstream, "resp_hb", "m", tools, {
			heartbeatMs,
		});
	}

	function within(chunks: Chunk[], from: number, to: number): Chunk[] {
		return chunks.filter((chunk) => chunk.at >= from && chunk.at <= to);
	}

	/** The longest stretch of [from, to] in which nothing arrived. */
	function longestSilence(chunks: Chunk[], from: number, to: number): number {
		let last = from;
		let longest = 0;
		for (const { at } of within(chunks, from, to)) {
			longest = Math.max(longest, at - last);
			last = at;
		}
		return Math.max(longest, to - last);
	}

	function keepalivesIn(text: string): number {
		return text.split(KEEPALIVE).length - 1;
	}

	/** Every interval started while watching, and whether each was cleared. */
	function watchIntervals() {
		const started = spyOn(globalThis, "setInterval");
		const cleared = spyOn(globalThis, "clearInterval");
		const timers = () => started.mock.results.map((result) => result.value);
		return {
			timers,
			allCleared: () =>
				timers().every((timer) =>
					cleared.mock.calls.some(([id]) => id === timer),
				),
			restore: () => {
				started.mockRestore();
				cleared.mockRestore();
			},
		};
	}

	async function until(condition: () => boolean): Promise<void> {
		const deadline = performance.now() + 2_000;
		while (!condition()) {
			if (performance.now() > deadline) throw new Error("condition not met");
			await Bun.sleep(2);
		}
	}

	test("a quiet upstream gets keepalives on schedule without any ping", async () => {
		const upstream = liveUpstream();
		const out = readTimed(translate(upstream.response));
		upstream.frame(MESSAGE_START);
		await until(() => out.text().includes("response.in_progress"));

		const from = performance.now();
		await Bun.sleep(300);
		const to = performance.now();

		const window = within(out.chunks, from, to);
		expect(window.length).toBeGreaterThanOrEqual(3);
		expect(window.every((chunk) => chunk.text === KEEPALIVE)).toBe(true);
		expect(longestSilence(out.chunks, from, to)).toBeLessThan(SILENCE_BOUND);

		upstream.frame(MESSAGE_STOP);
		upstream.close();
		expect(await out.finished).toBeUndefined();
	});

	const customTools = new ToolTranslation();
	customTools.add([{ type: "custom", name: "exec" }]);
	const fragment =
		'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"';

	for (const { name, tools, prelude, filler } of [
		{
			name: "suppressed thinking and signature deltas",
			tools: undefined,
			prelude: [
				sseEvent("content_block_start", {
					index: 0,
					content_block: { type: "thinking", thinking: "" },
				}),
			],
			filler: (i: number) =>
				`${sseEvent("content_block_delta", {
					index: 0,
					delta:
						i % 2
							? { type: "signature_delta", signature: "sig" }
							: { type: "thinking_delta", thinking: "hmm " },
				})}\n\n`,
		},
		{
			name: "a custom tool call's unfinished input",
			tools: customTools,
			prelude: [
				sseEvent("content_block_start", {
					index: 0,
					content_block: {
						type: "tool_use",
						id: "toolu_c",
						name: customTools.tools[0]?.name,
						input: {},
					},
				}),
			],
			filler: (i: number) =>
				`${sseEvent("content_block_delta", {
					index: 0,
					delta: {
						type: "input_json_delta",
						partial_json: i === 0 ? '{"input":"' : "x",
					},
				})}\n\n`,
		},
		{
			name: "an SSE frame arriving in fragments",
			tools: undefined,
			prelude: [],
			filler: (i: number) => fragment.charAt(i) || "a",
		},
	])
		test(`keepalives stay on schedule through input that produces no output: ${name}`, async () => {
			const upstream = liveUpstream();
			const out = readTimed(translate(upstream.response, HEARTBEAT_MS, tools));
			upstream.frame(MESSAGE_START);
			for (const event of prelude) upstream.frame(event);
			await until(() => out.text().includes("response.in_progress"));

			const from = performance.now();
			for (let i = 0; performance.now() - from < 300; i++) {
				upstream.send(filler(i));
				await Bun.sleep(10);
			}
			const to = performance.now();

			const window = within(out.chunks, from, to);
			expect(window.length).toBeGreaterThanOrEqual(3);
			expect(window.every((chunk) => chunk.text === KEEPALIVE)).toBe(true);
			expect(longestSilence(out.chunks, from, to)).toBeLessThan(
				SILENCE_BOUND,
			);

			await out.reader.cancel();
			await out.finished;
		});

	test("no keepalive while output flows faster than the interval", async () => {
		const upstream = liveUpstream();
		const out = readTimed(translate(upstream.response, 100));
		upstream.frame(MESSAGE_START);
		upstream.frame(TEXT_START);
		const from = performance.now();
		while (performance.now() - from < 300) {
			upstream.frame(
				sseEvent("content_block_delta", {
					index: 0,
					delta: { type: "text_delta", text: "a" },
				}),
			);
			await Bun.sleep(10);
		}
		upstream.frame(sseEvent("content_block_stop", { index: 0 }));
		upstream.frame(MESSAGE_STOP);
		upstream.close();
		await out.finished;

		expect(out.text()).toContain("event: response.completed");
		expect(out.text()).not.toContain(KEEPALIVE);
	});

	test("keepalives neither follow the terminal event nor consume sequence numbers", async () => {
		const upstream = liveUpstream();
		const out = readTimed(translate(upstream.response));
		await Bun.sleep(100);
		upstream.frame(MESSAGE_START);
		await Bun.sleep(100);
		upstream.frame(TEXT_START);
		upstream.frame(
			sseEvent("content_block_delta", {
				index: 0,
				delta: { type: "text_delta", text: "hi" },
			}),
		);
		await Bun.sleep(100);
		upstream.frame(sseEvent("content_block_stop", { index: 0 }));
		upstream.frame(MESSAGE_STOP);
		// The upstream stays open well past the terminal event.
		await Bun.sleep(150);
		upstream.close();
		await out.finished;

		const raw = out.text();
		expect(raw.startsWith(KEEPALIVE)).toBe(true);
		const terminalAt = raw.indexOf("event: response.completed");
		expect(terminalAt).toBeGreaterThan(-1);
		expect(keepalivesIn(raw.slice(0, terminalAt))).toBeGreaterThanOrEqual(3);
		expect(raw.slice(terminalAt)).not.toContain(KEEPALIVE);

		const sequence = (await collectSseEvents(new Response(raw))).map(
			(event) => (event.data as { sequence_number: number }).sequence_number,
		);
		expect(sequence.length).toBeGreaterThan(4);
		expect(sequence).toEqual(sequence.map((_, i) => i));
	});

	test("a paused reader gets at most one queued keepalive", async () => {
		const upstream = liveUpstream();
		const reader = (
			translate(upstream.response, 30).body as ReadableStream<Uint8Array>
		).getReader();
		const decoder = new TextDecoder();
		upstream.frame(MESSAGE_START);
		let seen = "";
		while (!seen.includes("response.in_progress")) {
			const { value } = await reader.read();
			seen += decoder.decode(value, { stream: true });
		}

		await Bun.sleep(300);

		upstream.frame(TEXT_START);
		upstream.frame(MESSAGE_STOP);
		upstream.close();
		let rest = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			rest += decoder.decode(value, { stream: true });
		}
		expect(rest.slice(0, rest.indexOf("event: "))).toBe(KEEPALIVE);
		expect(rest).toContain("event: response.output_item.added");
	});

	describe("stops its timer", () => {
		// Long enough that no tick runs here: only the stop paths can clear it.
		const IDLE_MS = 60_000;

		test("after flush", async () => {
			const intervals = watchIntervals();
			try {
				const raw = await translate(
					makeAnthropicStream([MESSAGE_START]),
					IDLE_MS,
				).text();
				expect(raw).toContain("event: response.failed");
				expect(intervals.timers()).toHaveLength(1);
				expect(intervals.allCleared()).toBe(true);
			} finally {
				intervals.restore();
			}
		});

		test("at the terminal event, while the upstream is still open", async () => {
			const intervals = watchIntervals();
			try {
				const upstream = liveUpstream();
				const out = readTimed(translate(upstream.response, IDLE_MS));
				upstream.frame(MESSAGE_START);
				upstream.frame(MESSAGE_STOP);
				await until(() => out.text().includes("event: response.completed"));
				expect(intervals.timers()).toHaveLength(1);
				expect(intervals.allCleared()).toBe(true);
				upstream.close();
				await out.finished;
			} finally {
				intervals.restore();
			}
		});

		test("when the reader cancels", async () => {
			const intervals = watchIntervals();
			try {
				const upstream = liveUpstream();
				const out = readTimed(translate(upstream.response, IDLE_MS));
				upstream.frame(MESSAGE_START);
				await until(() => out.text().includes("response.in_progress"));
				expect(intervals.allCleared()).toBe(false);
				await out.reader.cancel();
				expect(await out.finished).toBeUndefined();
				expect(intervals.timers()).toHaveLength(1);
				expect(intervals.allCleared()).toBe(true);
			} finally {
				intervals.restore();
			}
		});

		test("when an upstream error aborts the pipe while idle", async () => {
			const intervals = watchIntervals();
			try {
				const upstream = liveUpstream();
				const out = readTimed(translate(upstream.response, IDLE_MS));
				upstream.frame(MESSAGE_START);
				await until(() => out.text().includes("response.in_progress"));
				expect(intervals.allCleared()).toBe(false);
				upstream.error(new Error("upstream reset"));
				expect(await out.finished).toBeDefined();
				expect(intervals.timers()).toHaveLength(1);
				expect(intervals.allCleared()).toBe(true);
			} finally {
				intervals.restore();
			}
		});
	});
});
