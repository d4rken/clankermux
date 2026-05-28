import { describe, expect, it } from "bun:test";
import { join } from "node:path";

// Behavioral regression guard for the logger<->core import cycle.
//
// A fresh process gives a clean module graph, so this deterministically
// exercises the crashing order: import @clankermux/logger FIRST (before core).
// With the cycle present, evaluating the logger re-enters interval-manager,
// which runs `new Logger()` while Logger is in its TDZ; the import() promise
// rejects and the child exits nonzero. With the leaf-import fix it exits 0.
// This catches what the in-process module cache hides in the main test run.

// packages/logger/src/__guards__ -> repo root is four directories up.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

describe("logger<->core import order", () => {
	it("imports @clankermux/logger first without a TDZ crash (fresh process)", () => {
		const script = [
			'import("@clankermux/logger")',
			'  .then((m) => { new m.Logger("cycle-guard"); return import("@clankermux/core"); })',
			"  .then(() => process.exit(0))",
			"  .catch((e) => { console.error(String(e)); process.exit(1); });",
		].join("\n");
		const proc = Bun.spawnSync(["bun", "-e", script], {
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = proc.stderr.toString();
		expect(stderr).not.toContain("before initialization");
		expect(proc.exitCode).toBe(0);
	});
});
