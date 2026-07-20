import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BuildTarget,
	hashFileSet,
	readMarker,
	runGuardedBuild,
	writeMarker,
} from "./build-guard.ts";
import { buildTargets } from "./guarded-build.ts";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "build-guard-test-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
	const abs = join(root, rel);
	await mkdir(join(abs, ".."), { recursive: true });
	await writeFile(abs, content);
}

describe("hashFileSet", () => {
	it("is stable across re-runs when nothing changes", async () => {
		await write("src/a.ts", "alpha");
		await write("src/b.ts", "beta");
		const first = await hashFileSet(["src/**/*.ts"], root);
		const second = await hashFileSet(["src/**/*.ts"], root);
		expect(first).toBe(second);
	});

	it("changes when a file is edited", async () => {
		await write("src/a.ts", "alpha");
		const before = await hashFileSet(["src/**/*.ts"], root);
		await write("src/a.ts", "alpha-modified");
		const after = await hashFileSet(["src/**/*.ts"], root);
		expect(after).not.toBe(before);
	});

	it("changes when a file is added", async () => {
		await write("src/a.ts", "alpha");
		const before = await hashFileSet(["src/**/*.ts"], root);
		await write("src/b.ts", "beta");
		const after = await hashFileSet(["src/**/*.ts"], root);
		expect(after).not.toBe(before);
	});

	it("changes when a file is removed", async () => {
		await write("src/a.ts", "alpha");
		await write("src/b.ts", "beta");
		const before = await hashFileSet(["src/**/*.ts"], root);
		await rm(join(root, "src/b.ts"));
		const after = await hashFileSet(["src/**/*.ts"], root);
		expect(after).not.toBe(before);
	});

	it("honors negated exclude patterns", async () => {
		await write("src/a.ts", "alpha");
		await write("src/inline-x.ts", "generated");
		const withExclude = await hashFileSet(
			["src/**/*.ts", "!src/inline-*.ts"],
			root,
		);
		// Editing an excluded file must not change the hash.
		await write("src/inline-x.ts", "generated-changed");
		const afterExcludedEdit = await hashFileSet(
			["src/**/*.ts", "!src/inline-*.ts"],
			root,
		);
		expect(afterExcludedEdit).toBe(withExclude);
	});

	it("resolves literal (non-glob) file patterns", async () => {
		await write("package.json", "{}");
		const h = await hashFileSet(["package.json"], root);
		expect(h).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("readMarker / writeMarker", () => {
	it("round-trips source and output hashes", async () => {
		const markerPath = join(root, ".cache/build-guard/x.json");
		await writeMarker(markerPath, "src-hash", "out-hash");
		const marker = readMarker(markerPath);
		expect(marker).not.toBeNull();
		expect(marker?.sourceHash).toBe("src-hash");
		expect(marker?.outputHash).toBe("out-hash");
	});

	it("returns null when the marker is missing", () => {
		expect(readMarker(join(root, "missing.json"))).toBeNull();
	});

	it("returns null when the marker is corrupt", async () => {
		const markerPath = join(root, "corrupt.json");
		await writeFile(markerPath, "{ not valid json");
		expect(readMarker(markerPath)).toBeNull();
	});
});

/**
 * Build a target whose "build command" writes OUT_FILE and increments a counter
 * file, so tests can observe whether the real build actually ran.
 */
function makeTarget(overrides: Partial<BuildTarget> = {}): BuildTarget {
	const outFile = join(root, "out/artifact.ts");
	const counterFile = join(root, "build-count.txt");
	const script = `
		const fs = require("node:fs");
		const path = require("node:path");
		const counter = ${JSON.stringify(counterFile)};
		const out = ${JSON.stringify(outFile)};
		const n = fs.existsSync(counter) ? parseInt(fs.readFileSync(counter, "utf8"), 10) : 0;
		fs.writeFileSync(counter, String(n + 1));
		fs.mkdirSync(path.dirname(out), { recursive: true });
		fs.writeFileSync(out, "built-" + (n + 1));
	`;
	return {
		name: "test",
		cwd: root,
		markerPath: ".cache/build-guard/test.json",
		inputGlobs: ["src/**/*.ts"],
		outputGlobs: ["out/artifact.ts"],
		checkOutput: async (cwd: string) => existsSync(join(cwd, "out/artifact.ts")),
		buildCommand: [process.execPath, "-e", script],
		...overrides,
	};
}

function buildCount(): number {
	const p = join(root, "build-count.txt");
	if (!existsSync(p)) return 0;
	return Number.parseInt(require("node:fs").readFileSync(p, "utf8"), 10);
}

describe("runGuardedBuild", () => {
	it("builds when no marker exists, then skips on a clean re-run", async () => {
		await write("src/a.ts", "alpha");
		const target = makeTarget();

		await runGuardedBuild(target);
		expect(buildCount()).toBe(1);
		expect(existsSync(join(root, ".cache/build-guard/test.json"))).toBe(true);

		// Nothing changed -> second run must skip the real build.
		await runGuardedBuild(target);
		expect(buildCount()).toBe(1);
	});

	it("rebuilds when a source file changes", async () => {
		await write("src/a.ts", "alpha");
		const target = makeTarget();

		await runGuardedBuild(target);
		expect(buildCount()).toBe(1);

		await write("src/a.ts", "alpha-changed");
		await runGuardedBuild(target);
		expect(buildCount()).toBe(2);
	});

	it("rebuilds when the output is missing even if the source hash matches", async () => {
		await write("src/a.ts", "alpha");
		const target = makeTarget();

		await runGuardedBuild(target);
		expect(buildCount()).toBe(1);

		// Delete the artifact but leave the marker and source intact.
		await rm(join(root, "out/artifact.ts"));
		await runGuardedBuild(target);
		expect(buildCount()).toBe(2);
	});

	it("propagates a non-zero build exit and does NOT write the marker", async () => {
		await write("src/a.ts", "alpha");
		const failing = makeTarget({
			buildCommand: [process.execPath, "-e", "process.exit(3)"],
		});

		let exitCode: number | undefined;
		await expect(
			runGuardedBuild(failing, {
				exit: (code) => {
					exitCode = code;
					throw new Error(`exit ${code}`);
				},
			}),
		).rejects.toThrow("exit 3");
		expect(exitCode).toBe(3);
		expect(existsSync(join(root, ".cache/build-guard/test.json"))).toBe(false);
	});
});

describe("dashboard target input globs", () => {
	function dashboardTarget(): BuildTarget {
		return buildTargets(root).find((t) => t.name === "dashboard") as BuildTarget;
	}

	it("hashes .tsx source in a bundled workspace dep (regression: .ts-only glob missed .tsx)", async () => {
		// A .tsx component under a workspace dep that gets bundled into the
		// dashboard. A `packages/<dep>/src/**/*.ts` glob would NOT match this,
		// so editing it would leave the dashboard source hash unchanged and
		// serve a stale bundle.
		await write(
			"packages/ui-common/src/components/TokenUsageDisplay.tsx",
			"export const A = 1;",
		);
		const target = dashboardTarget();
		const before = await hashFileSet(target.inputGlobs, root);

		await write(
			"packages/ui-common/src/components/TokenUsageDisplay.tsx",
			"export const A = 2;",
		);
		const after = await hashFileSet(target.inputGlobs, root);

		expect(after).not.toBe(before);
	});
});

describe("db-workers target output check", () => {
	function dbTarget(): BuildTarget {
		return buildTargets(root).find((t) => t.name === "db-workers") as BuildTarget;
	}

	async function writeInline(name: string, body: string): Promise<void> {
		await write(`packages/database/src/${name}`, body);
	}

	it("treats an empty EMBEDDED placeholder as NOT built", async () => {
		await writeInline(
			"inline-vacuum-worker.ts",
			'export const EMBEDDED_VACUUM_WORKER_CODE = "AAAA";',
		);
		await writeInline(
			"inline-integrity-check-worker.ts",
			'export const EMBEDDED_INTEGRITY_CHECK_WORKER_CODE = "";',
		);
		await writeInline(
			"inline-incremental-vacuum-worker.ts",
			'export const EMBEDDED_INCREMENTAL_VACUUM_WORKER_CODE = "AAAA";',
		);
		expect(await dbTarget().checkOutput(root)).toBe(false);
	});

	it("treats all-three-filled as built", async () => {
		await writeInline(
			"inline-vacuum-worker.ts",
			'export const EMBEDDED_VACUUM_WORKER_CODE = "AAAA";',
		);
		await writeInline(
			"inline-integrity-check-worker.ts",
			'export const EMBEDDED_INTEGRITY_CHECK_WORKER_CODE = "BBBB";',
		);
		await writeInline(
			"inline-incremental-vacuum-worker.ts",
			'export const EMBEDDED_INCREMENTAL_VACUUM_WORKER_CODE = "CCCC";',
		);
		expect(await dbTarget().checkOutput(root)).toBe(true);
	});

	it("treats a missing inline file as NOT built", async () => {
		await writeInline(
			"inline-vacuum-worker.ts",
			'export const EMBEDDED_VACUUM_WORKER_CODE = "AAAA";',
		);
		// two of three present
		await writeInline(
			"inline-integrity-check-worker.ts",
			'export const EMBEDDED_INTEGRITY_CHECK_WORKER_CODE = "BBBB";',
		);
		expect(await dbTarget().checkOutput(root)).toBe(false);
	});
});
