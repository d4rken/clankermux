import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
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
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
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
