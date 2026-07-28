import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { LogEvent } from "@clankermux/types";
import { LogFileWriter, STREAM_REINIT_BACKOFF_MS } from "./file-writer";

/**
 * A stand-in for the fs.WriteStream returned by createWriteStream.
 *
 * When `failWith` is set, `_write` completes the callback with that error,
 * which is exactly how an ENOSPC surfaces on a real write stream: not as a
 * synchronous throw from `stream.write()`, but as an asynchronous 'error'
 * event. With no 'error' listener attached, that event terminates the process.
 */
class FakeWriteStream extends Writable {
	readonly written: string[] = [];
	failWith: NodeJS.ErrnoException | null;

	constructor(failWith: NodeJS.ErrnoException | null = null) {
		super();
		this.failWith = failWith;
	}

	override _write(
		chunk: Buffer | string,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		if (this.failWith) {
			callback(this.failWith);
			return;
		}
		this.written.push(chunk.toString());
		callback();
	}
}

function enospc(): NodeJS.ErrnoException {
	const err: NodeJS.ErrnoException = new Error(
		"ENOSPC: no space left on device, write",
	);
	err.code = "ENOSPC";
	err.errno = -28;
	err.syscall = "write";
	return err;
}

function evt(ts: number): LogEvent {
	return { ts, level: "INFO", msg: `line-${ts}` };
}

async function until(
	predicate: () => boolean,
	what = "condition",
): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error(`${what} never became true`);
}

describe("LogFileWriter stream failure guard", () => {
	let dir: string;
	let savedLogDir: string | undefined;
	let createSpy: ReturnType<typeof spyOn> | null = null;
	let nowSpy: ReturnType<typeof spyOn> | null = null;
	let errorSpy: ReturnType<typeof spyOn> | null = null;

	function stubCreateWriteStream(impl: () => Writable) {
		createSpy = spyOn(fs, "createWriteStream").mockImplementation(
			impl as unknown as typeof fs.createWriteStream,
		);
		return createSpy;
	}

	beforeEach(() => {
		savedLogDir = process.env.CLANKERMUX_LOG_DIR;
		dir = fs.mkdtempSync(join(tmpdir(), "clankermux-streamguard-"));
		process.env.CLANKERMUX_LOG_DIR = dir;
		// The writer reports failures through console.error on purpose (routing
		// them through the logger would recurse into the failing writer). Capture
		// it so the assertions can see it and the test output stays readable.
		errorSpy = spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		createSpy?.mockRestore();
		createSpy = null;
		nowSpy?.mockRestore();
		nowSpy = null;
		errorSpy?.mockRestore();
		errorSpy = null;
		if (savedLogDir === undefined) delete process.env.CLANKERMUX_LOG_DIR;
		else process.env.CLANKERMUX_LOG_DIR = savedLogDir;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("survives an asynchronous ENOSPC stream error without throwing", async () => {
		const stream = new FakeWriteStream(enospc());
		const create = stubCreateWriteStream(() => stream);

		const writer = new LogFileWriter();
		expect(() => writer.write(evt(1))).not.toThrow();

		// The 'error' event must be handled: the stream is torn down instead of
		// killing the process.
		await until(() => stream.destroyed, "stream destroyed after error");
		expect(errorSpy).toHaveBeenCalled();

		// A follow-up write is a cheap no-op inside the backoff window.
		expect(() => writer.write(evt(2))).not.toThrow();
		expect(create).toHaveBeenCalledTimes(1);

		writer.close();
	});

	it("re-initialises and writes again once the backoff elapses and the failure clears", async () => {
		let now = 1_000_000;
		nowSpy = spyOn(Date, "now").mockImplementation(() => now);

		const bad = new FakeWriteStream(enospc());
		const good = new FakeWriteStream();
		const queue: Writable[] = [bad, good];
		const create = stubCreateWriteStream(() => queue.shift() ?? good);

		const writer = new LogFileWriter();
		writer.write(evt(1));
		await until(() => bad.destroyed, "failing stream destroyed");

		// Still inside the backoff window: no reopen attempt at all.
		now += STREAM_REINIT_BACKOFF_MS - 1;
		expect(() => writer.write(evt(2))).not.toThrow();
		expect(create).toHaveBeenCalledTimes(1);
		expect(good.written).toHaveLength(0);

		// Backoff elapsed: the writer reopens and the line lands on the new stream.
		now += 1;
		expect(() => writer.write(evt(3))).not.toThrow();
		expect(create).toHaveBeenCalledTimes(2);
		await until(() => good.written.length === 1, "recovered write flushed");
		expect((JSON.parse(good.written[0]) as LogEvent).ts).toBe(3);

		writer.close();
	});

	it("does not throw when the stream cannot be opened, and recovers later", async () => {
		let now = 2_000_000;
		nowSpy = spyOn(Date, "now").mockImplementation(() => now);

		const good = new FakeWriteStream();
		let openFails = true;
		const create = stubCreateWriteStream(() => {
			if (openFails) throw enospc();
			return good;
		});

		let writer: LogFileWriter | null = null;
		expect(() => {
			writer = new LogFileWriter();
		}).not.toThrow();
		const w = writer as unknown as LogFileWriter;
		expect(create).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalled();

		expect(() => w.write(evt(1))).not.toThrow();
		expect(create).toHaveBeenCalledTimes(1);

		openFails = false;
		now += STREAM_REINIT_BACKOFF_MS;
		expect(() => w.write(evt(2))).not.toThrow();
		expect(create).toHaveBeenCalledTimes(2);
		await until(() => good.written.length === 1, "recovered write flushed");
		expect((JSON.parse(good.written[0]) as LogEvent).ts).toBe(2);

		w.close();
	});

	it("suppresses repeated reopen attempts inside the backoff window", () => {
		let now = 3_000_000;
		nowSpy = spyOn(Date, "now").mockImplementation(() => now);

		const create = stubCreateWriteStream(() => {
			throw enospc();
		});

		const writer = new LogFileWriter();
		expect(create).toHaveBeenCalledTimes(1);

		// 200 log lines spread over 2s — well inside the backoff window.
		for (let i = 0; i < 200; i++) {
			now += 10;
			expect(() => writer.write(evt(i))).not.toThrow();
		}
		expect(create).toHaveBeenCalledTimes(1);

		// One attempt per backoff window, not one per log line.
		now += STREAM_REINIT_BACKOFF_MS;
		expect(() => writer.write(evt(999))).not.toThrow();
		expect(create).toHaveBeenCalledTimes(2);

		writer.close();
	});

	it("does not propagate a synchronous stream.write() failure", async () => {
		let now = 4_000_000;
		nowSpy = spyOn(Date, "now").mockImplementation(() => now);

		const exploding = new FakeWriteStream();
		exploding.write = (() => {
			throw new Error("Cannot call write after a stream was destroyed");
		}) as unknown as typeof exploding.write;
		const good = new FakeWriteStream();
		const queue: Writable[] = [exploding, good];
		const create = stubCreateWriteStream(() => queue.shift() ?? good);

		const writer = new LogFileWriter();
		expect(() => writer.write(evt(1))).not.toThrow();
		expect(errorSpy).toHaveBeenCalled();

		// The broken stream is dropped and the next window reopens a fresh one.
		now += STREAM_REINIT_BACKOFF_MS;
		expect(() => writer.write(evt(2))).not.toThrow();
		expect(create).toHaveBeenCalledTimes(2);
		await until(() => good.written.length === 1, "recovered write flushed");

		writer.close();
	});
});
