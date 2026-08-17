import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Regression guard for the logger<->core import cycle (TDZ crash:
// "Cannot access 'Logger' before initialization" at interval-manager.ts).
//
// The @clankermux/core BARREL re-exports modules that construct a Logger at
// import time (interval-manager, model-mappings). If any logger production
// source imports the bare barrel, evaluating the logger re-enters those modules
// mid-evaluation and TDZ-crashes depending on test-file discovery order. The
// logger must only deep-import the leaf "@clankermux/core/env".

const LOGGER_SRC = join(import.meta.dir, "..");

function collectSourceFiles(dir: string): string[] {
	const out: string[] = [];
	// `withFileTypes` gets the entry kind straight from the directory read, so
	// the walk needs no per-entry statSync. That's one syscall instead of two,
	// and it keeps the traversal independent of `node:fs` exports that another
	// test file may have replaced via the process-global `mock.module`.
	for (const dirent of readdirSync(dir, { withFileTypes: true })) {
		const entry = dirent.name;
		const full = join(dir, entry);
		if (dirent.isDirectory()) {
			out.push(...collectSourceFiles(full));
			continue;
		}
		if (!entry.endsWith(".ts")) continue;
		// Skip test files: they may import anything, and skipping also stops this
		// guard from matching the specifier literal in its own source.
		if (entry.endsWith(".test.ts")) continue;
		out.push(full);
	}
	return out;
}

describe("logger import hygiene", () => {
	it("never imports the bare @clankermux/core barrel (only the leaf subpath)", () => {
		// Anchored to the exact specifier: the closing quote immediately follows
		// "core", so "@clankermux/core/env" is explicitly allowed.
		const barrelImport = /from\s+["']@clankermux\/core["']/;
		const offenders = collectSourceFiles(LOGGER_SRC).filter((file) =>
			barrelImport.test(readFileSync(file, "utf8")),
		);
		expect(offenders).toEqual([]);
	});
});
