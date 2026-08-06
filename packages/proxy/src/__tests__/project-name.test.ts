import { describe, expect, it } from "bun:test";
import {
	exceedsProjectNameLimit,
	PROJECT_NAME_MAX_LEN,
	sanitizeProjectName,
	stripEnvMarkerTrailer,
} from "../project-name";

describe("sanitizeProjectName", () => {
	it("keeps normal project names", () => {
		expect(sanitizeProjectName("example-project")).toBe("example-project");
	});

	it("strips Claude Code environment suffixes from heading-style keys", () => {
		expect(
			sanitizeProjectName(
				"example-project - Is a git repository: true - Platform: linux",
			),
		).toBe("example-project");
	});

	it("strips concatenated Claude Code environment suffixes", () => {
		expect(
			sanitizeProjectName(
				"example-projectIs directory a git repo: YesPlatform: linuxShell: bash",
			),
		).toBe("example-project");
	});

	it("returns null when only environment metadata remains", () => {
		expect(sanitizeProjectName("Platform: linux")).toBeNull();
	});

	it("still truncates for its other callers (the backfill repair pass)", () => {
		// Truncation stays here: rejecting an over-long value is the EXTRACTION
		// guard's job, and this sanitizer also repairs already-stored rows.
		expect(sanitizeProjectName("a".repeat(PROJECT_NAME_MAX_LEN + 10))).toBe(
			"a".repeat(PROJECT_NAME_MAX_LEN),
		);
	});
});

describe("stripEnvMarkerTrailer", () => {
	it("drops a collapsed environment block and the punctuation at the seam", () => {
		expect(
			stripEnvMarkerTrailer(
				"/home/darken/clankermux Is directory a git repo: Yes Platform: linux",
			),
		).toBe("/home/darken/clankermux");
		expect(
			stripEnvMarkerTrailer(
				"/home/darken/clankermux - Is a git repository: true",
			),
		).toBe("/home/darken/clankermux");
	});

	it("returns a value with no recognized marker unchanged", () => {
		// It never invents a boundary — which is what lets the extraction guard
		// keep rejecting an unquoted capture that still holds prose after it.
		const leaked = "/home/u/projects/repo LEAKED SECRET sk-ABCDEFGH12345678";
		expect(stripEnvMarkerTrailer(leaked)).toBe(leaked);
	});

	it("requires whitespace before the marker, so a path segment is not a trailer", () => {
		// This helper sees WHOLE paths, where `sanitizeProjectName`'s regex only
		// ever saw an already-selected segment. Matching a marker word with no
		// separator in front of it would truncate `/workspace/model/repo` to
		// `/workspace` — a wrong project, not a missing one.
		expect(stripEnvMarkerTrailer("/workspace/model/repo")).toBe(
			"/workspace/model/repo",
		);
		expect(stripEnvMarkerTrailer("/workspace/Shell/repo")).toBe(
			"/workspace/Shell/repo",
		);
		expect(stripEnvMarkerTrailer("\\\\model\\share\\repo")).toBe(
			"\\\\model\\share\\repo",
		);
	});
});

describe("exceedsProjectNameLimit", () => {
	it("reports whether sanitizeProjectName would truncate", () => {
		expect(exceedsProjectNameLimit("a".repeat(PROJECT_NAME_MAX_LEN))).toBe(
			false,
		);
		expect(exceedsProjectNameLimit("a".repeat(PROJECT_NAME_MAX_LEN + 1))).toBe(
			true,
		);
	});

	it("measures the cleaned value, not the raw one", () => {
		const long = `example-project - Platform: ${"linux ".repeat(40)}`;
		expect(long.length).toBeGreaterThan(PROJECT_NAME_MAX_LEN);
		expect(exceedsProjectNameLimit(long)).toBe(false);
	});

	it("is false for values that sanitize away entirely", () => {
		expect(exceedsProjectNameLimit(null)).toBe(false);
		expect(exceedsProjectNameLimit("")).toBe(false);
		expect(exceedsProjectNameLimit("Platform: linux")).toBe(false);
	});
});
