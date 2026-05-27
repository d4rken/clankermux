import { describe, expect, it } from "bun:test";
import { sanitizeProjectName } from "../project-name";

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
});
