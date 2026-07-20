import { afterEach, describe, expect, it } from "bun:test";
import { requestEvents } from "@clankermux/core";
import { closeAllSseStreams } from "../../sse-registry";
import { createRequestsStreamHandler } from "../requests-stream";

const decoder = new TextDecoder();

/** Reads from the stream until `predicate` matches the accumulated text or timeout. */
async function readUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	predicate: (text: string) => boolean,
	timeoutMs = 1000,
): Promise<string> {
	let text = "";
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await Promise.race([
			reader.read(),
			new Promise<null>((resolve) =>
				setTimeout(() => resolve(null), deadline - Date.now()),
			),
		]);
		if (result === null || result.done) break;
		text += decoder.decode(result.value, { stream: true });
		if (predicate(text)) return text;
	}
	return text;
}

/** Drains the stream until done or timeout; reports whether it ended. */
async function readToEnd(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	timeoutMs = 1000,
): Promise<{ done: boolean; text: string }> {
	let text = "";
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await Promise.race([
			reader.read(),
			new Promise<null>((resolve) =>
				setTimeout(() => resolve(null), deadline - Date.now()),
			),
		]);
		if (result === null) return { done: false, text };
		if (result.done) return { done: true, text };
		text += decoder.decode(result.value, { stream: true });
	}
	return { done: false, text };
}

const activeReaders: ReadableStreamDefaultReader<Uint8Array>[] = [];

function openStream(handler: (req: Request) => Response, req?: Request) {
	const res = handler(
		req ?? new Request("http://localhost/api/requests/stream"),
	);
	if (!res.body) throw new Error("expected a streaming body");
	const reader = res.body.getReader();
	activeReaders.push(reader);
	return reader;
}

afterEach(async () => {
	for (const reader of activeReaders.splice(0)) {
		try {
			await reader.cancel();
		} catch {}
	}
});

describe("createRequestsStreamHandler", () => {
	it("sends the initial connected message and forwards events", async () => {
		const handler = createRequestsStreamHandler();
		const reader = openStream(handler);

		const initial = await readUntil(reader, (t) => t.includes("connected"));
		expect(initial).toContain("event: connected\ndata: ok\n\n");

		requestEvents.emit("event", { type: "start", id: "req-1" });
		const text = await readUntil(reader, (t) => t.includes("req-1"));
		expect(text).toContain(
			`data: ${JSON.stringify({ type: "start", id: "req-1" })}\n\n`,
		);
	});

	it("emits periodic heartbeat comments to keep the connection alive", async () => {
		const handler = createRequestsStreamHandler(20);
		const reader = openStream(handler);

		const text = await readUntil(
			reader,
			(t) => (t.match(/: ping\n\n/g)?.length ?? 0) >= 2,
		);
		expect(text.match(/: ping\n\n/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
	});

	it("stops the heartbeat and unsubscribes on cancel", async () => {
		const baseline = requestEvents.listenerCount("event");
		const handler = createRequestsStreamHandler(20);
		const reader = openStream(handler);

		await readUntil(reader, (t) => t.includes("connected"));
		expect(requestEvents.listenerCount("event")).toBe(baseline + 1);

		await reader.cancel();
		expect(requestEvents.listenerCount("event")).toBe(baseline);

		// If the heartbeat timer survived cancel, its next tick would enqueue on
		// a cancelled controller; give it time to fire and verify it self-heals
		// without throwing (cleared interval = nothing happens at all).
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(requestEvents.listenerCount("event")).toBe(baseline);
	});

	it("stops the heartbeat and unsubscribes on request abort", async () => {
		const baseline = requestEvents.listenerCount("event");
		const handler = createRequestsStreamHandler(20);
		const controller = new AbortController();
		const reader = openStream(
			handler,
			new Request("http://localhost/api/requests/stream", {
				signal: controller.signal,
			}),
		);

		await readUntil(reader, (t) => t.includes("connected"));
		expect(requestEvents.listenerCount("event")).toBe(baseline + 1);

		controller.abort();
		expect(requestEvents.listenerCount("event")).toBe(baseline);

		// No heartbeat writes after abort
		const after = await readUntil(reader, (t) => t.includes(": ping"), 80);
		expect(after).not.toContain(": ping");
	});

	it("ends the stream and unsubscribes when closeAllSseStreams runs", async () => {
		closeAllSseStreams(); // flush closers leaked by other suites
		const baseline = requestEvents.listenerCount("event");
		const handler = createRequestsStreamHandler(20);
		const reader = openStream(handler);

		await readUntil(reader, (t) => t.includes("connected"));
		expect(requestEvents.listenerCount("event")).toBe(baseline + 1);

		expect(closeAllSseStreams()).toBe(1);
		expect(requestEvents.listenerCount("event")).toBe(baseline);

		// Listener is gone, so events emitted after close must not reach the
		// stream; the reader drains pending chunks and then finishes cleanly.
		requestEvents.emit("event", { type: "start", id: "after-close" });
		const { done, text } = await readToEnd(reader);
		expect(done).toBe(true);
		expect(text).not.toContain("after-close");

		// Heartbeat cleared: waiting past its interval must not resubscribe.
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(requestEvents.listenerCount("event")).toBe(baseline);
	});

	it("unregisters the shutdown closer on request abort", async () => {
		closeAllSseStreams();
		const handler = createRequestsStreamHandler(20);
		const controller = new AbortController();
		const reader = openStream(
			handler,
			new Request("http://localhost/api/requests/stream", {
				signal: controller.signal,
			}),
		);

		await readUntil(reader, (t) => t.includes("connected"));
		controller.abort();
		expect(closeAllSseStreams()).toBe(0);
	});

	it("unregisters the shutdown closer on reader cancel", async () => {
		closeAllSseStreams();
		const handler = createRequestsStreamHandler(20);
		const reader = openStream(handler);

		await readUntil(reader, (t) => t.includes("connected"));
		await reader.cancel();
		expect(closeAllSseStreams()).toBe(0);
	});
});
