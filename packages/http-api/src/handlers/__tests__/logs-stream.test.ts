import { afterEach, describe, expect, it } from "bun:test";
import { logBus } from "@clankermux/logger";
import type { LogEvent } from "@clankermux/types";
import { closeAllSseStreams } from "../../sse-registry";
import { createLogsStreamHandler } from "../logs";

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
	const res = handler(req ?? new Request("http://localhost/api/logs/stream"));
	if (!res.body) throw new Error("expected a streaming body");
	const reader = res.body.getReader();
	activeReaders.push(reader);
	return reader;
}

const sampleEvent: LogEvent = {
	ts: Date.now(),
	level: "INFO",
	msg: "hello logs",
};

afterEach(async () => {
	for (const reader of activeReaders.splice(0)) {
		try {
			await reader.cancel();
		} catch {}
	}
	// Listener teardown after cancel happens on the next failed write (the
	// heartbeat tick); wait for it so the next test's baseline is stable.
	await new Promise((resolve) => setTimeout(resolve, 60));
});

describe("createLogsStreamHandler", () => {
	it("sends the initial connected message and forwards log events", async () => {
		const handler = createLogsStreamHandler();
		const reader = openStream(handler);

		const initial = await readUntil(reader, (t) => t.includes("connected"));
		expect(initial).toContain(
			`data: ${JSON.stringify({ connected: true })}\n\n`,
		);

		logBus.emit("log", sampleEvent);
		const text = await readUntil(reader, (t) => t.includes("hello logs"));
		expect(text).toContain(`data: ${JSON.stringify(sampleEvent)}\n\n`);
	});

	it("does not tear down the stream on an unserializable log event", async () => {
		closeAllSseStreams(); // flush closers leaked by other suites
		const baseline = logBus.listenerCount("log");
		const handler = createLogsStreamHandler(20);
		const reader = openStream(handler);

		await readUntil(reader, (t) => t.includes("connected"));
		expect(logBus.listenerCount("log")).toBe(baseline + 1);

		// A circular payload: JSON.stringify would throw. Previously the handler's
		// catch conflated that with a closed socket and cleaned up the listener,
		// disconnecting the whole dashboard feed. Now it must survive.
		// biome-ignore lint/suspicious/noExplicitAny: cyclic test payload
		const circular: any = { a: 1 };
		circular.self = circular;
		logBus.emit("log", {
			ts: Date.now(),
			level: "ERROR",
			msg: "bad-event",
			data: circular,
		} as LogEvent);

		// The event is still forwarded — with the data replaced by a marker — and
		// the listener remains subscribed (stream not torn down).
		const text = await readUntil(reader, (t) => t.includes("bad-event"));
		expect(text).toContain("bad-event");
		expect(text).toContain("[unserializable:");
		expect(logBus.listenerCount("log")).toBe(baseline + 1);

		// And a subsequent normal event still flows through the same live stream.
		logBus.emit("log", { ...sampleEvent, msg: "still-alive" });
		const more = await readUntil(reader, (t) => t.includes("still-alive"));
		expect(more).toContain("still-alive");
	});

	it("emits periodic heartbeat comments to keep the connection alive", async () => {
		const handler = createLogsStreamHandler(20);
		const reader = openStream(handler);

		const text = await readUntil(
			reader,
			(t) => (t.match(/: ping\n\n/g)?.length ?? 0) >= 2,
		);
		expect(text.match(/: ping\n\n/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
	});

	it("stops the heartbeat and unsubscribes on request abort", async () => {
		const baseline = logBus.listenerCount("log");
		const handler = createLogsStreamHandler(20);
		const controller = new AbortController();
		const reader = openStream(
			handler,
			new Request("http://localhost/api/logs/stream", {
				signal: controller.signal,
			}),
		);

		await readUntil(reader, (t) => t.includes("connected"));
		expect(logBus.listenerCount("log")).toBe(baseline + 1);

		controller.abort();
		expect(logBus.listenerCount("log")).toBe(baseline);

		// No heartbeat writes after abort
		const after = await readUntil(reader, (t) => t.includes(": ping"), 80);
		expect(after).not.toContain(": ping");
	});

	it("unsubscribes when the reader cancels", async () => {
		const baseline = logBus.listenerCount("log");
		const handler = createLogsStreamHandler(20);
		const reader = openStream(handler);

		await readUntil(reader, (t) => t.includes("connected"));
		expect(logBus.listenerCount("log")).toBe(baseline + 1);

		await reader.cancel();
		// The writer-side failure surfaces on the next write attempt; the
		// heartbeat tick (20ms) triggers it and must clean up the listener.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(logBus.listenerCount("log")).toBe(baseline);
	});

	it("ends the stream and unsubscribes when closeAllSseStreams runs", async () => {
		closeAllSseStreams(); // flush closers leaked by other suites
		const baseline = logBus.listenerCount("log");
		const handler = createLogsStreamHandler(20);
		const reader = openStream(handler);

		await readUntil(reader, (t) => t.includes("connected"));
		expect(logBus.listenerCount("log")).toBe(baseline + 1);

		expect(closeAllSseStreams()).toBe(1);
		expect(logBus.listenerCount("log")).toBe(baseline);

		// Listener is gone, so events emitted after close must not reach the
		// stream; the reader drains pending chunks and then finishes cleanly.
		logBus.emit("log", { ...sampleEvent, msg: "after-close" });
		const { done, text } = await readToEnd(reader);
		expect(done).toBe(true);
		expect(text).not.toContain("after-close");
	});

	it("unregisters the shutdown closer on request abort", async () => {
		closeAllSseStreams();
		const handler = createLogsStreamHandler(20);
		const controller = new AbortController();
		const reader = openStream(
			handler,
			new Request("http://localhost/api/logs/stream", {
				signal: controller.signal,
			}),
		);

		await readUntil(reader, (t) => t.includes("connected"));
		controller.abort();
		expect(closeAllSseStreams()).toBe(0);
	});
});
