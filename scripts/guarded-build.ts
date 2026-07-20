#!/usr/bin/env bun
/**
 * guarded-build.ts — CLI wrapper that runs a named build through the
 * content-hash guard in build-guard.ts.
 *
 *   bun run scripts/guarded-build.ts dashboard    # guards build:dashboard
 *   bun run scripts/guarded-build.ts db-workers   # guards build:db-workers
 *
 * These are wired into package.json as `build:dashboard:guarded` /
 * `build:db-workers:guarded` and used by the systemd `ExecStartPre` steps so a
 * restart only pays the full build cost when source or output actually changed.
 *
 * The real build command is the exact root script (`bun run build:dashboard`
 * / `bun run build:db-workers`), invoked with the same bun binary running this
 * script so the guard never silently diverges from an unguarded build.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type BuildTarget, runGuardedBuild } from "./build-guard.ts";

// Repo root is the parent of scripts/.
const REPO_ROOT = join(import.meta.dir, "..");

// The workspace-dep packages whose src/**/*.ts get bundled into the browser
// bundle — kept in sync with packages/dashboard-web/package.json `dependencies`
// `workspace:*` entries. Their source must be part of the dashboard hash input.
const DASHBOARD_WORKSPACE_DEPS = [
	"core",
	"errors",
	"http-common",
	"types",
	"ui-common",
	"ui-constants",
];

// The empty-placeholder shape build-workers.ts writes before it fills each
// inline file. A file matching this is present but NOT actually built.
const EMPTY_WORKER_PLACEHOLDER = /EMBEDDED_\w+_CODE\s*=\s*"";/;

const DB_WORKER_INLINE_FILES = [
	"packages/database/src/inline-vacuum-worker.ts",
	"packages/database/src/inline-integrity-check-worker.ts",
	"packages/database/src/inline-incremental-vacuum-worker.ts",
];

export function buildTargets(repoRoot: string): BuildTarget[] {
	const dashboardConfigGlobs = [
		"build.ts",
		"embed.ts",
		"package.json",
		"bunfig.toml",
		"components.json",
		"tsconfig.json",
	].map((f) => `packages/dashboard-web/${f}`);

	const workspaceDepGlobs = DASHBOARD_WORKSPACE_DEPS.flatMap((dep) => [
		// Bare `src/**/*` (not `*.ts`) so `.tsx` components and any other bundled
		// source file are hashed — a `.ts`-only glob would miss e.g.
		// packages/ui-common/src/components/*.tsx, which IS bundled into the
		// dashboard, and silently serve a stale bundle after an edit. Matches the
		// dashboard's own `src/**/*` input glob. Over-hashing (dep test files
		// etc.) only ever forces a safe extra rebuild, never staleness.
		`packages/${dep}/src/**/*`,
		`packages/${dep}/package.json`,
	]);

	const dashboard: BuildTarget = {
		name: "dashboard",
		cwd: repoRoot,
		markerPath: ".cache/build-guard/dashboard.json",
		inputGlobs: [
			"packages/dashboard-web/src/**/*",
			"packages/dashboard-web/styles/**/*",
			...dashboardConfigGlobs,
			...workspaceDepGlobs,
			"bun.lock",
		],
		outputGlobs: ["packages/dashboard-web/dist/embedded.ts"],
		checkOutput: async (cwd: string) => {
			const f = Bun.file(join(cwd, "packages/dashboard-web/dist/embedded.ts"));
			return (await f.exists()) && f.size > 0;
		},
		buildCommand: [process.execPath, "run", "build:dashboard"],
	};

	const dbWorkers: BuildTarget = {
		name: "db-workers",
		cwd: repoRoot,
		markerPath: ".cache/build-guard/db-workers.json",
		inputGlobs: [
			"packages/database/src/**/*.ts",
			"!packages/database/src/inline-*.ts",
			"packages/database/scripts/build-workers.ts",
			"packages/database/package.json",
		],
		outputGlobs: DB_WORKER_INLINE_FILES,
		checkOutput: async (cwd: string) => {
			for (const rel of DB_WORKER_INLINE_FILES) {
				const abs = join(cwd, rel);
				if (!existsSync(abs)) return false;
				const contents = readFileSync(abs, "utf8");
				if (EMPTY_WORKER_PLACEHOLDER.test(contents)) return false;
			}
			return true;
		},
		buildCommand: [process.execPath, "run", "build:db-workers"],
	};

	return [dashboard, dbWorkers];
}

if (import.meta.main) {
	const name = process.argv[2];
	const target = buildTargets(REPO_ROOT).find((t) => t.name === name);
	if (!target) {
		console.error(
			`[build-guard] unknown target ${JSON.stringify(name)}; expected "dashboard" or "db-workers"`,
		);
		process.exit(2);
	}
	await runGuardedBuild(target);
}
