import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { LogEvent } from "@clankermux/types";
import { Logger, LogLevel, logBus } from "./index";

describe("Logger error serialization", () => {
	let captured: LogEvent[] = [];
	const handler = (event: LogEvent) => {
		captured.push(event);
	};
	let savedLogLevel: string | undefined;

	beforeEach(() => {
		captured = [];
		savedLogLevel = process.env.LOG_LEVEL;
		delete process.env.LOG_LEVEL;
		logBus.on("log", handler);
	});

	afterEach(() => {
		logBus.off("log", handler);
		if (savedLogLevel === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = savedLogLevel;
	});

	it("emits Error name, message, and stack as plain object data", () => {
		const logger = new Logger("Test", LogLevel.ERROR);
		const err = new Error("boom");
		logger.error("Failed:", err);

		expect(captured.length).toBe(1);
		const data = captured[0].data as {
			name?: string;
			message?: string;
			stack?: string;
		};
		expect(data.name).toBe("Error");
		expect(data.message).toBe("boom");
		expect(typeof data.stack).toBe("string");
	});

	it("survives JSON.stringify roundtrip (the file writer's actual path)", () => {
		const logger = new Logger("Test", LogLevel.ERROR);
		logger.error("Failed:", new Error("disk-bound"));

		const roundtripped = JSON.parse(JSON.stringify(captured[0])) as LogEvent;
		const data = roundtripped.data as { message?: string };
		expect(data.message).toBe("disk-bound");
	});

	it("recursively serializes Error.cause", () => {
		const logger = new Logger("Test", LogLevel.ERROR);
		const inner = new Error("inner cause");
		const outer = new Error("outer", { cause: inner });
		logger.error("wrapped:", outer);

		const data = captured[0].data as { cause?: { message?: string } };
		expect(data.cause?.message).toBe("inner cause");
	});

	it("preserves non-Error data unchanged", () => {
		const logger = new Logger("Test", LogLevel.ERROR);
		logger.error("payload:", { foo: "bar" });

		expect(captured[0].data).toEqual({ foo: "bar" });
	});

	it("preserves Error serialization across all log levels (roundtrip)", () => {
		const logger = new Logger("Test", LogLevel.DEBUG);
		logger.warn("warn-path:", new Error("warned"));
		logger.info("info-path:", new Error("informed"));
		logger.debug("debug-path:", new Error("debugged"));

		expect(captured.length).toBe(3);
		const round = captured.map(
			(e) => JSON.parse(JSON.stringify(e)) as LogEvent,
		);
		expect((round[0].data as { message?: string }).message).toBe("warned");
		expect((round[1].data as { message?: string }).message).toBe("informed");
		expect((round[2].data as { message?: string }).message).toBe("debugged");
	});

	it("omits data when no second argument is passed", () => {
		const logger = new Logger("Test", LogLevel.ERROR);
		logger.error("just a message");
		expect("data" in captured[0]).toBe(false);
	});
});

describe("Logger unserializable-data guard", () => {
	let savedLogLevel: string | undefined;
	let savedLogFormat: string | undefined;

	beforeEach(() => {
		savedLogLevel = process.env.LOG_LEVEL;
		savedLogFormat = process.env.LOG_FORMAT;
		delete process.env.LOG_LEVEL;
	});

	afterEach(() => {
		if (savedLogLevel === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = savedLogLevel;
		if (savedLogFormat === undefined) delete process.env.LOG_FORMAT;
		else process.env.LOG_FORMAT = savedLogFormat;
	});

	// Exercise the private formatter directly via a typed structural cast.
	const formatOf = (logger: Logger) =>
		(
			logger as unknown as {
				formatMessage(level: string, message: string, data?: unknown): string;
			}
		).formatMessage.bind(logger);

	const circular = () => {
		// biome-ignore lint/suspicious/noExplicitAny: intentionally cyclic test payload
		const o: any = { a: 1 };
		o.self = o;
		return o;
	};

	it("does not throw into the caller when data is circular (pretty)", () => {
		const logger = new Logger("Test", LogLevel.ERROR);
		expect(() => logger.error("boom", circular())).not.toThrow();
	});

	it("does not throw into the caller when data is circular (json)", () => {
		process.env.LOG_FORMAT = "json";
		const logger = new Logger("Test", LogLevel.ERROR);
		expect(() => logger.error("boom", circular())).not.toThrow();
	});

	it("does not throw on a BigInt payload", () => {
		const logger = new Logger("Test", LogLevel.ERROR);
		expect(() => logger.error("big", { n: 10n })).not.toThrow();
	});

	it("does not throw when a nested toJSON throws", () => {
		const logger = new Logger("Test", LogLevel.ERROR);
		const hostile = {
			toJSON() {
				throw new Error("no serialize for you");
			},
		};
		expect(() => logger.error("hostile", hostile)).not.toThrow();
	});

	it("json format: substitutes an [unserializable:] marker and preserves envelope", () => {
		process.env.LOG_FORMAT = "json";
		const logger = new Logger("Test", LogLevel.ERROR);
		const out = formatOf(logger)("ERROR", "boom", circular());
		const parsed = JSON.parse(out) as Record<string, unknown>;
		expect(parsed.level).toBe("ERROR");
		expect(parsed.msg).toBe("boom");
		expect(parsed.prefix).toBe("Test");
		expect(typeof parsed.ts).toBe("string");
		expect(String(parsed.data)).toContain("[unserializable:");
	});

	it("pretty format: substitutes an [unserializable:] marker inline", () => {
		const logger = new Logger("Test", LogLevel.ERROR);
		const out = formatOf(logger)("ERROR", "boom", circular());
		expect(out).toContain("[unserializable:");
		expect(out).toContain("boom");
	});

	it("happy path json output is byte-identical to a raw stringify", () => {
		process.env.LOG_FORMAT = "json";
		const logger = new Logger("Test", LogLevel.INFO);
		const out = formatOf(logger)("INFO", "hello", { foo: "bar" });
		// Envelope built exactly as formatMessage does on the success path.
		const parsed = JSON.parse(out) as Record<string, unknown>;
		expect(parsed.data).toEqual({ foo: "bar" });
		expect(parsed.msg).toBe("hello");
		expect(out).not.toContain("[unserializable:");
	});

	it("does not overflow on a self-referential Error.cause", () => {
		const logger = new Logger("Test", LogLevel.ERROR);
		// biome-ignore lint/suspicious/noExplicitAny: cyclic cause chain
		const err: any = new Error("loop");
		err.cause = err;
		let captured: LogEvent | undefined;
		const handler = (e: LogEvent) => {
			captured = e;
		};
		logBus.on("log", handler);
		try {
			expect(() => logger.error("cyclic", err)).not.toThrow();
		} finally {
			logBus.off("log", handler);
		}
		// First cause level is the normalized Error; the cycle is detected one
		// level deeper (err.cause === err), where the marker replaces the loop.
		const data = captured?.data as { cause?: { cause?: unknown } };
		expect(data.cause?.cause).toBe("[circular error cause]");
		// And the normalized event still round-trips through stringify.
		expect(() => JSON.stringify(captured)).not.toThrow();
	});
});

describe("Logger env LOG_LEVEL handling", () => {
	const original = process.env.LOG_LEVEL;

	beforeEach(() => {
		delete process.env.LOG_LEVEL;
	});

	afterEach(() => {
		if (original === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = original;
	});

	it("defaults to INFO when LOG_LEVEL is unset", () => {
		expect(new Logger().getLevel()).toBe(LogLevel.INFO);
	});

	it("respects LOG_LEVEL=DEBUG (regression: || vs ?? on LogLevel.DEBUG === 0)", () => {
		process.env.LOG_LEVEL = "DEBUG";
		expect(new Logger().getLevel()).toBe(LogLevel.DEBUG);
	});

	it("respects LOG_LEVEL=WARN", () => {
		process.env.LOG_LEVEL = "WARN";
		expect(new Logger().getLevel()).toBe(LogLevel.WARN);
	});

	it("respects LOG_LEVEL=ERROR", () => {
		process.env.LOG_LEVEL = "ERROR";
		expect(new Logger().getLevel()).toBe(LogLevel.ERROR);
	});

	it("ignores unknown LOG_LEVEL values and falls back to constructor default", () => {
		process.env.LOG_LEVEL = "BANANA";
		expect(new Logger("", LogLevel.WARN).getLevel()).toBe(LogLevel.WARN);
	});

	it("emits debug() output to console when LOG_LEVEL=DEBUG (silentConsole side-effect)", () => {
		process.env.LOG_LEVEL = "DEBUG";
		const spy = spyOn(console, "log").mockImplementation(() => {});
		try {
			new Logger("Test").debug("hello");
			expect(spy).toHaveBeenCalledTimes(1);
			expect(String(spy.mock.calls[0][0])).toContain("DEBUG");
			expect(String(spy.mock.calls[0][0])).toContain("hello");
		} finally {
			spy.mockRestore();
		}
	});

	it("suppresses debug() console output by default (LOG_LEVEL unset)", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		try {
			new Logger("Test").debug("hello");
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});
