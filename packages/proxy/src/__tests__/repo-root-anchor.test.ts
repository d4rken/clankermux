import { describe, expect, it } from "bun:test";
import {
	ANCHOR_SCAN_MAX_CHARS,
	extractRepoRoot,
	instructionPathToRoot,
	repoRootToCandidate,
} from "../repo-root-anchor";

/** The line Claude Code emits for a checked-in instruction file. */
function projectInstructions(path: string): string {
	return `Contents of ${path} (project instructions, checked into the codebase):\n\n# Rules\n`;
}

describe("instructionPathToRoot", () => {
	it("cuts at the .claude directory", () => {
		expect(instructionPathToRoot("/home/u/repo/.claude/CLAUDE.md")).toBe(
			"/home/u/repo",
		);
	});

	it("reduces an @-imported rules file to the same root", () => {
		// Several rule files under one repo must collapse onto one candidate,
		// otherwise the shallowest-wins reduction is picking between siblings.
		expect(
			instructionPathToRoot("/home/u/repo/.claude/rules/architecture.md"),
		).toBe("/home/u/repo");
	});

	it("cuts at the FIRST .claude, so a worktree names its repository", () => {
		// A worktree under <root>/.claude/worktrees/<name> has its own
		// .claude/CLAUDE.md. Cutting at the last marker would name the worktree.
		expect(
			instructionPathToRoot(
				"/home/u/repo/.claude/worktrees/feature-x/.claude/CLAUDE.md",
			),
		).toBe("/home/u/repo");
	});

	it("falls back to the containing directory for a root-level CLAUDE.md", () => {
		expect(instructionPathToRoot("/home/u/repo/CLAUDE.md")).toBe(
			"/home/u/repo",
		);
	});

	it("returns null for a path with no directory part", () => {
		expect(instructionPathToRoot("/CLAUDE.md")).toBeNull();
	});
});

