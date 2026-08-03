import { describe, expect, it, spyOn } from "bun:test";
import {
	type DrainReport,
	discardUpstreamBody,
} from "../response-body-disposal";

/**
 * The optional drain observer on {@link discardUpstreamBody}.
 *
 * It exists so a failover site can report on the body it threw away WITHOUT
 * changing control flow — the function still returns `void`, so failover never
 * waits on a dead account's body. These tests pin both halves of that: what the
 * report says, and that producing it costs the caller nothing.
 *
 * The marker scan is the PRIMARY signal on purpose. A size threshold alone
 * would be the wrong guard: a valid short completion is ~70 bytes and sits far
 * below any error-payload threshold, which is exactly the case worth catching.
 */

const DRAIN_BYTE_BUDGET = 8 * 1024 * 1024;
const MARKER_SCAN_BYTES = 64 * 1024;

/** A Response whose body yields `chunks` one per `pull`, then EOF. */
function bodyOf(chunks: Uint8Array[]): Response {
	let i = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i >= chunks.length) {
				controller.close();
				return;
			}
			controller.enqueue(chunks[i++]);
		},
	});
	return new Response(stream);
}

function textBody(text: string, chunkCount = 1): Response {
	const bytes = new TextEncoder().encode(text);
	const size = Math.max(1, Math.ceil(bytes.byteLength / chunkCount));
	const chunks: Uint8Array[] = [];
	for (let off = 0; off < bytes.byteLength; off += size) {
		chunks.push(bytes.slice(off, off + size));
	}
	return bodyOf(chunks.length > 0 ? chunks : [new Uint8Array(0)]);
}

/** Drain `response` and resolve with the single report the observer receives. */
function drainAndReport(response: Response): Promise<DrainReport> {
	return new Promise<DrainReport>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("drain observer never fired")),
			10_000,
		);
		discardUpstreamBody(response, (report) => {
			clearTimeout(timer);
			resolve(report);
		});
	});
}

