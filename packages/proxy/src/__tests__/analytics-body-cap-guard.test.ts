import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Logger } from "@clankermux/logger";
import type { ProxyContext } from "../handlers";
import {
	EVENT_ANALYTICS_BODY_CAP_WITHOUT_EOF,
	forwardToClient,
} from "../response-handler";

/**
 * Guard A: the non-streaming analytics read stops at a 256 KiB cap. Whatever it
 * did NOT read is invisible to the usage collector — and a non-streaming
 * Anthropic body carries its `usage` object at the END — so a body that hits
 * the cap yields ESTIMATED tokens while looking exactly like a normal request.
 *
 * Production says non-streaming bodies are far below the cap. This guard proves
 * that stays true and names the request if it does not. It is log-only: the
 * read, the cancellation and the recorded row are unchanged.
 *
 * The EOF flag is tracked EXPLICITLY rather than inferred from the
 * oversize-chunk branch, and both exit paths are covered below: chunks whose
 * sum CROSSES the cap (oversize branch), and chunks summing to EXACTLY the cap
 * with more data behind them (the `while` condition, which never enters that
 * branch).
 */

const CAP_BYTES = 256 * 1024;

function toArrayBuffer(s: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(s);
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

function createCtx(): ProxyContext {
	return {
		strategy: {},
		dbOps: {},
		runtime: { port: 8080, tlsEnabled: false },
		config: { getStorePayloads: () => false },
		provider: { name: "anthropic", isStreamingResponse: () => false },
		refreshInFlight: new Map<string, Promise<string>>(),
		asyncWriter: {},
		requestRecorder: {
			begin: mock(() => {}),
			captureResponseChunk: mock(() => {}),
			finishTransport: mock(() => {}),
			attachUsageSummary: mock(() => {}),
			markUsageUnavailable: mock(() => {}),
			recordSynthetic: mock(() => {}),
			sweep: mock(() => {}),
			dispose: mock(() => {}),
		},
	} as unknown as ProxyContext;
}

/** Collect every WARN line emitted during the test. */
function captureWarnings(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const spy = spyOn(Logger.prototype, "warn").mockImplementation(
		(message: string) => {
			lines.push(message);
		},
	);
	return { lines, restore: () => spy.mockRestore() };
}

/** A body that yields each of `chunks` on its own `pull`, then EOF. */
function bodyOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i >= chunks.length) {
				controller.close();
				return;
			}
			controller.enqueue(chunks[i++]);
		},
	});
}

async function forwardAndDrain(
	body: BodyInit,
	requestId: string,
): Promise<void> {
	const ctx = createCtx();
	const response = await forwardToClient(
		{
			requestId,
			method: "POST",
			path: "/v1/messages",
			account: null,
			requestHeaders: new Headers({ "content-type": "application/json" }),
			requestBody: toArrayBuffer("{}"),
			response: new Response(body, {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
			timestamp: Date.now(),
			retryAttempt: 0,
			failoverAttempts: 0,
		},
		ctx,
	);
	// The analytics branch is a tee twin of what the client reads; drain the
	// client side so both branches progress, then let the background IIFE settle.
	await response.text();
	for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 2));
}

function capWarnings(lines: string[]): string[] {
	return lines.filter((line) =>
		line.startsWith(`event=${EVENT_ANALYTICS_BODY_CAP_WITHOUT_EOF}`),
	);
}

describe("Guard A — non-streaming analytics body cap", () => {
	afterEach(() => {
		mock.restore();
	});

	it("stays silent for an ordinary under-cap body", async () => {
		const capture = captureWarnings();
		try {
			await forwardAndDrain(
				JSON.stringify({
					model: "claude-sonnet-4-5",
					usage: { input_tokens: 10, output_tokens: 2 },
				}),
				"req-under-cap",
			);
		} finally {
			capture.restore();
		}

		expect(capWarnings(capture.lines)).toEqual([]);
	});

	it("warns for a body that ends exactly at the cap — deliberately conservative", async () => {
		// Sums to the cap and then EOFs, so nothing was actually lost. The loop
		// still warns: it leaves through its `while` condition BEFORE the read that
		// would have reported `done`, and the only way to tell this apart from a
		// truncation is to issue that extra read — which would change the read
		// behaviour the guard is supposed to observe, not alter. A 262144-byte
		// body is the price of a guard that cannot miss a real truncation.
		const chunks = Array.from({ length: 4 }, () => new Uint8Array(64 * 1024));
		const capture = captureWarnings();
		try {
			await forwardAndDrain(bodyOf(chunks), "req-exact-cap-eof");
		} finally {
			capture.restore();
		}

		expect(capWarnings(capture.lines)).toHaveLength(1);
	});

	it("warns once when a single chunk crosses the cap", async () => {
		const capture = captureWarnings();
		try {
			await forwardAndDrain(
				bodyOf([new Uint8Array(CAP_BYTES + 4096)]),
				"req-oversize-chunk",
			);
		} finally {
			capture.restore();
		}

		const warnings = capWarnings(capture.lines);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("requestId=req-oversize-chunk");
		expect(warnings[0]).toContain(`capBytes=${CAP_BYTES}`);
		expect(warnings[0]).toContain(`bytesRead=${CAP_BYTES}`);
	});

	it("warns once when chunks total exactly the cap and more data follows", async () => {
		// The exit path the oversize branch cannot see: `bytesRead` reaches the cap
		// on a chunk boundary, so the loop leaves through its `while` condition
		// with data still queued and EOF never observed.
		const chunks = [
			...Array.from({ length: 4 }, () => new Uint8Array(64 * 1024)),
			new Uint8Array(1024),
		];
		const capture = captureWarnings();
		try {
			await forwardAndDrain(bodyOf(chunks), "req-exact-cap-more");
		} finally {
			capture.restore();
		}

		const warnings = capWarnings(capture.lines);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("requestId=req-exact-cap-more");
		expect(warnings[0]).toContain(`bytesRead=${CAP_BYTES}`);
	});
});
