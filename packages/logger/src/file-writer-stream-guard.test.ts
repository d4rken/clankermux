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

function eio(syscall: string): NodeJS.ErrnoException {
	const err: NodeJS.ErrnoException = new Error(
		`EIO: i/o error, ${syscall} '/tmp/app.log'`,
	);
	err.code = "EIO";
	err.errno = -5;
	err.syscall = syscall;
	return err;
}

/** Replaces end() with one that throws, as a dying filesystem can. */
function withThrowingEnd(stream: FakeWriteStream): FakeWriteStream {
	stream.end = (() => {
		throw eio("close");
	}) as unknown as typeof stream.end;
	return stream;
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
	let errorSpy: ReturnType<typeof spyOn> | null = null;
	let spies: ReturnType<typeof spyOn>[] = [];

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
		for (const spy of spies) spy.mockRestore();
		spies = [];
		errorSpy?.mockRestore();
		errorSpy = null;
		if (savedLogDir === undefined) delete process.env.CLANKERMUX_LOG_DIR;
		else process.env.CLANKERMUX_LOG_DIR = savedLogDir;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("survives an asynchronous ENOSPC stream error without throwing", async () => {
		const mono = { t: 500 };
		const stream = new FakeWriteStream(enospc());
		const create = stubCreateWriteStream(() => stream);

		const writer = new LogFileWriter({ monotonicNow: () => mono.t });
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
		const mono = { t: 1_000_000 };

		const bad = new FakeWriteStream(enospc());
		const good = new FakeWriteStream();
		const queue: Writable[] = [bad, good];
		const create = stubCreateWriteStream(() => queue.shift() ?? good);

		const writer = new LogFileWriter({ monotonicNow: () => mono.t });
		writer.write(evt(1));
		await until(() => bad.destroyed, "failing stream destroyed");

		// Still inside the backoff window: no reopen attempt at all.
		mono.t += STREAM_REINIT_BACKOFF_MS - 1;
		expect(() => writer.write(evt(2))).not.toThrow();
		expect(create).toHaveBeenCalledTimes(1);
		expect(good.written).toHaveLength(0);

		// Backoff elapsed: the writer reopens and the line lands on the new stream.
		mono.t += 1;
		expect(() => writer.write(evt(3))).not.toThrow();
		expect(create).toHaveBeenCalledTimes(2);
		await until(() => good.written.length === 1, "recovered write flushed");
		expect((JSON.parse(good.written[0]) as LogEvent).ts).toBe(3);

		writer.close();
	});

	it("does not throw when the stream cannot be opened, and recovers later", async () => {
		const mono = { t: 2_000_000 };

		const good = new FakeWriteStream();
		let openFails = true;
		const create = stubCreateWriteStream(() => {
			if (openFails) throw enospc();
			return good;
		});

		let writer: LogFileWriter | null = null;
		expect(() => {
			writer = new LogFileWriter({ monotonicNow: () => mono.t });
		}).not.toThrow();
		const w = writer as unknown as LogFileWriter;
		expect(create).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalled();

		expect(() => w.write(evt(1))).not.toThrow();
		expect(create).toHaveBeenCalledTimes(1);

		openFails = false;
		mono.t += STREAM_REINIT_BACKOFF_MS;
		expect(() => w.write(evt(2))).not.toThrow();
		expect(create).toHaveBeenCalledTimes(2);
		await until(() => good.written.length === 1, "recovered write flushed");
		expect((JSON.parse(good.written[0]) as LogEvent).ts).toBe(2);

		w.close();
	});

	it("suppresses repeated reopen attempts inside the backoff window", () => {
		const mono = { t: 3_000_000 };

		const create = stubCreateWriteStream(() => {
			throw enospc();
		});

		const writer = new LogFileWriter({ monotonicNow: () => mono.t });
		expect(create).toHaveBeenCalledTimes(1);

		// 200 log lines spread over 2s — well inside the backoff window.
		for (let i = 0; i < 200; i++) {
			mono.t += 10;
			expect(() => writer.write(evt(i))).not.toThrow();
		}
		expect(create).toHaveBeenCalledTimes(1);

		// One attempt per backoff window, not one per log line.
		mono.t += STREAM_REINIT_BACKOFF_MS;
		expect(() => writer.write(evt(999))).not.toThrow();
		expect(create).toHaveBeenCalledTimes(2);

		writer.close();
	});

	it("does not propagate a synchronous stream.write() failure", async () => {
		const mono = { t: 4_000_000 };

		const exploding = new FakeWriteStream();
		exploding.write = (() => {
			throw new Error("Cannot call write after a stream was destroyed");
		}) as unknown as typeof exploding.write;
		const good = new FakeWriteStream();
		const queue: Writable[] = [exploding, good];
		const create = stubCreateWriteStream(() => queue.shift() ?? good);

		const writer = new LogFileWriter({ monotonicNow: () => mono.t });
		expect(() => writer.write(evt(1))).not.toThrow();
		expect(errorSpy).toHaveBeenCalled();

		// The broken stream is dropped and the next window reopens a fresh one.
		mono.t += STREAM_REINIT_BACKOFF_MS;
		expect(() => writer.write(evt(2))).not.toThrow();
		expect(create).toHaveBeenCalledTimes(2);
		await until(() => good.written.length === 1, "recovered write flushed");

		writer.close();
	});

	// F1: a stream replaced by rotation/close can still fail while its buffered
	// writes drain. Those lines are lost; the loss must not also be invisible.
	it("reports a stale stream's failure without disturbing its successor", async () => {
		const mono = { t: 5_000_000 };

		const stale = new FakeWriteStream();
		const successor = new FakeWriteStream();
		const queue: Writable[] = [stale, successor];
		const create = stubCreateWriteStream(() => queue.shift() ?? successor);

		const writer = new LogFileWriter({ monotonicNow: () => mono.t });
		writer.write(evt(1));
		await until(() => stale.written.length === 1, "first line written");

		// Drop the current stream and reopen: `stale` is no longer current.
		writer.close();
		writer.write(evt(2));
		expect(create).toHaveBeenCalledTimes(2);
		await until(() => successor.written.length === 1, "successor wrote");

		errorSpy?.mockClear();
		stale.emit("error", enospc());

		// Reported even though the stream is stale...
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(stale.destroyed).toBe(true);
		// ...and reported exactly once, however often the device re-emits.
		stale.emit("error", enospc());
		expect(errorSpy).toHaveBeenCalledTimes(1);

		// The successor is untouched: still current, no backoff armed.
		expect(() => writer.write(evt(3))).not.toThrow();
		expect(create).toHaveBeenCalledTimes(2);
		await until(() => successor.written.length === 2, "successor wrote again");

		const third = new FakeWriteStream();
		queue.push(third);
		writer.close();
		writer.write(evt(4));
		expect(create).toHaveBeenCalledTimes(3);

		writer.close();
	});

	// F2: the backoff deadline is monotonic, so a wall-clock step backwards
	// (NTP, a VM restore, an administrator) cannot stretch 5s into hours of
	// silent log loss.
	it("keeps the backoff deadline monotonic when the wall clock steps backwards", async () => {
		const mono = { t: 6_000_000 };
		let wall = 1_800_000_000_000;
		const nowSpy = spyOn(Date, "now").mockImplementation(() => wall);
		spies.push(nowSpy);

		const bad = new FakeWriteStream(enospc());
		const good = new FakeWriteStream();
		const queue: Writable[] = [bad, good];
		const create = stubCreateWriteStream(() => queue.shift() ?? good);

		const writer = new LogFileWriter({ monotonicNow: () => mono.t });
		writer.write(evt(1));
		await until(() => bad.destroyed, "failing stream destroyed");
		expect(create).toHaveBeenCalledTimes(1);

		// An hour of wall clock evaporates while only the backoff window elapses.
		wall -= 3_600_000;
		mono.t += STREAM_REINIT_BACKOFF_MS;

		expect(() => writer.write(evt(2))).not.toThrow();
		expect(create).toHaveBeenCalledTimes(2);
		await until(() => good.written.length === 1, "recovered write flushed");

		writer.close();
	});

	// F3: the module-level singleton is constructed at import time, so a
	// filesystem failure escaping the constructor kills the process during
	// module initialisation — on every restart, for as long as the disk is full.
	it("degrades instead of throwing when the log directory cannot be created", async () => {
		const mono = { t: 7_000_000 };
		process.env.CLANKERMUX_LOG_DIR = join(dir, "nested", "logs");

		const realMkdirSync = fs.mkdirSync;
		let mkdirFails = true;
		spies.push(
			spyOn(fs, "mkdirSync").mockImplementation(((
				path: fs.PathLike,
				options?: fs.MakeDirectoryOptions,
			) => {
				if (mkdirFails) throw enospc();
				return realMkdirSync(path, options);
			}) as unknown as typeof fs.mkdirSync),
		);

		const good = new FakeWriteStream();
		const create = stubCreateWriteStream(() => good);

		let writer: LogFileWriter | null = null;
		expect(() => {
			writer = new LogFileWriter({ monotonicNow: () => mono.t });
		}).not.toThrow();
		const w = writer as unknown as LogFileWriter;
		// Reported by the directory guard itself, not by the defensive catch
		// around initStream(): the specific failure has to be identifiable.
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy?.mock.calls[0]?.[0]).toContain(
			"Failed to create log directory",
		);
		// Without a directory there is nothing to open — and the backoff is armed,
		// so the failure is not retried per log line.
		expect(create).not.toHaveBeenCalled();
		expect(() => w.write(evt(1))).not.toThrow();
		expect(create).not.toHaveBeenCalled();

		// Once the filesystem recovers, the next window brings logging back.
		mkdirFails = false;
		mono.t += STREAM_REINIT_BACKOFF_MS;
		expect(() => w.write(evt(2))).not.toThrow();
		expect(create).toHaveBeenCalledTimes(1);
		await until(() => good.written.length === 1, "recovered write flushed");

		w.close();
	});

	// F4: write() must not throw through initStream() — statSync in the rotation
	// size check is a filesystem call on a path that must not throw.
	it("survives a throwing statSync while re-initialising from write()", async () => {
		const mono = { t: 8_000_000 };

		const bad = new FakeWriteStream(enospc());
		const good = new FakeWriteStream();
		const queue: Writable[] = [bad, good];
		const create = stubCreateWriteStream(() => queue.shift() ?? good);

		const writer = new LogFileWriter({ monotonicNow: () => mono.t });
		writer.write(evt(1));
		await until(() => bad.destroyed, "failing stream destroyed");

		// A real log file exists by the time the writer retries, and stat'ing it
		// fails.
		fs.writeFileSync(join(dir, "app.log"), "existing\n");
		spies.push(
			spyOn(fs, "statSync").mockImplementation((() => {
				throw eio("stat");
			}) as unknown as typeof fs.statSync),
		);

		mono.t += STREAM_REINIT_BACKOFF_MS;
		expect(() => writer.write(evt(2))).not.toThrow();
		// The open still happens: rotation is an optimisation, staying alive is not.
		expect(create).toHaveBeenCalledTimes(2);
		await until(() => good.written.length === 1, "recovered write flushed");

		writer.close();
	});

	// F4: the other unguarded filesystem call on that path — ending the previous
	// stream, which can fail with EIO on a dying filesystem.
	it("does not throw when closing a stream whose end() fails", () => {
		const mono = { t: 9_000_000 };

		const stubborn = withThrowingEnd(new FakeWriteStream());
		const good = new FakeWriteStream();
		const queue: Writable[] = [stubborn, good];
		const create = stubCreateWriteStream(() => queue.shift() ?? good);

		const writer = new LogFileWriter({ monotonicNow: () => mono.t });
		writer.write(evt(1));

		expect(() => writer.close()).not.toThrow();
		expect(errorSpy).toHaveBeenCalled();
		expect(stubborn.destroyed).toBe(true);

		// The writer stays usable: the failed close does not leave the broken
		// stream installed, and no backoff is armed by an ordinary close.
		expect(() => writer.write(evt(2))).not.toThrow();
		expect(create).toHaveBeenCalledTimes(2);

		writer.close();
	});

	it("keeps logging when the mid-stream rotation close() throws", async () => {
		const mono = { t: 10_000_000 };

		const stubborn = withThrowingEnd(new FakeWriteStream());
		const good = new FakeWriteStream();
		const queue: Writable[] = [stubborn, good];
		const create = stubCreateWriteStream(() => queue.shift() ?? good);

		const writer = new LogFileWriter({ monotonicNow: () => mono.t });
		expect(create).toHaveBeenCalledTimes(1);

		// Make the periodic size check (every 100 writes) trigger a rotation.
		fs.writeFileSync(join(dir, "app.log"), "existing\n");
		spies.push(
			spyOn(fs, "statSync").mockImplementation((() => ({
				size: 64 * 1024 * 1024,
			})) as unknown as typeof fs.statSync),
		);

		for (let i = 0; i < 100; i++) {
			expect(() => writer.write(evt(i))).not.toThrow();
		}

		// Rotation could not end the old stream, but logging continued on a fresh
		// one within the same write() — it did not silently stop.
		expect(create).toHaveBeenCalledTimes(2);
		expect(stubborn.destroyed).toBe(true);
		await until(() => good.written.length === 1, "post-rotation write flushed");
		expect((JSON.parse(good.written[0]) as LogEvent).ts).toBe(99);

		writer.close();
	});
});
