import { describe, expect, it } from "bun:test";
import {
	CODEX_PEEK_MAX_EVENTS,
	peekCodexStreamPrefix,
} from "../codex-stream-prefix";

/**
 * Unit lane for the Codex stream-prefix peek. The rung that consumes it lives in
 * proxy-operations; `codex-prefix-failover.test.ts` covers the wiring. Here the
 * only questions are what the parser detects and where it stops.
 */

const encoder = new TextEncoder();

function sseResponse(
	chunks: readonly string[],
	init: { status?: number; contentType?: string | null } = {},
): Response {
	let index = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index >= chunks.length) {
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(chunks[index++]));
		},
	});
	const headers = new Headers();
	const contentType =
		init.contentType === undefined ? "text/event-stream" : init.contentType;
	if (contentType) headers.set("content-type", contentType);
	return new Response(stream, { status: init.status ?? 200, headers });
}

function delayedSseResponse(
	chunks: readonly string[],
	delayMs: number,
): Response {
	let index = 0;
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (index >= chunks.length) {
				controller.close();
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			controller.enqueue(encoder.encode(chunks[index++]));
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** Emits `prefix`, then never produces another byte and never ends. */
function hangingSseResponse(prefix: string): Response {
	let sent = false;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent) return new Promise<void>(() => {});
			sent = true;
			controller.enqueue(encoder.encode(prefix));
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function frame(event: string, payload: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const CREATED = frame("response.created", {
	type: "response.created",
	response: { id: "resp_1", model: "gpt-5.5-codex" },
});
const IN_PROGRESS = frame("response.in_progress", {
	type: "response.in_progress",
	response: { id: "resp_1" },
});

describe("peekCodexStreamPrefix — detection", () => {
	it("detects a transient error event carrying a code", async () => {
		const response = sseResponse([
			CREATED,
			IN_PROGRESS,
			frame("error", {
				type: "error",
				error: {
					type: "service_unavailable_error",
					code: "server_is_overloaded",
				},
			}),
		]);

		expect(await peekCodexStreamPrefix(response)).toBe("server_is_overloaded");
	});

	it("falls back to the error type when the payload carries no code", async () => {
		const response = sseResponse([
			CREATED,
			frame("error", { type: "error", error: { type: "server_error" } }),
		]);

		expect(await peekCodexStreamPrefix(response)).toBe("server_error");
	});

	it("reads a top-level code when the error object carries none", async () => {
		const response = sseResponse([
			CREATED,
			frame("error", { type: "error", code: "service_unavailable_error" }),
		]);

		expect(await peekCodexStreamPrefix(response)).toBe(
			"service_unavailable_error",
		);
	});

	it("reaches the error nested in a response.failed envelope", async () => {
		// The event NAME says `response.failed` while the payload `type` says
		// `error` — the shape usage-collector documents. Either field alone is
		// enough to classify the frame, and the code only exists under
		// `response.error`.
		const response = sseResponse([
			CREATED,
			IN_PROGRESS,
			frame("response.failed", {
				type: "error",
				response: { error: { code: "server_error" } },
			}),
		]);

		expect(await peekCodexStreamPrefix(response)).toBe("server_error");
	});

	it("detects across a fragmented frame with CRLF line endings", async () => {
		const failure = [
			"event: error\r\n",
			'data: {"type":"error","err',
			'or":{"type":"server_error"}}\r\n\r\n',
		];
		const response = sseResponse([
			CREATED.replace(/\n/g, "\r\n").slice(0, 20),
			CREATED.replace(/\n/g, "\r\n").slice(20),
			...failure,
		]);

		expect(await peekCodexStreamPrefix(response)).toBe("server_error");
	});

	it("ignores comment keepalive frames between preludes", async () => {
		const response = sseResponse([
			": keepalive\n\n",
			CREATED,
			": keepalive\n\n",
			frame("error", { type: "error", error: { type: "server_error" } }),
		]);

		expect(await peekCodexStreamPrefix(response)).toBe("server_error");
	});

	it("ignores provider keepalive events while waiting for a failure", async () => {
		const response = sseResponse([
			CREATED,
			IN_PROGRESS,
			...Array.from({ length: 8 }, () =>
				frame("keepalive", { type: "keepalive" }),
			),
			frame("error", { type: "error", error: { type: "server_error" } }),
		]);

		expect(await peekCodexStreamPrefix(response)).toBe("server_error");
	});

	it("detects a delayed prelude failure", async () => {
		const response = delayedSseResponse(
			[
				CREATED,
				IN_PROGRESS,
				frame("keepalive", { type: "keepalive" }),
				frame("error", { type: "error", error: { type: "server_error" } }),
			],
			30,
		);

		expect(
			await peekCodexStreamPrefix(response, undefined, { timeoutMs: 200 }),
		).toBe("server_error");
	});

	it("skips an encrypted reasoning item before a delayed failure", async () => {
		const response = sseResponse([
			CREATED,
			IN_PROGRESS,
			frame("response.output_item.added", {
				type: "response.output_item.added",
				item: { type: "reasoning", content: [], encrypted_content: "opaque" },
			}),
			frame("error", { type: "error", error: { type: "server_error" } }),
		]);

		expect(await peekCodexStreamPrefix(response)).toBe("server_error");
	});
});

describe("peekCodexStreamPrefix — no detection", () => {
	for (const field of ["content", "summary"]) {
		it(`commits on reasoning with nonempty ${field}`, async () => {
			const response = sseResponse([
				CREATED,
				frame("response.output_item.added", {
					type: "response.output_item.added",
					item: {
						type: "reasoning",
						[field]: [{ type: "text", text: "Reasoning" }],
					},
				}),
				frame("error", { type: "error", error: { type: "server_error" } }),
			]);
			expect(await peekCodexStreamPrefix(response)).toBeNull();
		});
	}

	it("commits on a reasoning delta after a content-free reasoning item", async () => {
		const response = sseResponse([
			CREATED,
			frame("response.output_item.added", {
				type: "response.output_item.added",
				item: { type: "reasoning", content: [] },
			}),
			frame("response.reasoning_summary_text.delta", {
				type: "response.reasoning_summary_text.delta",
				delta: "Reasoning",
			}),
			frame("error", { type: "error", error: { type: "server_error" } }),
		]);
		expect(await peekCodexStreamPrefix(response)).toBeNull();
	});

	it("does not let a keepalive event name mask content in its payload", async () => {
		const response = sseResponse([
			CREATED,
			frame("keepalive", {
				type: "response.output_text.delta",
				delta: "hello",
			}),
			frame("error", { type: "error", error: { type: "server_error" } }),
		]);

		expect(await peekCodexStreamPrefix(response)).toBeNull();
	});

	it("commits on a non-reasoning output item before a failure", async () => {
		const response = sseResponse([
			CREATED,
			frame("response.output_item.added", {
				type: "response.output_item.added",
				item: { type: "function_call", call_id: "call_1" },
			}),
			frame("error", { type: "error", error: { type: "server_error" } }),
		]);

		expect(await peekCodexStreamPrefix(response)).toBeNull();
	});

	it("commits once content has streamed, even with an error in the same chunk", async () => {
		const response = sseResponse([
			CREATED +
				frame("response.output_text.delta", {
					type: "response.output_text.delta",
					delta: "partial output",
				}) +
				frame("error", { type: "error", error: { type: "server_error" } }),
		]);

		expect(await peekCodexStreamPrefix(response)).toBeNull();
	});

	it("commits on a non-transient error code", async () => {
		const response = sseResponse([
			CREATED,
			frame("error", { type: "error", error: { type: "permission_error" } }),
		]);

		expect(await peekCodexStreamPrefix(response)).toBeNull();
	});

	it("commits on an unrecognised event before any failure", async () => {
		const response = sseResponse([
			CREATED,
			frame("response.output_item.added", {
				type: "response.output_item.added",
				item: { type: "message" },
			}),
			frame("error", { type: "error", error: { type: "server_error" } }),
		]);

		expect(await peekCodexStreamPrefix(response)).toBeNull();
	});

	it("commits on a clean stream that ends before any error", async () => {
		const response = sseResponse([CREATED, IN_PROGRESS]);

		expect(await peekCodexStreamPrefix(response)).toBeNull();
	});

	it("commits on an unparseable data payload", async () => {
		const response = sseResponse([CREATED, "event: error\ndata: {oops\n\n"]);

		expect(await peekCodexStreamPrefix(response)).toBeNull();
	});

	for (const [label, init] of [
		["a non-200 status", { status: 503 }],
		["a JSON content-type", { contentType: "application/json" }],
		["no content-type at all", { contentType: null }],
	] as const) {
		it(`skips ${label}`, async () => {
			const response = sseResponse(
				[
					CREATED,
					frame("error", { type: "error", error: { type: "server_error" } }),
				],
				init,
			);

			expect(await peekCodexStreamPrefix(response)).toBeNull();
		});
	}
});

describe("peekCodexStreamPrefix — bounds", () => {
	it("does not read when the prelude budget is already spent", async () => {
		const response = sseResponse([
			frame("error", { type: "error", error: { type: "server_error" } }),
		]);

		expect(
			await peekCodexStreamPrefix(response, undefined, { timeoutMs: 0 }),
		).toBeNull();
	});

	it("gives up after the event budget", async () => {
		const preludes = Array.from({ length: CODEX_PEEK_MAX_EVENTS + 1 }, () =>
			frame("response.in_progress", { type: "response.in_progress" }),
		);
		const response = sseResponse([
			...preludes,
			frame("error", { type: "error", error: { type: "server_error" } }),
		]);

		expect(await peekCodexStreamPrefix(response)).toBeNull();
	});

	it("still detects inside the event budget", async () => {
		const preludes = Array.from({ length: CODEX_PEEK_MAX_EVENTS - 1 }, () =>
			frame("response.in_progress", { type: "response.in_progress" }),
		);
		const response = sseResponse([
			...preludes,
			frame("error", { type: "error", error: { type: "server_error" } }),
		]);

		expect(await peekCodexStreamPrefix(response)).toBe("server_error");
	});

	it("gives up after the byte budget", async () => {
		const padded = frame("response.created", {
			type: "response.created",
			response: { id: "x".repeat(4096) },
		});
		const response = sseResponse([
			padded,
			frame("error", { type: "error", error: { type: "server_error" } }),
		]);

		expect(
			await peekCodexStreamPrefix(response, undefined, { maxBytes: 512 }),
		).toBeNull();
	});

	it("gives up when the prefix stalls past the timeout", async () => {
		const response = hangingSseResponse(CREATED);
		const startedAt = Date.now();

		expect(
			await peekCodexStreamPrefix(response, undefined, { timeoutMs: 30 }),
		).toBeNull();
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	});
});

describe("peekCodexStreamPrefix — ownership", () => {
	it("leaves the forwarded twin byte-identical", async () => {
		const body =
			CREATED +
			frame("response.output_text.delta", {
				type: "response.output_text.delta",
				delta: "Hello",
			}) +
			frame("response.completed", {
				type: "response.completed",
				response: { usage: { input_tokens: 1, output_tokens: 1 } },
			});
		const response = sseResponse([body.slice(0, 40), body.slice(40)]);

		expect(await peekCodexStreamPrefix(response)).toBeNull();
		expect(await response.text()).toBe(body);
	});

	it("propagates a client abort raised during the peek", async () => {
		const controller = new AbortController();
		const response = hangingSseResponse(CREATED);
		setTimeout(() => controller.abort(), 10);

		await expect(
			peekCodexStreamPrefix(response, controller.signal, {
				timeoutMs: 5_000,
			}),
		).rejects.toThrow();
	});

	it("rejects immediately on an already-aborted signal", async () => {
		const response = sseResponse([CREATED]);

		await expect(
			peekCodexStreamPrefix(response, AbortSignal.abort()),
		).rejects.toThrow();
	});
});
