#!/usr/bin/env bun
/**
 * test-dom.ts — runs the DOM test lane.
 *
 *   bun run scripts/test-dom.ts     # wired into package.json as `test:dom`
 *
 * The lane is every `*.dom-test.{ts,tsx}` under the dashboard package. Those
 * names are invisible to `bun test`'s own discovery on purpose: happy-dom's
 * globals are process-wide, so they get installed via `--preload` in this
 * separate process and never leak into the default suite.
 *
 * Discovery is a glob rather than a hardcoded file list so a newly added
 * `*.dom-test.tsx` is picked up without touching this script. It is spawned
 * with the same bun binary running this script (`process.execPath`), matching
 * scripts/guarded-build.ts, so the lane can never diverge from the runtime that
 * invoked it.
 */

// Scanned from the process cwd, which is the repo root when run through the
// package.json script.
const DOM_TEST_GLOB = "packages/dashboard-web/src/**/*.dom-test.{ts,tsx}";
const HAPPY_DOM_PRELOAD = "./packages/dashboard-web/src/test-utils/happy-dom.ts";

const files: string[] = [];
for await (const file of new Bun.Glob(DOM_TEST_GLOB).scan(process.cwd())) {
	files.push(file);
}
files.sort();

if (files.length === 0) {
	// Load-bearing guard, not a courtesy: `bun test --preload <p>` with no
	// positional paths falls back to bun's default discovery and would run the
	// entire suite with happy-dom's Request/Response/fetch/Headers/
	// AbortController/WebSocket/URL substitutes installed over Bun's natives.
	console.error(
		`[test-dom] no DOM test files matched ${DOM_TEST_GLOB} under ${process.cwd()} — refusing to run bun test without explicit paths (it would fall back to the full suite with happy-dom's globals installed).`,
	);
	process.exit(1);
}

const child = Bun.spawnSync({
	cmd: [
		process.execPath,
		"test",
		"--preload",
		HAPPY_DOM_PRELOAD,
		...files.map((f) => `./${f}`),
	],
	stdio: ["inherit", "inherit", "inherit"],
});

process.exit(child.exitCode ?? 1);
