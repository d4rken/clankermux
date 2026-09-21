import { describe, expect, it } from "bun:test";
import { join } from "node:path";

/**
 * Spawner for `dispatch-retry-after.guard.ts`. A fresh process is the only
 * place the real `../dispatch` module is reachable: this suite installs a
 * process-wide module stub for it, so an in-process test of the dispatcher
 * would assert against that stub instead of the code under test.
 */

// packages/proxy/src/__tests__ -> repo root is four directories up.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
// `./`-prefixed: bun reads a bare argument as a name filter, and this file is
// named so that no filter and no default discovery can reach it.
const GUARD = "./packages/proxy/src/__tests__/dispatch-retry-after.guard.ts";

describe("dispatcher give-up pacing (fresh process)", () => {
	it("passes its guard suite", () => {
		const proc = Bun.spawnSync([process.execPath, "test", GUARD], {
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = proc.stdout.toString() + proc.stderr.toString();
		// A run that registers nothing also exits 0, so the count is asserted.
		expect(output).toContain("2 pass");
		expect(output).not.toContain("(fail)");
		expect(proc.exitCode).toBe(0);
	});
});
