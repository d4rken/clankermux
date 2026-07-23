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
import { safeReason } from "./serialize";

// Local constants to avoid circular dependency with core
const BUFFER_SIZES = {
	LOG_FILE_MAX_SIZE: 10 * 1024 * 1024, // 10MB
} as const;

const LIMITS = {
	LOG_MESSAGE_MAX_LENGTH: 10000,
	LOG_READ_DEFAULT: 1000,
} as const;

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

		// Create write stream with append mode
		this.stream = createWriteStream(this.logFile, { flags: "a" });
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
			this.initStream();
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
		// would propagate into the caller's business logic. On failure, rebuild a
		// minimal event preserving ts/level/msg with a marker in place of data; if
		// even that throws (e.g. a hostile `msg` getter), fall back to a fixed,
		// always-valid JSON line so a write can never throw or be silently lost.
		let line: string;
		try {
			line = `${JSON.stringify(event)}\n`;
		} catch (e: unknown) {
			const reason = safeReason(e);
			try {
				const fallback: LogEvent = {
					ts: event.ts,
					level: event.level,
					msg: event.msg,
					data: `[unserializable: ${reason}]`,
				};
				line = `${JSON.stringify(fallback)}\n`;
			} catch {
				line = `${JSON.stringify({
					ts: Date.now(),
					level: "ERROR",
					msg: "[unserializable log event]",
				})}\n`;
			}
		}
		if (this.stream) {
			this.stream.write(line);
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
