import { describe, expect, it } from "bun:test";
import {
	exceedsProjectNameLimit,
	PROJECT_NAME_MAX_LEN,
	sanitizeProjectName,
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
