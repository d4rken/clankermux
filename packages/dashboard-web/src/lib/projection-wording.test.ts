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
 * The phrases a projection line is built from, in either case and whether they
 * sit in a string literal or in raw JSX text: "runs out …", "no run-out
 * within …", "on track to reset …", "hits the cap …". Each must be preceded on
 * its line by the qualifier, "at this pace, " (any case), or it reads as a
 * statement of fact.
 */
const PROJECTION_PHRASE =
	/\b(runs out |no run-out within |on track to reset |hits the cap )/i;
const QUALIFIED =
	/at this pace, [^\n]*\b(runs out |no run-out within |on track to reset |hits the cap )/i;

/** A comment line: prose about projections, not a projection. */
const COMMENT_LINE = /^\s*(\/\/|\/?\*)/;

/**
 * The single legitimate exception: the runway chip on the Limits page, whose
 * label carries the qualifier AFTER the phrase because it has no room for a
 * sentence.
 */
const CHIP_LABEL = /"Runs out at this pace"/;

/**
 * Explanatory prose that mentions running out without projecting anything:
 * the credit tooltip's "when the weekly window runs out". Listed verbatim so a
 * new sentence cannot hide behind the exemption.
 */
const PROSE_EXEMPT = [/when the weekly window runs out/];

it("leaves no unqualified run-out projection in the dashboard sources", () => {
	const offenders: string[] = [];
	for (const relativePath of new Bun.Glob(SOURCE_GLOB).scanSync({
		cwd: SRC_ROOT,
	})) {
		if (TEST_FILE.test(relativePath)) continue;
		const source = readFileSync(join(SRC_ROOT, relativePath), "utf8");
		source.split("\n").forEach((line, index) => {
			if (COMMENT_LINE.test(line)) return;
			if (!PROJECTION_PHRASE.test(line)) return;
			if (QUALIFIED.test(line)) return;
			if (CHIP_LABEL.test(line)) return;
			if (PROSE_EXEMPT.some((prose) => prose.test(line))) return;
			offenders.push(
				`${relativePath}:${index + 1}: ${line.trim().slice(0, 70)}`,
			);
		});
	}
	expect(offenders).toEqual([]);
});

it("would flag an unqualified projection in raw JSX text", () => {
	// The pool detail's at-risk line is JSX text, not a string literal; the
	// scan has to see it, or the line could lose its qualifier unnoticed.
	const line = '\t\t\t\t\t\t\t\t\truns out in{" "}';
	expect(PROJECTION_PHRASE.test(line)).toBe(true);
	expect(QUALIFIED.test(line)).toBe(false);
	expect(QUALIFIED.test(`at this pace, ${line.trim()}`)).toBe(true);
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
