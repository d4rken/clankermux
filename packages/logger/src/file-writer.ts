import {
	createWriteStream,
	existsSync,
	mkdirSync,
	statSync,
	truncateSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnv } from "@clankermux/core/env";
import type { LogEvent } from "@clankermux/types";
import { safeStringifyLogEvent } from "./serialize";

// Local constants to avoid circular dependency with core
const BUFFER_SIZES = {
	LOG_FILE_MAX_SIZE: 10 * 1024 * 1024, // 10MB
} as const;

const LIMITS = {
	LOG_MESSAGE_MAX_LENGTH: 10000,
	LOG_READ_DEFAULT: 1000,
} as const;

/**
 * How long file logging stays suspended after the write stream fails (an
 * asynchronous 'error' event, a failed open, or a throwing write).
 *
 * Without a backoff, a persistently failing disk would make every single log
 * line attempt a fresh createWriteStream — a performance problem of its own on
 * the highest-frequency write path in the process, which runs at DEBUG level in
 * production. Exported so tests can drive the window deterministically.
 */
export const STREAM_REINIT_BACKOFF_MS = 5000;

// Simple disposable interface to avoid circular dependency
interface Disposable {
	dispose(): void;
}

const disposables = new Set<Disposable>();

function registerDisposable(disposable: Disposable): void {
	disposables.add(disposable);
}

export class LogFileWriter implements Disposable {
	private logDir: string;
	private logFile: string;
	private stream: ReturnType<typeof createWriteStream> | null = null;
	private maxFileSize = BUFFER_SIZES.LOG_FILE_MAX_SIZE;
	private writeCount = 0;
	private streamUnavailableUntil = 0;
	private static readonly SIZE_CHECK_INTERVAL = 100;

	constructor() {
		// Use environment variable if set, otherwise use tmp folder
		this.logDir = readEnv("LOG_DIR") || join(tmpdir(), "clankermux-logs");
		if (!existsSync(this.logDir)) {
			mkdirSync(this.logDir, { recursive: true });
		}

		this.logFile = join(this.logDir, "app.log");
		this.initStream();
	}

	private initStream(): void {
		// Close existing stream if any
		if (this.stream && !this.stream.destroyed) {
			this.stream.end();
			this.stream = null;
		}

		// Check if we need to rotate
		if (existsSync(this.logFile)) {
			const stats = statSync(this.logFile);
			if (stats.size > this.maxFileSize) {
				this.rotateLog();
			}
		}

		// Create write stream with append mode. On a full filesystem the open
		// itself can fail, so a failed open must leave the writer stream-less
		// rather than throw out of the constructor or out of write().
		try {
			const stream = createWriteStream(this.logFile, { flags: "a" });
			// A write stream reports failures such as ENOSPC asynchronously, as an
			// 'error' event — stream.write() does not throw for them. An 'error'
			// event with no listener terminates the process, which is how a full
			// disk turned into a crash loop. Logging must degrade, never take the
			// process down with it.
			stream.on("error", (err) => {
				this.handleStreamFailure(stream, "Log file stream error", err);
			});
			this.stream = stream;
			this.streamUnavailableUntil = 0;
		} catch (e: unknown) {
			this.stream = null;
			this.streamUnavailableUntil = Date.now() + STREAM_REINIT_BACKOFF_MS;
			// console.error, not the logger: the logger writes through this very
			// stream, so reporting through it would recurse into the failure.
			console.error("Failed to open log file stream:", e);
		}
	}

	/**
	 * Tear down a stream that failed and suspend file logging for the backoff
	 * window. Only the stream that is still current may null out `this.stream`
	 * and arm the backoff — a late error from an already-replaced stream must
	 * not knock out its successor.
	 */
	private handleStreamFailure(
		stream: ReturnType<typeof createWriteStream>,
		context: string,
		err: unknown,
	): void {
		const isCurrent = this.stream === stream;
		if (isCurrent) {
			// Report once per stream: a failing disk can emit repeatedly.
			console.error(`${context}, suspending file logging:`, err);
			this.stream = null;
			this.streamUnavailableUntil = Date.now() + STREAM_REINIT_BACKOFF_MS;
		}
		try {
			stream.destroy();
		} catch {
			// Nothing further to do — the stream is already unusable.
		}
	}

