import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	WORKER_INLINE_REPO_PATHS,
	WORKER_SRC_DIR,
	WORKERS,
} from "./workers-manifest.ts";

const REPO_ROOT = join(import.meta.dir, "../../..");

/**
 * A worker missing from the manifest does not fail loudly — it fails as a
 * `Cannot find module './inline-<name>-worker'` at test-collection time, which
 * shows up only as a *smaller* suite. That is how the payload-write worker went
 * unnoticed on main for a week (70 test files silently failed to load).
 *
 * These tests make the omission fail on the commit that introduces it.
 */
describe("DB worker manifest completeness", () => {
	/** Worker sources on disk: `<name>-worker.ts`, excluding generated inline outputs. */
	const sourcesOnDisk = readdirSync(WORKER_SRC_DIR)
		.filter((f) => f.endsWith("-worker.ts") && !f.startsWith("inline-"))
		.sort();

	it("has an entry for every *-worker.ts source in packages/database/src", () => {
		const inManifest = WORKERS.map((w) => w.source).sort();
		expect(inManifest).toEqual(sourcesOnDisk);
	});

	it("points every entry at a source file that exists", () => {
		for (const worker of WORKERS) {
			expect(existsSync(join(WORKER_SRC_DIR, worker.source))).toBe(true);
		}
	});

	it("names each inline output and constant by the shared convention", () => {
		for (const worker of WORKERS) {
			// vacuum-worker.ts → inline-vacuum-worker.ts / vacuum-worker.js
			expect(worker.inline).toBe(`inline-${worker.source}`);
			expect(worker.bundle).toBe(worker.source.replace(/\.ts$/, ".js"));
			// vacuum-worker.ts → EMBEDDED_VACUUM_WORKER_CODE
			const expectedConst = `EMBEDDED_${worker.source
				.replace(/\.ts$/, "")
				.replace(/-/g, "_")
				.toUpperCase()}_CODE`;
			expect(worker.constName).toBe(expectedConst);
		}
	});

	it("has no duplicate entries", () => {
		expect(new Set(WORKERS.map((w) => w.source)).size).toBe(WORKERS.length);
		expect(new Set(WORKERS.map((w) => w.constName)).size).toBe(WORKERS.length);
	});

	it("ships a committed .d.ts stub for every inline output", () => {
		// The .ts inline files are gitignored, so `bun run typecheck` on a clean
		// checkout resolves the imports through these stubs instead.
		for (const worker of WORKERS) {
			const stubPath = join(
				WORKER_SRC_DIR,
				worker.inline.replace(/\.ts$/, ".d.ts"),
			);
			expect(existsSync(stubPath)).toBe(true);
			expect(readFileSync(stubPath, "utf8")).toContain(
				`export declare const ${worker.constName}: string;`,
			);
		}
	});

	it("gitignores every inline output", () => {
		// A real base64 blob must never be committed; each inline path needs its
		// own .gitignore line.
		const gitignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8")
			.split("\n")
			.map((line) => line.trim());
		for (const path of WORKER_INLINE_REPO_PATHS) {
			expect(gitignore).toContain(path);
		}
	});
});
