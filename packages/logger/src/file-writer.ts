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

/**
 * Source of monotonic milliseconds for the backoff deadline.
 *
 * The deadline must NOT be derived from the wall clock: an NTP correction, a VM
 * clock restore or an administrator stepping the clock backwards would freeze
 * file logging until wall time caught up with a stale deadline — turning a 5s
 * suspension into minutes or hours of silent log loss. performance.now() is
 * monotonic and unaffected by clock steps. Injectable so tests can drive the
 * window deterministically instead of waiting on a real one.
 */
export type MonotonicClock = () => number;

const defaultMonotonicClock: MonotonicClock = () => performance.now();

export interface LogFileWriterOptions {
	/** Overrides the monotonic clock backing the re-init backoff (tests only). */
	monotonicNow?: MonotonicClock;
}

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
	private readonly monotonicNow: MonotonicClock;
	/**
	 * Streams whose failure has already been reported. Reporting is tracked per
	 * stream rather than per writer so that a stale stream — one already replaced
	 * by rotation or dropped by close(), still draining buffered writes — reports
	 * its failure exactly once too. Its buffered lines are lost either way; that
	 * loss must not also be invisible.
	 */
	private readonly reportedFailures = new WeakSet<object>();
	private static readonly SIZE_CHECK_INTERVAL = 100;

	constructor(options: LogFileWriterOptions = {}) {
		this.monotonicNow = options.monotonicNow ?? defaultMonotonicClock;
		// Use environment variable if set, otherwise use tmp folder
		this.logDir = readEnv("LOG_DIR") || join(tmpdir(), "clankermux-logs");
		this.logFile = join(this.logDir, "app.log");
		// Nothing here may throw: the module-level singleton below is constructed
		// at import time, so a filesystem failure escaping the constructor kills
		// the process during module initialisation — before any of these guards
		// can apply, and on every restart for as long as the disk stays full.
		this.initStreamSafely();
	}

	/** Arms the suspension window during which write() is a cheap no-op. */
	private armBackoff(): void {
		this.streamUnavailableUntil =
			this.monotonicNow() + STREAM_REINIT_BACKOFF_MS;
	}

	/**
	 * Create the log directory if it is missing. A failure (full or read-only
	 * filesystem, EACCES) degrades to the same state as a failed open — no
	 * stream, backoff armed, reported once — and never throws.
	 */
	private ensureLogDir(): boolean {
		try {
			if (!existsSync(this.logDir)) {
				mkdirSync(this.logDir, { recursive: true });
			}
			return true;
		} catch (e: unknown) {
			this.stream = null;
			this.armBackoff();
			// console.error, not the logger: the logger writes through this very
			// stream, so reporting through it would recurse into the failure.
			console.error("Failed to create log directory:", e);
			return false;
		}
	}

	/**
	 * Report a stream's failure at most once, whichever path observes it first.
	 *
	 * A single stream can fail on two independent paths: end() throwing while it
	 * is being closed, and a later asynchronous 'error' event from filesystem I/O
	 * that was still pending for that same stream. Both must report — a lost log
	 * line that is never reported is the failure mode hardest to notice — but the
	 * operator reading a failing log must see one report, not a duplicate storm
	 * at exactly the moment the log is hardest to read. The WeakSet is the single
	 * place that decides, so every reporting path shares one answer.
	 *
	 * console.error, not the logger: the logger writes through this very stream,
	 * so reporting through it would recurse into the failure.
	 */
	private reportStreamFailureOnce(
		stream: object,
		context: string,
		err: unknown,
	): void {
		if (this.reportedFailures.has(stream)) {
			return;
		}
		this.reportedFailures.add(stream);
		console.error(`${context}:`, err);
	}

	/**
	 * End the current stream, tolerating a throwing end() (EIO on a dying
	 * filesystem, or a stream torn down underneath us). `this.stream` is cleared
	 * first so a failure can never leave an unusable stream installed.
	 */
	private closeStream(context: string): void {
		const stream = this.stream;
		this.stream = null;
		if (!stream || stream.destroyed) {
			return;
		}
		try {
			stream.end();
		} catch (e: unknown) {
			this.reportStreamFailureOnce(stream, context, e);
			try {
				stream.destroy();
			} catch {
				// Nothing further to do — the stream is already unusable.
			}
		}
	}

	/**
	 * initStream() is guarded internally at every filesystem call, but it is
	 * reached from the constructor and from write(), neither of which may throw
	 * under any filesystem condition. This second layer keeps that contract even
	 * if a later edit adds an unguarded call inside.
	 */
	private initStreamSafely(): void {
		try {
			this.initStream();
		} catch (e: unknown) {
			this.stream = null;
			this.armBackoff();
			console.error("Failed to initialise log file stream:", e);
		}
	}

	private initStream(): void {
		// Re-attempted on every init so a writer that started on a full disk can
		// still recover once space frees up.
		if (!this.ensureLogDir()) {
			return;
		}

		// Close existing stream if any
		this.closeStream("Failed to close the previous log file stream");

		// Check if we need to rotate. A stat failure must not abort the init: the
		// open below is what actually keeps logging alive, and rotation is only an
		// optimisation on top of it.
		try {
			if (existsSync(this.logFile)) {
				const stats = statSync(this.logFile);
				if (stats.size > this.maxFileSize) {
					this.rotateLog();
				}
			}
		} catch (e: unknown) {
			console.error("Failed to check the log file size for rotation:", e);
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
			this.armBackoff();
			// console.error, not the logger: the logger writes through this very
			// stream, so reporting through it would recurse into the failure.
			console.error("Failed to open log file stream:", e);
		}
	}

	/**
	 * Tear down a stream that failed and suspend file logging for the backoff
	 * window.
	 *
	 * Two independent decisions, deliberately not conflated:
	 * - Reporting is per stream, and happens even for a stale stream. A stream
	 *   replaced by rotation or dropped by close() can still emit ENOSPC while
	 *   its buffered writes drain; those lines are lost, and a lost line that is
	 *   never reported is the failure mode hardest to notice in production. It is
	 *   deduplicated against every other reporting path — see
	 *   reportStreamFailureOnce.
	 * - Only the stream that is still current may null out `this.stream` and arm
	 *   the backoff — a late error from an already-replaced stream must not knock
	 *   out its successor.
	 */
	private handleStreamFailure(
		stream: ReturnType<typeof createWriteStream>,
		context: string,
		err: unknown,
	): void {
		// Report once per stream: a failing disk can emit repeatedly, and a stream
		// whose end() already threw has reported through the same WeakSet.
		this.reportStreamFailureOnce(
			stream,
			`${context}, suspending file logging`,
			err,
		);
		if (this.stream === stream) {
			this.stream = null;
			this.armBackoff();
		}
		try {
			stream.destroy();
		} catch {
			// Nothing further to do — the stream is already unusable.
		}
	}

	private rotateLog(): void {
		this.closeStream("Failed to close the log file stream before rotation");

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
			if (this.monotonicNow() < this.streamUnavailableUntil) {
				return;
			}
			this.initStreamSafely();
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
						this.initStreamSafely();
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
		this.closeStream("Failed to close the log file stream");
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
