import { describe, expect, test } from "bun:test";
import {
	extractNativeTerminalResponse,
	MAX_NATIVE_NONSTREAM_ITEMS_BYTES,
	MAX_NATIVE_NONSTREAM_SSE_BYTES,
} from "../native-nonstream";
import { REAL_CODEX_NONSTREAM_SSE } from "./real-codex-sse.fixture";

const encoder = new TextEncoder();

/** A stream that yields the given chunks (strings are UTF-8 encoded). */
function streamOf(
	chunks: Array<string | Uint8Array>,
): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i >= chunks.length) {
				controller.close();
				return;
			}
			const chunk = chunks[i++];
			controller.enqueue(
				typeof chunk === "string" ? encoder.encode(chunk) : chunk,
			);
		},
	});
}

/**
 * Same, but records how many chunks were actually pulled and whether the
 * consumer cancelled — the success path must do neither prematurely.
 */
function instrumentedStream(
	chunks: Array<string | Uint8Array>,
	opts: { hangingCancel?: boolean } = {},
) {
	const state = { pulled: 0, cancelled: 0, closed: false };
	let i = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i >= chunks.length) {
				state.closed = true;
				controller.close();
				return;
			}
			const chunk = chunks[i++];
			state.pulled++;
			controller.enqueue(
				typeof chunk === "string" ? encoder.encode(chunk) : chunk,
			);
		},
		cancel() {
			state.cancelled++;
			// An analytics passthrough's cancel() awaits its own upstream and can
			// hang forever; the extractor must never await it.
			if (opts.hangingCancel) return new Promise<never>(() => {});
			return undefined;
		},
	});
	return { stream, state };
}

function sseEvent(name: string | null, data: unknown): string {
	const payload = typeof data === "string" ? data : JSON.stringify(data);
	return `${name ? `event: ${name}\n` : ""}data: ${payload}\n\n`;
}

const COMPLETED_RESPONSE = {
	id: "resp_backend_1",
	object: "response",
	status: "completed",
	model: "gpt-5.5-codex",
	output: [
		{
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Hello" }],
		},
	],
	usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
};