describe("discardUpstreamBody — drain report", () => {
	it("reports a clean EOF with the exact byte count and no marker", async () => {
		const body = '{"type":"error","error":{"type":"rate_limit_error"}}';
		const expectedBytes = new TextEncoder().encode(body).byteLength;

		const report = await drainAndReport(textBody(body, 4));

		expect(report.stopReason).toBe("eof");
		expect(report.reachedEof).toBe(true);
		expect(report.bytesRead).toBe(expectedBytes);
		expect(report.marker).toBeNull();
	});

	it("flags a ~70-byte non-streaming completion that a size threshold would miss", async () => {
		const body =
			'{"type":"message","usage":{"input_tokens":10,"output_tokens":2}}';
		expect(body.length).toBeLessThan(100);

		const report = await drainAndReport(textBody(body, 3));

		expect(report.marker).toBe("anthropic-message-usage");
		expect(report.reachedEof).toBe(true);
		expect(report.bytesRead).toBe(body.length);
	});

	it("flags an SSE message_start frame", async () => {
		const report = await drainAndReport(
			textBody(
				'event: message_start\ndata: {"type":"message_start","message":{"model":"m"}}\n\n',
				5,
			),
		);
		expect(report.marker).toBe("sse-message-start");
	});

	it("flags an SSE message_delta frame", async () => {
		const report = await drainAndReport(
			textBody(
				'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n',
				5,
			),
		);
		expect(report.marker).toBe("sse-message-delta");
	});

	it("flags a Codex response.completed event", async () => {
		const report = await drainAndReport(
			textBody(
				'event: response.completed\ndata: {"type":"response.completed"}\n\n',
				5,
			),
		);
		expect(report.marker).toBe("codex-response-completed");
	});

	it("sees a signature split across a chunk boundary", async () => {
		// One byte per chunk: every literal we match straddles boundaries.
		const report = await drainAndReport(
			textBody('{"type":"message","usage":{}}', 29),
		);
		expect(report.marker).toBe("anthropic-message-usage");
	});

	it("does not mistake message_start's type for a non-streaming message", async () => {
		// `"type":"message_start"` must not satisfy the `"type":"message"` half —
		// the closing quote is what keeps the two vocabularies apart. (It matches
		// the SSE marker instead, which is the correct classification.)
		const report = await drainAndReport(
			textBody('{"type":"message_start"}', 1),
		);
		expect(report.marker).toBe("sse-message-start");
	});

	it("stays silent on an error body that merely mentions neither half", async () => {
		const report = await drainAndReport(
			textBody('{"type":"error","error":{"message":"overloaded"}}', 2),
		);
		expect(report.marker).toBeNull();
	});

	it("sees a terminal SSE frame far past the 64 KiB prefix window", async () => {
		// The terminal frames are at the TAIL of a real response. A head-only scan
		// would miss a completed answer in exactly the case this guard exists for.
		const filler = "-".repeat(4 * MARKER_SCAN_BYTES);
		const report = await drainAndReport(
			textBody(
				`${filler}event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n`,
				8,
			),
		);
		expect(report.marker).toBe("sse-message-delta");
	});

	it('combines a head `"type":"message"` with a `"usage"` megabytes later', async () => {
		// A long non-streaming completion: the type is in the prefix window, the
		// root `usage` object only in the suffix one, and the two halves latch
		// across both.
		const filler = "a".repeat(6 * MARKER_SCAN_BYTES);
		const report = await drainAndReport(
			textBody(
				`{"type":"message","content":"${filler}","usage":{"input_tokens":10,"output_tokens":2}}`,
				12,
			),
		);
		expect(report.marker).toBe("anthropic-message-usage");
	});

	it("never decodes more than one window's worth of an oversized chunk", async () => {
		// The scan is bounded by construction, not just by an early return: a huge
		// first chunk must not be decoded wholesale on the failover path.
		const decodedSizes: number[] = [];
		const original = TextDecoder.prototype.decode;
		const spy = spyOn(TextDecoder.prototype, "decode").mockImplementation(
			function (
				this: TextDecoder,
				input?: ArrayBufferView | ArrayBuffer,
				options?: { stream?: boolean },
			): string {
				decodedSizes.push(input?.byteLength ?? 0);
				return original.call(this, input as ArrayBufferView, options);
			} as typeof TextDecoder.prototype.decode,
		);

		try {
			const report = await drainAndReport(
				bodyOf([new Uint8Array(1024 * 1024)]),
			);
			expect(report.marker).toBeNull();
			expect(report.bytesRead).toBe(1024 * 1024);
		} finally {
			spy.mockRestore();
		}

		expect(decodedSizes.length).toBeGreaterThan(0);
		expect(Math.max(...decodedSizes)).toBeLessThanOrEqual(MARKER_SCAN_BYTES);
	});

	it("reports partial bytes accurately when the byte budget stops the drain", async () => {
		// 1 MiB per chunk: the loop exits the moment `drained` reaches the budget,
		// so the reported count is the budget exactly, EOF was never seen, and the
		// remainder is cancelled.
		const chunk = new Uint8Array(1024 * 1024);
		const chunks = Array.from({ length: 32 }, () => chunk);

		const report = await drainAndReport(bodyOf(chunks));

		expect(report.stopReason).toBe("byte-budget");
		expect(report.reachedEof).toBe(false);
		expect(report.bytesRead).toBe(DRAIN_BYTE_BUDGET);
	});

	it("reports a timed-out drain as 'time-budget', never as a clean EOF", async () => {
		// The deadline cancels the reader, and that cancellation is what resolves
		// the pending `read()` with `done: true`. A report that trusted `done`
		// would call a forcibly abandoned body a clean EOF.
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("partial"));
			},
			pull() {
				// Never resolves: the drain hangs until its deadline fires.
				return new Promise<void>(() => {});
			},
		});

		const report = await drainAndReport(new Response(stream));

		expect(report.stopReason).toBe("time-budget");
		expect(report.reachedEof).toBe(false);
		expect(report.bytesRead).toBe(7);
	}, 15_000);

	it("reports a stream error without claiming EOF", async () => {
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new TextEncoder().encode("partial"));
				controller.error(new Error("upstream reset"));
			},
		});

		const report = await drainAndReport(new Response(stream));

		expect(report.stopReason).toBe("stream-error");
		expect(report.reachedEof).toBe(false);
		expect(report.bytesRead).toBe(7);
	});

	it("reports 'locked' without draining when another reader owns the body", async () => {
		const response = textBody("hello", 1);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();

		const report = await drainAndReport(response);

		expect(report.stopReason).toBe("locked");
		expect(report.bytesRead).toBe(0);
		expect(report.reachedEof).toBe(false);
		await reader?.cancel();
	});

	it("returns before the observer runs — the caller never waits on the drain", async () => {
		let released!: () => void;
		const gate = new Promise<void>((resolve) => {
			released = resolve;
		});
		const stream = new ReadableStream<Uint8Array>({
			async pull(controller) {
				await gate;
				controller.enqueue(new TextEncoder().encode("late"));
				controller.close();
			},
		});

		let reported = false;
		const done = new Promise<void>((resolve) => {
			discardUpstreamBody(new Response(stream), () => {
				reported = true;
				resolve();
			});
		});

		// discardUpstreamBody has already returned while the body is still stalled.
		expect(reported).toBe(false);
		// …and it stays that way across turns of the event loop.
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(reported).toBe(false);

		released();
		await done;
		expect(reported).toBe(true);
	});

	it("swallows an observer that throws", () => {
		expect(() => {
			discardUpstreamBody(textBody("hello", 1), () => {
				throw new Error("observer blew up");
			});
		}).not.toThrow();
	});

	it("is a no-op for a response with no body", () => {
		let called = false;
		discardUpstreamBody(new Response(null, { status: 204 }), () => {
			called = true;
		});
		expect(called).toBe(false);
	});
});
