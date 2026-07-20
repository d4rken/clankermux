#!/usr/bin/env bun
/**
 * build-guard.ts — a generic content-hash "guard" around an expensive build.
 *
 * It lets a build step VERIFY on every invocation (so it still self-heals when
 * source or output drift) but only RE-RUN the real build when the source inputs
 * or the produced artifacts have actually changed. This is used to shrink the
 * systemd restart window: the two `ExecStartPre` build steps go from ~30-90s of
 * unconditional work down to a few seconds of hashing when nothing changed.
 *
 * Design notes:
 *   - Dependency-free: only Bun built-ins (Bun.Glob, Bun.CryptoHasher,
 *     Bun.file, Bun.spawn) plus node:fs/node:path.
 *   - Fail-closed: any doubt (no marker, corrupt marker, missing/stale output,
 *     non-zero build exit) forces the real build to run. A failed build never
 *     writes a marker, so it re-runs next time — preserving the blocking
 *     `ExecStartPre` semantics.
 *   - Hash is over file *content*, not mtime, so touching a file without
 *     changing it does not trigger a rebuild.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export interface BuildTarget {
	/** Short human-readable name used in log lines. */
	name: string;
	/** Working directory the globs, marker, and build command resolve against. */
	cwd: string;
	/**
	 * Marker file location. Relative paths resolve against {@link BuildTarget.cwd}.
	 */
	markerPath: string;
	/**
	 * Glob patterns (relative to cwd) for the build's source inputs. A pattern
	 * prefixed with `!` is an exclude filter applied to matched files.
	 */
	inputGlobs: string[];
	/** Glob patterns (relative to cwd) for the produced artifacts. */
	outputGlobs: string[];
	/**
	 * Extra correctness check for the output that a content hash cannot express
	 * (e.g. "the artifact is a filled bundle, not an empty placeholder"). Returns
	 * false to force a rebuild.
	 */
	checkOutput: (cwd: string) => Promise<boolean>;
	/** The real build command, as an argv array passed to Bun.spawn. */
	buildCommand: string[];
}

export interface BuildMarker {
	sourceHash: string;
	outputHash: string;
}

export interface RunGuardedBuildOptions {
	/**
	 * Called when the real build exits non-zero. Defaults to `process.exit`.
	 * Overridable so tests can assert propagation without killing the runner.
	 */
	exit?: (code: number) => never;
}

/**
 * Compute a single sha256 digest over a set of files.
 *
 * Each include glob is resolved with Bun.Glob; `!`-prefixed patterns are treated
 * as exclude globs and drop any matched relative path. The resulting relative
 * paths are sorted, and for each we fold `relPath + "\0" + sha256(bytes) + "\n"`
 * into one outer sha256. This makes the digest sensitive to file
 * add/remove/edit and stable across re-runs with no changes.
 */
export async function hashFileSet(
	patterns: string[],
	cwd: string,
): Promise<string> {
	const includes = patterns.filter((p) => !p.startsWith("!"));
	const excludeGlobs = patterns
		.filter((p) => p.startsWith("!"))
		.map((p) => new Bun.Glob(p.slice(1)));

	const files = new Set<string>();
	for (const pattern of includes) {
		const glob = new Bun.Glob(pattern);
		for await (const rel of glob.scan({ cwd, onlyFiles: true, dot: false })) {
			if (excludeGlobs.some((g) => g.match(rel))) continue;
			files.add(rel);
		}
	}

	const sorted = [...files].sort();
	const outer = new Bun.CryptoHasher("sha256");
	for (const rel of sorted) {
		const bytes = await Bun.file(join(cwd, rel)).arrayBuffer();
		const inner = new Bun.CryptoHasher("sha256");
		inner.update(bytes);
		const fileHash = inner.digest("hex");
		outer.update(`${rel}\0${fileHash}\n`);
	}
	return outer.digest("hex");
}

/**
 * Read a build marker. Returns null on missing or corrupt markers (fail toward
 * "must rebuild").
 */
export function readMarker(markerPath: string): BuildMarker | null {
	if (!existsSync(markerPath)) return null;
	try {
		const parsed = JSON.parse(readFileSync(markerPath, "utf8"));
		if (
			parsed &&
			typeof parsed.sourceHash === "string" &&
			typeof parsed.outputHash === "string"
		) {
			return { sourceHash: parsed.sourceHash, outputHash: parsed.outputHash };
		}
		return null;
	} catch {
		return null;
	}
}

/** Write a build marker, creating parent directories as needed. */
export function writeMarker(
	markerPath: string,
	sourceHash: string,
	outputHash: string,
): void {
	mkdirSync(dirname(markerPath), { recursive: true });
	writeFileSync(
		markerPath,
		`${JSON.stringify(
			{ sourceHash, outputHash, builtAt: new Date().toISOString() },
			null,
			2,
		)}\n`,
	);
}

function log(message: string): void {
	console.log(`[build-guard] ${message}`);
}

/**
 * Verify-then-maybe-build orchestration for a single {@link BuildTarget}.
 *
 * Skips the real build only when a marker exists, the output passes its
 * correctness check, and both the source and output hashes match the marker.
 * Otherwise it runs the real build; a non-zero exit propagates via
 * `opts.exit` (default `process.exit`) WITHOUT writing a marker.
 */
export async function runGuardedBuild(
	target: BuildTarget,
	opts: RunGuardedBuildOptions = {},
): Promise<void> {
	const exit = opts.exit ?? ((code: number) => process.exit(code));
	const markerPath = isAbsolute(target.markerPath)
		? target.markerPath
		: join(target.cwd, target.markerPath);

	const sourceHash = await hashFileSet(target.inputGlobs, target.cwd);
	const marker = readMarker(markerPath);
	const outputOk = await target.checkOutput(target.cwd);
	const outputHash = outputOk
		? await hashFileSet(target.outputGlobs, target.cwd)
		: null;

	if (
		marker &&
		outputOk &&
		marker.sourceHash === sourceHash &&
		marker.outputHash === outputHash
	) {
		log(`${target.name}: source+output unchanged, skipping build`);
		return;
	}

	let reason: string;
	if (!marker) reason = "no marker";
	else if (!outputOk) reason = "output missing or stale";
	else if (marker.sourceHash !== sourceHash) reason = "source changed";
	else reason = "output changed";
	log(`${target.name}: ${reason}, running build`);

	const proc = Bun.spawn(target.buildCommand, {
		stdio: ["ignore", "inherit", "inherit"],
		cwd: target.cwd,
	});
	const code = await proc.exited;
	if (code !== 0) {
		// Fail-closed: do not write a marker, so the next restart rebuilds.
		log(`${target.name}: build failed (exit ${code})`);
		exit(code);
		return;
	}

	// Recompute the output hash from the just-built artifacts.
	const builtOutputHash = await hashFileSet(target.outputGlobs, target.cwd);
	writeMarker(markerPath, sourceHash, builtOutputHash);
	log(`${target.name}: build complete, marker updated`);
}