describe("extractNativeTerminalResponse", () => {
	test("response.completed: yields the envelope's `response` object verbatim", async () => {
		const result = await extractNativeTerminalResponse(
			streamOf([
				sseEvent("response.completed", {
					type: "response.completed",
					response: COMPLETED_RESPONSE,
				}),
			]),
			{},
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(JSON.parse(result.responseJson)).toEqual(COMPLETED_RESPONSE);
	});

	test("response.incomplete and response.failed keep their honest status", async () => {
		for (const [type, status] of [
			["response.incomplete", "incomplete"],
			["response.failed", "failed"],
		] as const) {
			const response = {
				...COMPLETED_RESPONSE,
				status,
				incomplete_details: { reason: "max_output_tokens" },
			};
			const result = await extractNativeTerminalResponse(
				streamOf([sseEvent(type, { type, response })]),
				{},
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const parsed = JSON.parse(result.responseJson);
			expect(parsed.status).toBe(status);
			expect(parsed).toEqual(response);
		}
	});

	test("no normalization: response.completed carrying status incomplete passes through", async () => {
		const response = { ...COMPLETED_RESPONSE, status: "incomplete" };
		const result = await extractNativeTerminalResponse(
			streamOf([
				sseEvent("response.completed", {
					type: "response.completed",
					response,
				}),
			]),
			{},
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(JSON.parse(result.responseJson).status).toBe("incomplete");
	});

	test("skips preceding non-terminal events and comment lines; first terminal wins", async () => {
		const laterResponse = { ...COMPLETED_RESPONSE, id: "resp_second" };
		const result = await extractNativeTerminalResponse(
			streamOf([
				": keepalive\n\n",
				sseEvent("response.created", {
					type: "response.created",
					response: { id: "resp_backend_1", model: "gpt-5.5-codex" },
				}),
				sseEvent("response.output_text.delta", {
					type: "response.output_text.delta",
					delta: "Hel",
				}),
				": ping\n",
				sseEvent("response.output_text.delta", {
					type: "response.output_text.delta",
					delta: "lo",
				}),
				sseEvent("response.completed", {
					type: "response.completed",
					response: COMPLETED_RESPONSE,
				}),
				sseEvent("response.completed", {
					type: "response.completed",
					response: laterResponse,
				}),
			]),
			{},
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(JSON.parse(result.responseJson).id).toBe("resp_backend_1");
	});

	test("EOF without any terminal event → no-terminal", async () => {
		const result = await extractNativeTerminalResponse(
			streamOf([
				sseEvent("response.created", {
					type: "response.created",
					response: { id: "resp_backend_1" },
				}),
				sseEvent("response.output_text.delta", {
					type: "response.output_text.delta",
					delta: "Hello",
				}),
			]),
			{},
		);

		expect(result).toEqual({ ok: false, reason: "no-terminal" });
	});

	test("terminal-NAMED event with invalid JSON → malformed-terminal", async () => {
		const result = await extractNativeTerminalResponse(
			streamOf(["event: response.completed\ndata: {not json\n\n"]),
			{},
		);

		expect(result).toEqual({ ok: false, reason: "malformed-terminal" });
	});

	test("terminal-NAMED event whose `response` is not an object → malformed-terminal", async () => {
		const result = await extractNativeTerminalResponse(
			streamOf([
				sseEvent("response.completed", {
					type: "response.completed",
					response: "nope",
				}),
			]),
			{},
		);

		expect(result).toEqual({ ok: false, reason: "malformed-terminal" });
	});

	test("invalid JSON in a NON-terminal-named event is skipped, the scan continues", async () => {
		const result = await extractNativeTerminalResponse(
			streamOf([
				"event: response.output_text.delta\ndata: {truncated\n\n",
				"data: not json at all\n\n",
				sseEvent("response.completed", {
					type: "response.completed",
					response: COMPLETED_RESPONSE,
				}),
			]),
			{},
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(JSON.parse(result.responseJson).id).toBe("resp_backend_1");
	});

	test("abrupt EOF mid-envelope (truncated JSON) → not ok", async () => {
		const full = sseEvent("response.completed", {
			type: "response.completed",
			response: COMPLETED_RESPONSE,
		});
		const result = await extractNativeTerminalResponse(
			streamOf([full.slice(0, full.length - 40)]),
			{},
		);

		expect(result.ok).toBe(false);
	});

	test("terminal data line followed immediately by EOF (no trailing blank line) → success", async () => {
		const result = await extractNativeTerminalResponse(
			streamOf([
				"event: response.completed\n" +
					`data: ${JSON.stringify({
						type: "response.completed",
						response: COMPLETED_RESPONSE,
					})}`,
			]),
			{},
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(JSON.parse(result.responseJson).id).toBe("resp_backend_1");
	});

	test("retained buffer over the cap (cumulative) → oversized", async () => {
		// One unterminated line growing past the retention cap: nothing can be
		// discarded, so the cap has to fire.
		const chunk = "a".repeat(4 * 1024 * 1024);
		const chunks = Array.from({ length: 12 }, () => chunk);
		const { stream, state } = instrumentedStream(chunks);

		const result = await extractNativeTerminalResponse(stream, {});

		expect(result).toEqual({ ok: false, reason: "oversized" });
		// It bailed early rather than reading the whole pathological stream.
		expect(state.pulled).toBeLessThan(chunks.length);
		expect(state.cancelled).toBe(1);
	});

	test("a single chunk larger than the cap → oversized", async () => {
		const huge = "a".repeat(MAX_NATIVE_NONSTREAM_SSE_BYTES + 1024);
		const result = await extractNativeTerminalResponse(streamOf([huge]), {});

		expect(result).toEqual({ ok: false, reason: "oversized" });
	});

	test("a terminal event completing inside an over-cap chunk → oversized, not success", async () => {
		// The cap must be decided before the chunk is scanned. Otherwise a stream
		// that has already retained almost the whole budget can hand over one more
		// oversized chunk, have its terminal event found inside it, and be answered
		// with a 200 that the bound was supposed to have refused.
		const retained = 30 * 1024 * 1024;
		const chunks = [
			// No newline: nothing can be discarded, so all of it stays retained.
			"a".repeat(retained),
			// Closes that line and carries a perfectly valid terminal event, but the
			// chunk itself pushes retention past the cap.
			`${"b".repeat(3 * 1024 * 1024)}\n\n${sseEvent("response.completed", {
				type: "response.completed",
				response: COMPLETED_RESPONSE,
			})}`,
		];
		expect(retained + chunks[1].length).toBeGreaterThan(
			MAX_NATIVE_NONSTREAM_SSE_BYTES,
		);
		const { stream, state } = instrumentedStream(chunks);

		const result = await extractNativeTerminalResponse(stream, {});

		expect(result).toEqual({ ok: false, reason: "oversized" });
		expect(state.cancelled).toBe(1);
	});

	test("client abort mid-scan (reader rejects) → read-error, never ok", async () => {
		let pulls = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls++;
				if (pulls === 1) {
					controller.enqueue(
						encoder.encode(
							sseEvent("response.created", {
								type: "response.created",
								response: { id: "resp_backend_1" },
							}),
						),
					);
					return;
				}
				controller.error(new Error("aborted"));
			},
		});

		const result = await extractNativeTerminalResponse(stream, {});
		expect(result).toEqual({ ok: false, reason: "read-error" });
	});

	test("an already-aborted signal short-circuits to read-error", async () => {
		const controller = new AbortController();
		controller.abort();
		const { stream, state } = instrumentedStream([
			sseEvent("response.completed", {
				type: "response.completed",
				response: COMPLETED_RESPONSE,
			}),
		]);

		const result = await extractNativeTerminalResponse(stream, {
			signal: controller.signal,
		});

		expect(result).toEqual({ ok: false, reason: "read-error" });
		expect(state.cancelled).toBe(1);
	});

	test("a ~1 MiB terminal envelope survives intact", async () => {
		const text = "x".repeat(1024 * 1024);
		const response = {
			...COMPLETED_RESPONSE,
			output: [
				{
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text }],
				},
			],
		};
		const serialized = sseEvent("response.completed", {
			type: "response.completed",
			response,
		});
		// Delivered in small chunks, as a real socket would.
		const bytes = encoder.encode(serialized);
		const chunks: Uint8Array[] = [];
		for (let off = 0; off < bytes.byteLength; off += 64 * 1024) {
			chunks.push(bytes.subarray(off, off + 64 * 1024));
		}

		const result = await extractNativeTerminalResponse(streamOf(chunks), {});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(JSON.parse(result.responseJson)).toEqual(response);
	});

	describe("SSE framing", () => {
		test("CRLF line endings", async () => {
			const result = await extractNativeTerminalResponse(
				streamOf([
					'event: response.created\r\ndata: {"type":"response.created"}\r\n\r\n',
					`event: response.completed\r\ndata: ${JSON.stringify({
						type: "response.completed",
						response: COMPLETED_RESPONSE,
					})}\r\n\r\n`,
				]),
				{},
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(JSON.parse(result.responseJson)).toEqual(COMPLETED_RESPONSE);
		});

		test("event delimiter split across two chunks", async () => {
			const serialized = sseEvent("response.completed", {
				type: "response.completed",
				response: COMPLETED_RESPONSE,
			});
			// Cut inside the trailing "\n\n" delimiter.
			const cut = serialized.length - 1;
			const result = await extractNativeTerminalResponse(
				streamOf([serialized.slice(0, cut), serialized.slice(cut)]),
				{},
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(JSON.parse(result.responseJson)).toEqual(COMPLETED_RESPONSE);
		});

		test("multi-line data joins with a newline, not a bare concat", async () => {
			const payload = JSON.stringify({
				type: "response.completed",
				response: COMPLETED_RESPONSE,
			});
			const half = Math.floor(payload.length / 2);
			// A provider may split one JSON payload over several data: lines; SSE
			// says they join with "\n" (which JSON tolerates as whitespace only
			// between tokens — here the split is inside the value, so the join must
			// be exact).
			const framed = `event: response.completed\ndata: ${payload.slice(0, half)}\ndata: ${payload.slice(half)}\n\n`;
			const result = await extractNativeTerminalResponse(
				streamOf([framed]),
				{},
			);

			expect(result).toEqual({ ok: false, reason: "malformed-terminal" });
		});

		test("multi-line data field carrying a JSON payload split at a token boundary", async () => {
			const payload = JSON.stringify({
				type: "response.completed",
				response: COMPLETED_RESPONSE,
			});
			// Split right after the opening brace: joining with "\n" yields valid
			// JSON again, which is exactly what the SSE join rule guarantees.
			const framed = `event: response.completed\ndata: {\ndata: ${payload.slice(1)}\n\n`;
			const result = await extractNativeTerminalResponse(
				streamOf([framed]),
				{},
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(JSON.parse(result.responseJson)).toEqual(COMPLETED_RESPONSE);
		});

		test("multi-byte UTF-8 character split across a chunk boundary", async () => {
			const response = {
				...COMPLETED_RESPONSE,
				output: [
					{
						type: "message",
						id: "msg_1",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "héllo — 🌍 done" }],
					},
				],
			};
			const bytes = encoder.encode(
				sseEvent("response.completed", {
					type: "response.completed",
					response,
				}),
			);
			// Split the stream one byte at a time: every multi-byte sequence in the
			// payload straddles a chunk boundary.
			const chunks: Uint8Array[] = [];
			for (let off = 0; off < bytes.byteLength; off++) {
				chunks.push(bytes.subarray(off, off + 1));
			}

			const result = await extractNativeTerminalResponse(streamOf(chunks), {});

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(JSON.parse(result.responseJson)).toEqual(response);
		});
	});

	test("OR semantics: a terminal `event:` name wins over a conflicting data.type", async () => {
		const response = { ...COMPLETED_RESPONSE, status: "failed" };
		const result = await extractNativeTerminalResponse(
			streamOf([sseEvent("response.failed", { type: "error", response })]),
			{},
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(JSON.parse(result.responseJson).status).toBe("failed");
	});

	test("OR semantics: a terminal data.type wins with no `event:` name at all", async () => {
		const result = await extractNativeTerminalResponse(
			streamOf([
				sseEvent(null, {
					type: "response.completed",
					response: COMPLETED_RESPONSE,
				}),
			]),
			{},
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(JSON.parse(result.responseJson)).toEqual(COMPLETED_RESPONSE);
	});

	test("success path drains to natural EOF and NEVER cancels the source", async () => {
		const chunks = [
			sseEvent("response.created", {
				type: "response.created",
				response: { id: "resp_backend_1" },
			}),
			sseEvent("response.completed", {
				type: "response.completed",
				response: COMPLETED_RESPONSE,
			}),
			// Trailing noise after the terminal — a real backend sends nothing here,
			// but the drain must consume whatever there is instead of cancelling.
			": bye\n\n",
			"\n",
		];
		const { stream, state } = instrumentedStream(chunks);

		const result = await extractNativeTerminalResponse(stream, {});

		expect(result.ok).toBe(true);
		expect(state.cancelled).toBe(0);
		expect(state.pulled).toBe(chunks.length);
		expect(state.closed).toBe(true);
	});

	test("malformed-terminal also drains instead of cancelling", async () => {
		const chunks = [
			"event: response.completed\ndata: {broken\n\n",
			": bye\n\n",
		];
		const { stream, state } = instrumentedStream(chunks);

		const result = await extractNativeTerminalResponse(stream, {});

		expect(result).toEqual({ ok: false, reason: "malformed-terminal" });
		expect(state.cancelled).toBe(0);
		expect(state.pulled).toBe(chunks.length);
	});

	test("a hanging cancel() never stalls the 502 path", async () => {
		const { stream, state } = instrumentedStream(
			["a".repeat(MAX_NATIVE_NONSTREAM_SSE_BYTES + 1024)],
			{ hangingCancel: true },
		);

		const result = await Promise.race([
			extractNativeTerminalResponse(stream, {}),
			new Promise((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
		]);

		expect(result).toEqual({ ok: false, reason: "oversized" });
		expect(state.cancelled).toBe(1);
	});

	describe("empty-output terminal assembly (ChatGPT backend shape)", () => {
		/** An assistant message item as `response.output_item.done` carries it. */
		function messageItem(id: string, text: string) {
			return {
				id,
				type: "message",
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text }],
			};
		}

		/** A `response.output_item.done` frame; `outputIndex` is left out when undefined. */
		function itemDone(item: unknown, outputIndex?: unknown): string {
			const payload: Record<string, unknown> = {
				type: "response.output_item.done",
				item,
			};
			if (outputIndex !== undefined) payload.output_index = outputIndex;
			return sseEvent("response.output_item.done", payload);
		}

		function terminalEvent(
			type: "response.completed" | "response.incomplete" | "response.failed",
			response: unknown,
		): string {
			return sseEvent(type, { type, response });
		}

		const EMPTY_OUTPUT_TERMINAL = { ...COMPLETED_RESPONSE, output: [] };

		test("real captured backend SSE: terminal `output: []` is filled from the done item", async () => {
			// Parse the fixture instead of restating it: the expectations then track
			// the capture rather than a hand-written idea of it.
			const events = REAL_CODEX_NONSTREAM_SSE.split("\n\n")
				.map((block) =>
					block.split("\n").find((line) => line.startsWith("data: ")),
				)
				.filter((line): line is string => line !== undefined)
				.map(
					(line) =>
						JSON.parse(line.slice("data: ".length)) as Record<string, unknown>,
				);
			const terminal = events.find((e) => e.type === "response.completed");
			const done = events.find((e) => e.type === "response.output_item.done") as
				| { item: unknown }
				| undefined;
			const terminalResponse = terminal?.response as Record<string, unknown>;

			// The divergence this whole module exists for, asserted on real bytes.
			expect(terminalResponse.output).toEqual([]);
			expect(done?.item).toBeDefined();

			const result = await extractNativeTerminalResponse(
				streamOf([REAL_CODEX_NONSTREAM_SSE]),
				{},
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			// Deep-equal, not byte-equal: the envelope is reserialized.
			expect(JSON.parse(result.responseJson)).toEqual({
				...terminalResponse,
				output: [done?.item],
			});
		});

		test("terminal already carrying output → verbatim, retained items ignored", async () => {
			const result = await extractNativeTerminalResponse(
				streamOf([
					itemDone(messageItem("msg_ignored", "ignored"), 0),
					terminalEvent("response.completed", COMPLETED_RESPONSE),
				]),
				{},
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(JSON.parse(result.responseJson)).toEqual(COMPLETED_RESPONSE);
		});

		test("out-of-order output_index → assembled ascending", async () => {
			const items = [
				messageItem("msg_a", "a"),
				messageItem("msg_b", "b"),
				messageItem("msg_c", "c"),
			];
			const result = await extractNativeTerminalResponse(
				streamOf([
					itemDone(items[2], 2),
					itemDone(items[0], 0),
					itemDone(items[1], 1),
					terminalEvent("response.completed", EMPTY_OUTPUT_TERMINAL),
				]),
				{},
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(JSON.parse(result.responseJson).output).toEqual(items);
		});

		test("response.incomplete with empty output → assembled all the same", async () => {
			const item = messageItem("msg_partial", "half a th");
			const response = {
				...EMPTY_OUTPUT_TERMINAL,
				status: "incomplete",
				incomplete_details: { reason: "max_output_tokens" },
			};
			const result = await extractNativeTerminalResponse(
				streamOf([
					itemDone(item, 0),
					terminalEvent("response.incomplete", response),
				]),
				{},
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const parsed = JSON.parse(result.responseJson);
			expect(parsed.status).toBe("incomplete");
			expect(parsed).toEqual({ ...response, output: [item] });
		});

		test("empty output and no retained items → ok with an empty output array", async () => {
			const result = await extractNativeTerminalResponse(
				streamOf([terminalEvent("response.completed", EMPTY_OUTPUT_TERMINAL)]),
				{},
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(JSON.parse(result.responseJson)).toEqual(EMPTY_OUTPUT_TERMINAL);
		});

		test("retained items cumulatively past the items cap → oversized", async () => {
			// Every single frame is comfortably under the frame cap; only their SUM
			// crosses the separate items budget.
			const chunkText = "x".repeat(9 * 1024 * 1024);
			const chunks = [0, 1, 2, 3].map((i) =>
				itemDone(messageItem(`msg_${i}`, chunkText), i),
			);
			for (const chunk of chunks) {
				expect(chunk.length).toBeLessThan(MAX_NATIVE_NONSTREAM_SSE_BYTES);
			}
			expect(4 * chunkText.length).toBeGreaterThan(
				MAX_NATIVE_NONSTREAM_ITEMS_BYTES,
			);

			const result = await extractNativeTerminalResponse(
				streamOf([
					...chunks,
					terminalEvent("response.completed", EMPTY_OUTPUT_TERMINAL),
				]),
				{},
			);

			expect(result).toEqual({ ok: false, reason: "oversized" });
		});

		test("a big item plus a big non-empty terminal, each under its own cap → success", async () => {
			// Regression on cap SEPARATION: charging retained items against the frame
			// retention budget would reject this stream, whose every document fits.
			const half = "y".repeat(17 * 1024 * 1024);
			const response = {
				...COMPLETED_RESPONSE,
				output: [messageItem("msg_terminal", half)],
			};
			const itemFrame = itemDone(messageItem("msg_retained", half), 0);
			const terminalFrame = terminalEvent("response.completed", response);
			expect(itemFrame.length).toBeLessThan(MAX_NATIVE_NONSTREAM_SSE_BYTES);
			expect(terminalFrame.length).toBeLessThan(MAX_NATIVE_NONSTREAM_SSE_BYTES);
			expect(itemFrame.length + terminalFrame.length).toBeGreaterThan(
				MAX_NATIVE_NONSTREAM_SSE_BYTES,
			);

			const result = await extractNativeTerminalResponse(
				streamOf([itemFrame, terminalFrame]),
				{},
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(JSON.parse(result.responseJson)).toEqual(response);
		});

		test("unindexed items are appended after indexed ones, never overwriting them", async () => {
			const indexed = messageItem("msg_indexed", "indexed");
			const missing = messageItem("msg_missing", "missing");
			const stringIndex = messageItem("msg_string", "string");
			const negative = messageItem("msg_negative", "negative");
			const fractional = messageItem("msg_fractional", "fractional");

			const result = await extractNativeTerminalResponse(
				streamOf([
					itemDone(missing),
					itemDone(indexed, 0),
					itemDone(stringIndex, "1"),
					itemDone(negative, -1),
					itemDone(fractional, 1.5),
					terminalEvent("response.completed", EMPTY_OUTPUT_TERMINAL),
				]),
				{},
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			// Indexed first, then the unindexed ones in arrival order.
			expect(JSON.parse(result.responseJson).output).toEqual([
				indexed,
				missing,
				stringIndex,
				negative,
				fractional,
			]);
		});

		test("duplicate output_index → last wins, and its bytes replace rather than add", async () => {
			// Both items alone exceed half the items cap: without subtracting the
			// superseded entry the second one would be reported as oversized.
			const filler = "z".repeat(17 * 1024 * 1024);
			const first = messageItem("msg_first", filler);
			const second = messageItem("msg_second", filler);
			expect(2 * filler.length).toBeGreaterThan(
				MAX_NATIVE_NONSTREAM_ITEMS_BYTES,
			);

			const result = await extractNativeTerminalResponse(
				streamOf([
					itemDone(first, 0),
					itemDone(second, 0),
					terminalEvent("response.completed", EMPTY_OUTPUT_TERMINAL),
				]),
				{},
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const output = JSON.parse(result.responseJson).output;
			expect(output).toHaveLength(1);
			expect(output[0].id).toBe("msg_second");
		});

		test("OR semantics: an `event:` name alone marks a done item", async () => {
			const item = messageItem("msg_named", "named");
			const result = await extractNativeTerminalResponse(
				streamOf([
					sseEvent("response.output_item.done", {
						// Conflicting data.type: the event name is authoritative on its own.
						type: "response.output_item.added",
						item,
						output_index: 0,
					}),
					terminalEvent("response.completed", EMPTY_OUTPUT_TERMINAL),
				]),
				{},
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(JSON.parse(result.responseJson).output).toEqual([item]);
		});

		test("OR semantics: a data.type alone marks a done item", async () => {
			const item = messageItem("msg_typed", "typed");
			const result = await extractNativeTerminalResponse(
				streamOf([
					sseEvent(null, {
						type: "response.output_item.done",
						item,
						output_index: 0,
					}),
					terminalEvent("response.completed", EMPTY_OUTPUT_TERMINAL),
				]),
				{},
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(JSON.parse(result.responseJson).output).toEqual([item]);
		});

		describe("corrupt done items", () => {
			const corruptFrames: Array<[string, string]> = [
				[
					"invalid JSON under a done event name",
					"event: response.output_item.done\ndata: {not json\n\n",
				],
				[
					"missing item",
					sseEvent("response.output_item.done", {
						type: "response.output_item.done",
						output_index: 0,
					}),
				],
				[
					"non-record item",
					sseEvent("response.output_item.done", {
						type: "response.output_item.done",
						item: "a message, honest",
						output_index: 0,
					}),
				],
			];

			for (const [label, frame] of corruptFrames) {
				test(`${label} + empty-output terminal → malformed-terminal, never a silent empty output`, async () => {
					const result = await extractNativeTerminalResponse(
						streamOf([
							frame,
							terminalEvent("response.completed", EMPTY_OUTPUT_TERMINAL),
						]),
						{},
					);

					expect(result).toEqual({
						ok: false,
						reason: "malformed-terminal",
					});
				});

				test(`${label} + terminal carrying real output → verbatim success`, async () => {
					const result = await extractNativeTerminalResponse(
						streamOf([
							frame,
							terminalEvent("response.completed", COMPLETED_RESPONSE),
						]),
						{},
					);

					expect(result.ok).toBe(true);
					if (!result.ok) return;
					expect(JSON.parse(result.responseJson)).toEqual(COMPLETED_RESPONSE);
				});
			}
		});
	});

	test("a hanging cancel() never stalls the 200 path", async () => {
		const { stream } = instrumentedStream(
			[
				sseEvent("response.completed", {
					type: "response.completed",
					response: COMPLETED_RESPONSE,
				}),
			],
			{ hangingCancel: true },
		);

		const result = await Promise.race([
			extractNativeTerminalResponse(stream, {}),
			new Promise((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
		]);

		expect((result as { ok: boolean }).ok).toBe(true);
	});
});
