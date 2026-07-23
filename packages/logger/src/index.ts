import { EventEmitter } from "node:events";
// Deep-import the leaf env module, NOT the @clankermux/core barrel: the barrel
// re-exports modules (interval-manager, model-mappings) that construct a Logger
// at import time, which would re-enter this module mid-evaluation and TDZ-crash
// depending on test-file discovery order. See src/__guards__/*.test.ts.
import { isDebugEnabled } from "@clankermux/core/env";
import type { LogEvent } from "@clankermux/types";
import { logFileWriter } from "./file-writer";
import { safeReason } from "./serialize";

export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
}

export type LogFormat = "pretty" | "json";

// Event emitter for log streaming
export const logBus = new EventEmitter();

// Error's name/message/stack are non-enumerable, so JSON.stringify(err) returns "{}".
// Convert Errors to plain objects before they flow into formatMessage / LogEvent /
// the file writer, which all use JSON.stringify downstream.
//
// The Error.cause chain is walked recursively but cycle-guarded: a
// self-referential cause (`err.cause = err`) would otherwise overflow the stack
// here — before the payload ever reaches the JSON.stringify serialization guard
// downstream. `seen` tracks Errors already visited on this chain.
// biome-ignore lint/suspicious/noExplicitAny: payload is intentionally untyped
function normalizeLogData(data: any, seen?: WeakSet<object>): any {
	if (data === undefined || data === null) return data;
	if (data instanceof Error) {
		const visited = seen ?? new WeakSet<object>();
		if (visited.has(data)) {
			return {
				name: data.name,
				message: data.message,
				stack: data.stack,
				cause: "[circular error cause]",
			};
		}
		visited.add(data);
		const out: Record<string, unknown> = {
			name: data.name,
			message: data.message,
			stack: data.stack,
		};
		if (data.cause !== undefined) {
			out.cause =
				data.cause instanceof Error
					? normalizeLogData(data.cause, visited)
					: data.cause;
		}
		return out;
	}
	return data;
}

export class Logger {
	private level: LogLevel;
	private prefix: string;
	private format: LogFormat;
	private silentConsole: boolean;

	constructor(prefix: string = "", level: LogLevel = LogLevel.INFO) {
		this.prefix = prefix;
		this.level = this.getLogLevelFromEnv() ?? level;
		this.format = this.getFormatFromEnv();
		// Only show console output in debug mode or if CLANKERMUX_DEBUG (or legacy BETTER_CCFLARE_DEBUG/ccflare_DEBUG) is set
		this.silentConsole = !(isDebugEnabled() || this.level === LogLevel.DEBUG);
	}

	private getLogLevelFromEnv(): LogLevel | null {
		// Check if we're in a Node.js environment
		if (typeof process === "undefined" || !process.env) {
			return null;
		}
		const envLevel = process.env.LOG_LEVEL?.toUpperCase();
		if (envLevel && envLevel in LogLevel) {
			return LogLevel[envLevel as keyof typeof LogLevel];
		}
		return null;
	}

	private getFormatFromEnv(): LogFormat {
		// Check if we're in a Node.js environment
		if (typeof process === "undefined" || !process.env) {
			return "pretty";
		}
		return (process.env.LOG_FORMAT as LogFormat) || "pretty";
	}

	// biome-ignore lint/suspicious/noExplicitAny: Logger needs to accept any data type
	private formatMessage(level: string, message: string, data?: any): string {
		const timestamp = new Date().toISOString();

		if (this.format === "json") {
			const logEntry = {
				ts: timestamp,
				level,
				prefix: this.prefix || undefined,
				msg: message,
				...(data && { data }),
			};
			// Guard against unserializable `data` (circular/BigInt/throwing toJSON)
			// crashing the caller. Happy path is byte-identical; on failure the
			// envelope is rebuilt preserving ts/level/prefix/msg — only `data` is
			// replaced with a marker. The envelope fields are always plain strings,
			// so the fallback stringify cannot itself throw.
			try {
				return JSON.stringify(logEntry);
			} catch (e: unknown) {
				return JSON.stringify({
					ts: timestamp,
					level,
					prefix: this.prefix || undefined,
					msg: message,
					data: `[unserializable: ${safeReason(e)}]`,
				});
			}
		} else {
			const prefix = this.prefix ? `[${this.prefix}] ` : "";
			let dataStr = "";
			if (data) {
				try {
					dataStr = ` ${JSON.stringify(data)}`;
				} catch (e: unknown) {
					dataStr = ` [unserializable: ${safeReason(e)}]`;
				}
			}
			return `[${timestamp}] ${level}: ${prefix}${message}${dataStr}`;
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: Logger needs to accept any data type
	debug(message: string, data?: any): void {
		if (this.level <= LogLevel.DEBUG) {
			const normalized = normalizeLogData(data);
			const msg = this.formatMessage("DEBUG", message, normalized);
			const event: LogEvent = {
				ts: Date.now(),
				level: "DEBUG",
				msg: message,
				...(normalized !== undefined && { data: normalized }),
			};
			logBus.emit("log", event);
			logFileWriter?.write(event);
			if (!this.silentConsole) console.log(msg);
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: Logger needs to accept any data type
	info(message: string, data?: any): void {
		if (this.level <= LogLevel.INFO) {
			const normalized = normalizeLogData(data);
			const msg = this.formatMessage("INFO", message, normalized);
			const event: LogEvent = {
				ts: Date.now(),
				level: "INFO",
				msg: message,
				...(normalized !== undefined && { data: normalized }),
			};
			logBus.emit("log", event);
			logFileWriter?.write(event);
			if (!this.silentConsole) console.log(msg);
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: Logger needs to accept any data type
	warn(message: string, data?: any): void {
		if (this.level <= LogLevel.WARN) {
			const normalized = normalizeLogData(data);
			const msg = this.formatMessage("WARN", message, normalized);
			const event: LogEvent = {
				ts: Date.now(),
				level: "WARN",
				msg: message,
				...(normalized !== undefined && { data: normalized }),
			};
			logBus.emit("log", event);
			logFileWriter?.write(event);
			if (!this.silentConsole) console.warn(msg);
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: Logger needs to accept any error type
	error(message: string, error?: any): void {
		if (this.level <= LogLevel.ERROR) {
			const normalized = normalizeLogData(error);
			const msg = this.formatMessage("ERROR", message, normalized);
			const event: LogEvent = {
				ts: Date.now(),
				level: "ERROR",
				msg: message,
				...(normalized !== undefined && { data: normalized }),
			};
			logBus.emit("log", event);
			logFileWriter?.write(event);
			if (!this.silentConsole) console.error(msg);
		}
	}

	setLevel(level: LogLevel): void {
		this.level = level;
		// Update silentConsole when level changes
		this.silentConsole = !(isDebugEnabled() || this.level === LogLevel.DEBUG);
	}

	getLevel(): LogLevel {
		return this.level;
	}
}

// Default logger instance
export const log = new Logger();
export { logFileWriter } from "./file-writer";
export { safeReason, safeStringifyLogEvent } from "./serialize";