describe("extractRepoRoot", () => {
	it("resolves a plain session to its repository root", () => {
		const text = projectInstructions(
			"/home/darken/clankermux/.claude/CLAUDE.md",
		);
		expect(
			extractRepoRoot(
				text,
				"/home/darken/clankermux",
				"/home/darken/clankermux",
			),
		).toBe("/home/darken/clankermux");
	});

	it("resolves a worktree session to the repository, not the worktree", () => {
		// The three layouts observed in live traffic. All three previously
		// resolved correctly only because the folder walk happened to stop
		// before reaching `.claude`; this tier has to get them right directly.
		const text = projectInstructions(
			"/home/darken/projects/cnc/.claude/rules/dependency-safety.md",
		);
		expect(
			extractRepoRoot(
				text,
				"/home/darken/projects/cnc/.claude/worktrees/canvas-interactions",
				"/home/darken/projects/cnc",
			),
		).toBe("/home/darken/projects/cnc");
	});

	it("takes the shallowest candidate, not the first or the deepest", () => {
		const text = [
			projectInstructions("/home/u/repo/packages/api/CLAUDE.md"),
			projectInstructions("/home/u/repo/.claude/CLAUDE.md"),
		].join("\n");
		expect(
			extractRepoRoot(text, "/home/u/repo/packages/api", "/home/u/repo"),
		).toBe("/home/u/repo");
	});

	it("ignores a candidate that is not an ancestor of the working directory", () => {
		// A directory-scoped instruction file deeper in the tree than the cwd
		// names a subpackage, not the root the session is working inside.
		const text = projectInstructions("/home/u/repo/packages/api/CLAUDE.md");
		expect(extractRepoRoot(text, "/home/u/repo", "/home/u/repo")).toBeNull();
	});

	it("ignores the user's global instructions and auto-memory", () => {
		// Both live under the home directory and would name the HOME as a root.
		const text = [
			"Contents of /home/u/.claude/CLAUDE.md (user's private global instructions for all projects):",
			"Contents of /home/u/.claude/projects/x/memory/MEMORY.md (user's auto-memory, persists across conversations):",
		].join("\n");
		expect(extractRepoRoot(text, "/home/u/repo", "/home/u/repo")).toBeNull();
	});

	it("returns null without a working directory to validate against", () => {
		const text = projectInstructions("/home/u/repo/.claude/CLAUDE.md");
		expect(extractRepoRoot(text, "", "/home/u/repo")).toBeNull();
	});

	it("refuses a candidate shallower than the project directory already chosen", () => {
		// The injection this lower bound exists for. Rule 2 prefers the SHALLOWEST
		// candidate and every ancestor of the working directory satisfies an
		// ancestor-only check, so with an upper bound alone one fabricated line
		// outranks the genuine deeper path and picks the project name. Anything
		// able to write into the prompt could do it.
		for (const injected of [
			"/home/victim",
			"/home/x.md",
			"/home/darken/notes.md",
			"/home/darken/clankermux/../evil/CLAUDE.md",
		]) {
			const text = projectInstructions(injected);
			expect(
				extractRepoRoot(
					text,
					"/home/darken/clankermux",
					"/home/darken/clankermux",
				),
			).toBeNull();
		}
	});

	it("still accepts a candidate deeper than the chosen project directory", () => {
		// The whole point of the tier: ~/work is a container nobody configured, so
		// the walk chose /home/alice/work and the instruction file says the root
		// is one level further down.
		const text = projectInstructions("/home/alice/work/acme/.claude/CLAUDE.md");
		expect(
			extractRepoRoot(
				text,
				"/home/alice/work/acme/backend",
				"/home/alice/work",
			),
		).toBe("/home/alice/work/acme");
	});

	it("returns null without a project directory to bound it from below", () => {
		const text = projectInstructions("/home/u/repo/.claude/CLAUDE.md");
		expect(extractRepoRoot(text, "/home/u/repo", "")).toBeNull();
	});

	it("returns null for text carrying no instruction-file line", () => {
		expect(
			extractRepoRoot("no markers here", "/home/u/repo", "/home/u/repo"),
		).toBeNull();
	});

	it("is not left mid-string by a previous call", () => {
		// The regex is global, so `lastIndex` persists across executions unless
		// it is reset. Two identical calls must agree.
		const text = projectInstructions("/home/u/repo/.claude/CLAUDE.md");
		const first = extractRepoRoot(text, "/home/u/repo", "/home/u/repo");
		const second = extractRepoRoot(text, "/home/u/repo", "/home/u/repo");
		expect(second).toBe(first);
		expect(second).toBe("/home/u/repo");
	});

	it("reaches a marker at the offset Claude Code actually puts it", () => {
		// The regression this pins down. Claude Code emits the instruction-file
		// block AFTER its context preamble: measured across 600 live payloads the
		// marker sat at offset ~20,100 in first user messages up to ~66,000
		// characters. A 16,384 budget fired on 0 of the 505 payloads that carried
		// one, and every test still passed, because fixtures put the marker in the
		// first few hundred characters. Fixtures must therefore span the real
		// offset, or this tier can go dead again without a single failure.
		const REAL_WORLD_MARKER_OFFSET = 20_114;
		const REAL_WORLD_FIRST_MESSAGE = 65_883;
		expect(ANCHOR_SCAN_MAX_CHARS).toBeGreaterThan(REAL_WORLD_FIRST_MESSAGE);

		const text =
			"x".repeat(REAL_WORLD_MARKER_OFFSET) +
			projectInstructions("/home/u/repo/.claude/CLAUDE.md") +
			"y".repeat(REAL_WORLD_FIRST_MESSAGE - REAL_WORLD_MARKER_OFFSET);
		expect(
			extractRepoRoot(
				text.slice(0, ANCHOR_SCAN_MAX_CHARS),
				"/home/u/repo",
				"/home/u/repo",
			),
		).toBe("/home/u/repo");
	});

	it("still finds the root when the scan budget truncates later markers", () => {
		// Rule 1 is what makes truncation safe: whichever instruction file the
		// budget happens to include reduces to the same root.
		const filler = "x".repeat(ANCHOR_SCAN_MAX_CHARS);
		const text =
			projectInstructions("/home/u/repo/.claude/rules/a.md") +
			filler +
			projectInstructions("/home/u/repo/.claude/CLAUDE.md");
		expect(
			extractRepoRoot(
				text.slice(0, ANCHOR_SCAN_MAX_CHARS),
				"/home/u/repo",
				"/home/u/repo",
			),
		).toBe("/home/u/repo");
	});
});

describe("repoRootToCandidate", () => {
	it("returns the last segment", () => {
		expect(repoRootToCandidate("/home/u/repo")).toBe("repo");
	});

	it("returns null for a rootless path", () => {
		expect(repoRootToCandidate("/")).toBeNull();
	});
});
