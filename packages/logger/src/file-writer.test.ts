import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEvent } from "@clankermux/types";
import { LogFileWriter } from "./file-writer";

// Poll the log file until it has at least `min` non-empty lines, then return the
// last one. createWriteStream buffers writes asynchronously, so a bare
// readFileSync immediately after write() can race the flush.
async function readLastLine(logFile: string, min = 1): Promise<string> {
	for (let i = 0; i < 50; i++) {
		if (existsSync(logFile)) {
			const lines = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean);
			if (lines.length >= min) return lines[lines.length - 1];
		}
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("log line never appeared");
}

describe("LogFileWriter unserializable-payload guard", () => {
	let dir: string;
	let savedLogDir: string | undefined;

	// readEnv resolves LOG_DIR across the CLANKERMUX_/BETTER_CCFLARE_/ccflare_
	// prefixes (no bare fallback), so the writer only honors the prefixed var.
	beforeEach(() => {
		savedLogDir = process.env.CLANKERMUX_LOG_DIR;
		dir = mkdtempSync(join(tmpdir(), "clankermux-logtest-"));
		process.env.CLANKERMUX_LOG_DIR = dir;
	});

	afterEach(() => {
		if (savedLogDir === undefined) delete process.env.CLANKERMUX_LOG_DIR;
		else process.env.CLANKERMUX_LOG_DIR = savedLogDir;
		rmSync(dir, { recursive: true, force: true });
	});

	it("does not throw and writes a marker for a circular payload", async () => {
		const writer = new LogFileWriter();
		// biome-ignore lint/suspicious/noExplicitAny: cyclic test payload
		const data: any = { a: 1 };
		data.self = data;
		const event: LogEvent = { ts: 111, level: "ERROR", msg: "cyclic", data };

		expect(() => writer.write(event)).not.toThrow();

		const line = await readLastLine(join(dir, "app.log"));
		const parsed = JSON.parse(line) as LogEvent;
		expect(parsed.ts).toBe(111);
		expect(parsed.level).toBe("ERROR");
		expect(parsed.msg).toBe("cyclic");
		expect(String(parsed.data)).toContain("[unserializable:");
		writer.close();
	});

	it("does not throw and writes a marker for a BigInt payload", async () => {
		const writer = new LogFileWriter();
		const event: LogEvent = {
			ts: 222,
			level: "WARN",
			msg: "bigint",
			data: { n: 5n },
		};

		expect(() => writer.write(event)).not.toThrow();

		const line = await readLastLine(join(dir, "app.log"));
		const parsed = JSON.parse(line) as LogEvent;
		expect(parsed.msg).toBe("bigint");
		expect(String(parsed.data)).toContain("[unserializable:");
		writer.close();
	});

	it("writes a normal event byte-identically to a raw stringify", async () => {
		const writer = new LogFileWriter();
		const event: LogEvent = {
			ts: 333,
			level: "INFO",
			msg: "ok",
			data: { foo: "bar" },
		};

		writer.write(event);

		const line = await readLastLine(join(dir, "app.log"));
		expect(line).toBe(JSON.stringify(event));
		writer.close();
	});
});