	private rotateLog(): void {
		if (this.stream) {
			this.stream.end();
			this.stream = null;
		}

		if (existsSync(this.logFile)) {
			try {
				unlinkSync(this.logFile);
			} catch (e: unknown) {
				const code = (e as NodeJS.ErrnoException).code;
				if (code === "EACCES" || code === "EPERM") {
					// Fallback: try truncating the file instead
					try {
						truncateSync(this.logFile, 0);
					} catch (truncErr) {
						console.error(
							"Log rotation fallback to truncate failed, switching to new file:",
							truncErr,
						);
						// Last resort: switch to a timestamped log file
						this.logFile = join(this.logDir, `app-${Date.now()}.log`);
					}
				} else {
					console.error("Failed to rotate log:", e);
				}
			}
		}
	}

	write(event: LogEvent): void {
		if (!this.stream || this.stream.destroyed) {
			// While the stream is suspended after a failure, writing is a cheap
			// no-op: reopening per log line on a failing disk is its own problem.
			if (Date.now() < this.streamUnavailableUntil) {
				return;
			}
			this.initStream();
			if (!this.stream) {
				return;
			}
		}

		// Periodic size check to trigger rotation mid-stream (every N writes)
		if (++this.writeCount % LogFileWriter.SIZE_CHECK_INTERVAL === 0) {
			try {
				if (existsSync(this.logFile)) {
					const stats = statSync(this.logFile);
					if (stats.size > this.maxFileSize) {
						this.rotateLog();
						this.initStream();
					}
				}
			} catch {
				// Ignore stat errors, will be caught on next initStream
			}
		}

		// Serialize defensively: `event.data` is caller-supplied and may be
		// unserializable (circular/BigInt/throwing toJSON). An uncaught throw here
		// would propagate into the caller's business logic. safeStringifyLogEvent
		// substitutes a marker (preserving ts/level/msg) so a write can never throw
		// or be silently lost.
		const line = `${safeStringifyLogEvent(event)}\n`;
		const stream = this.stream;
		if (stream) {
			// write() can also throw synchronously (e.g. writing to a stream that
			// was already destroyed). A logging failure must never propagate into
			// the caller's business logic.
			try {
				stream.write(line);
			} catch (e: unknown) {
				this.handleStreamFailure(stream, "Log file write failed", e);
			}
		}
	}

	async readLogs(limit: number = LIMITS.LOG_READ_DEFAULT): Promise<LogEvent[]> {
		if (!existsSync(this.logFile)) {
			return [];
		}

		try {
			const content = await Bun.file(this.logFile).text();
			const lines = content.trim().split("\n").filter(Boolean);

			// Return the last N logs
			return lines
				.slice(-limit)
				.map((line) => {
					try {
						return JSON.parse(line);
					} catch {
						return null;
					}
				})
				.filter((log): log is LogEvent => log !== null);
		} catch (_e) {
			console.error("Failed to read logs:", _e);
			return [];
		}
	}

	close(): void {
		if (this.stream) {
			this.stream.end();
			this.stream = null;
		}
	}

	dispose(): void {
		this.close();
	}
}

// Check if we're in a Node.js/Bun environment (not browser)
const isNodeEnvironment =
	typeof process !== "undefined" &&
	process.versions != null &&
	process.versions.node != null;

function isMainThreadEnvironment(): boolean {
	if (!isNodeEnvironment) return false;
	try {
		const workerThreads = require("node:worker_threads") as {
			isMainThread?: boolean;
		};
		return workerThreads.isMainThread !== false;
	} catch {
		return true;
	}
}

// Singleton instance - only create in the main Node/Bun thread. Bun Worker
// termination currently leaves worker-side file streams/descriptors around, and
// hot worker paths such as isolated analytics should not open app.log at all.
export const logFileWriter: LogFileWriter | null =
	isNodeEnvironment && isMainThreadEnvironment() ? new LogFileWriter() : null;

// Register with lifecycle manager (only in Node.js)
if (logFileWriter) {
	registerDisposable(logFileWriter);
}
