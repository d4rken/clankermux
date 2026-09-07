import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every quota run-out the dashboard renders is a linear extrapolation of the
 * current burn, so its copy has to say what it is conditional on. Unit tests
 * pin the strings the known code paths produce; this one pins the ABSENCE of
 * any other, so a newly added projection line cannot reintroduce a bare
 * "Runs out …" that reads as a statement of fact.
 *
 * Rooted at the dashboard's own `src/` rather than the process cwd, so the scan
 * covers the same files whichever directory `bun test` was started from.
 */
const SRC_ROOT = join(import.meta.dir, "..");
const SOURCE_GLOB = "**/*.{ts,tsx}";
const TEST_FILE = /\.(test|dom-test)\.tsx?$/;

/**
 * String and template literals that OPEN with "Runs out " — the shape a
 * projection line takes. A trailing space is required, so prose mentioning
 * `"Runs out"` in a comment is not a match.
 */
const RUN_OUT_LITERAL = /["'`]Runs out [^\n]*/g;

/**
 * The single legitimate exception: the runway chip on the Limits page, whose
 * label carries the qualifier itself because it has no room for a sentence.
 */
const CHIP_LABEL = '"Runs out at this pace"';

it("leaves no unqualified run-out projection in the dashboard sources", () => {
	const offenders: string[] = [];
	for (const relativePath of new Bun.Glob(SOURCE_GLOB).scanSync({
		cwd: SRC_ROOT,
	})) {
		if (TEST_FILE.test(relativePath)) continue;
		const source = readFileSync(join(SRC_ROOT, relativePath), "utf8");
		for (const match of source.matchAll(RUN_OUT_LITERAL)) {
			if (match[0].startsWith(CHIP_LABEL)) continue;
			offenders.push(`${relativePath}: ${match[0].slice(0, 60)}`);
		}
	}
	expect(offenders).toEqual([]);
});

it("scans a non-empty set of dashboard sources", () => {
	// Guards the assertion above against a glob that silently matches nothing,
	// which would make it pass without reading a single file.
	let scanned = 0;
	for (const relativePath of new Bun.Glob(SOURCE_GLOB).scanSync({
		cwd: SRC_ROOT,
	})) {
		if (!TEST_FILE.test(relativePath)) scanned += 1;
	}
	expect(scanned).toBeGreaterThan(50);
});
