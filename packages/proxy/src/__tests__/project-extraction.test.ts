import { describe, expect, it } from "bun:test";
import {
	extractProjectFromBody,
	extractProjectFromRequest,
	mapWorkingDirToProject,
	normalizeProjectCandidate,
} from "../project-extraction";
import type { RequestJsonBody } from "../request-body-context";

describe("normalizeProjectCandidate", () => {
	it("rejects dot-leading names", () => {
		expect(normalizeProjectCandidate(".claude")).toBeNull();
	});

	it("rejects empty string", () => {
		expect(normalizeProjectCandidate("")).toBeNull();
	});

	it("rejects null and undefined", () => {
		expect(normalizeProjectCandidate(null)).toBeNull();
		expect(normalizeProjectCandidate(undefined)).toBeNull();
	});

	it("still applies sanitizeProjectName (env-marker run-ons stripped)", () => {
		expect(normalizeProjectCandidate("octiIs directory a git repo: No")).toBe(
			"octi",
		);
	});

	it("passes normal names through", () => {
		expect(normalizeProjectCandidate("clankermux")).toBe("clankermux");
	});
});

describe("mapWorkingDirToProject", () => {
	it("maps a home path without trailing slash", () => {
		expect(mapWorkingDirToProject("/home/darken/clankermux")).toBe(
			"clankermux",
		);
	});

	it("maps a home path with trailing slash", () => {
		expect(mapWorkingDirToProject("/home/darken/clankermux/")).toBe(
			"clankermux",
		);
	});

	it("collapses worktree subpaths to the repo name", () => {
		expect(
			mapWorkingDirToProject("/home/darken/clankermux/.claude/worktrees/fix-x"),
		).toBe("clankermux");
	});

	it("skips container dirs under Users", () => {
		expect(mapWorkingDirToProject("/Users/alice/projects/my-app")).toBe(
			"my-app",
		);
	});

	it("skips container dirs under home", () => {
		expect(mapWorkingDirToProject("/home/bob/git_repos/tool")).toBe("tool");
	});

	it("returns null for container-only home paths", () => {
		expect(mapWorkingDirToProject("/home/user/src")).toBeNull();
		expect(mapWorkingDirToProject("/Users/me/repos")).toBeNull();
		expect(mapWorkingDirToProject("/home/user/git_repos/")).toBeNull();
	});

	it("returns null for a bare home dir", () => {
		expect(mapWorkingDirToProject("/home/darken")).toBeNull();
	});

	it("rejects dot-dir results under home", () => {
		expect(mapWorkingDirToProject("/home/darken/.claude")).toBeNull();
	});

	it("uses basename for non-home paths", () => {
		expect(mapWorkingDirToProject("/workspace")).toBe("workspace");
	});

	it("uses basename for deeper non-home paths", () => {
		expect(mapWorkingDirToProject("/srv/data/myproj")).toBe("myproj");
	});
});

describe("extractProjectFromBody", () => {
	it("prefers the anchored Primary working directory label over earlier memory paths", () => {
		// Realistic main-session prompt: memory references appear long before
		// the environment block that carries the actual working directory.
		const body: RequestJsonBody = {
			system:
				"You are Claude Code, Anthropic's official CLI for Claude.\n" +
				"# claudeMd\n" +
				"Contents of /home/darken/.claude/projects/-home-darken-clankermux/memory/MEMORY.md (user's auto-memory):\n" +
				"- [Some entry](reference_some_entry.md) — details\n" +
				"\n" +
				"# Environment\n" +
				" - Primary working directory: /home/darken/clankermux\n" +
				" - Is a git repository: true\n" +
				" - Platform: linux\n",
			messages: [{ role: "user", content: "hello" }],
		};
		expect(extractProjectFromBody(body)).toBe("clankermux");
	});

	it("handles subagent array-form system with a Working directory env block", () => {
		const body: RequestJsonBody = {
			system: [
				{
					type: "text",
					text:
						"You are an agent for Claude Code.\n" +
						"Here is useful information about the environment you are running in:\n" +
						"<env>\n" +
						"Working directory: /home/darken/clankermux/.claude/worktrees/foo\n" +
						"Is directory a git repo: Yes\n" +
						"Platform: linux\n" +
						"</env>",
				},
			],
			messages: [{ role: "user", content: "do the thing" }],
		};
		expect(extractProjectFromBody(body)).toBe("clankermux");
	});

	it("captures paths with spaces to end of line", () => {
		const body: RequestJsonBody = {
			system:
				"# Environment\nPrimary working directory: /Users/Me/My Project\nIs a git repository: false\n",
			messages: [{ role: "user", content: "hi" }],
		};
		expect(extractProjectFromBody(body)).toBe("My Project");
	});

	it("strips surrounding quotes from the captured path", () => {
		const body: RequestJsonBody = {
			system: '<env>\nWorking directory: "/home/darken/octi"\n</env>',
			messages: [{ role: "user", content: "hi" }],
		};
		expect(extractProjectFromBody(body)).toBe("octi");
	});

	it("lets Primary working directory win over plain Working directory regardless of block order", () => {
		const body: RequestJsonBody = {
			system: [
				{
					type: "text",
					text: "<env>\nWorking directory: /home/darken/other-proj\n</env>",
				},
				{
					type: "text",
					text: "# Environment\nPrimary working directory: /home/darken/clankermux\n",
				},
			],
			messages: [{ role: "user", content: "hi" }],
		};
		expect(extractProjectFromBody(body)).toBe("clankermux");
	});

	it("falls back to the codex <cwd> tag in the first user message (array content)", () => {
		const body: RequestJsonBody = {
			system: "You are a coding agent running in a terminal.",
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text:
								"<environment_context>\n" +
								"  <cwd>/home/darken/clankermux</cwd>\n" +
								"  <shell>bash</shell>\n" +
								"  <approval_policy>on-request</approval_policy>\n" +
								"</environment_context>",
						},
					],
				},
			],
		};
		expect(extractProjectFromBody(body)).toBe("clankermux");
	});

	it("finds the <cwd> tag in first user message with string content", () => {
		const body: RequestJsonBody = {
			system: "You are a coding agent.",
			messages: [
				{
					role: "user",
					content:
						"<environment_context>\n<cwd>/home/darken/clankermux</cwd>\n<shell>bash</shell>\n</environment_context>",
				},
			],
		};
		expect(extractProjectFromBody(body)).toBe("clankermux");
	});

	it("never scans past the first user message for <cwd>", () => {
		const body: RequestJsonBody = {
			system: "You are a coding agent.",
			messages: [
				{ role: "user", content: "plain question with no environment tag" },
				{ role: "assistant", content: "an answer" },
				{
					role: "user",
					content:
						"<environment_context>\n<cwd>/home/darken/clankermux</cwd>\n</environment_context>",
				},
			],
		};
		expect(extractProjectFromBody(body)).toBeNull();
	});

	it("returns null when system only contains unlabeled .claude paths (old regex regression)", () => {
		// The retired "first absolute path anywhere" regex would have latched onto
		// /home/darken/.claude/... and produced ".claude".
		const body: RequestJsonBody = {
			system:
				"Contents of /home/darken/.claude/projects/-home-darken-clankermux/memory/MEMORY.md:\n" +
				"- notes referencing /home/darken/.claude/rules/foo.md\n",
			messages: [{ role: "user", content: "hi" }],
		};
		expect(extractProjectFromBody(body)).toBeNull();
	});

	it("returns null for a markdown-H1-only system prompt (H1 fallback dropped)", () => {
		const body: RequestJsonBody = {
			system: "# Harness\nstuff",
			messages: [{ role: "user", content: "hi" }],
		};
		expect(extractProjectFromBody(body)).toBeNull();
	});

	it("returns null for a null body", () => {
		expect(extractProjectFromBody(null)).toBeNull();
	});

	it("returns null for a body with no system and no messages", () => {
		const body: RequestJsonBody = { model: "claude-opus-4-8" };
		expect(extractProjectFromBody(body)).toBeNull();
	});
});

describe("extractProjectFromRequest", () => {
	const bodyWithWd: RequestJsonBody = {
		system:
			"# Environment\nPrimary working directory: /home/darken/clankermux\n",
		messages: [{ role: "user", content: "hi" }],
	};

	it("gives the x-project header precedence over body tiers", () => {
		const headers = new Headers({ "x-project": "my-proj" });
		expect(
			extractProjectFromRequest("POST", "/v1/messages", headers, bodyWithWd),
		).toBe("my-proj");
	});

	it("returns null for GET /v1/messages even with a header", () => {
		const headers = new Headers({ "x-project": "my-proj" });
		expect(
			extractProjectFromRequest("GET", "/v1/messages", headers, bodyWithWd),
		).toBeNull();
	});

	it("returns null for POST /v1/messages/count_tokens (exact path gate)", () => {
		const headers = new Headers({ "x-project": "my-proj" });
		expect(
			extractProjectFromRequest(
				"POST",
				"/v1/messages/count_tokens",
				headers,
				bodyWithWd,
			),
		).toBeNull();
	});

	it("falls through to body tiers when the header is dot-leading", () => {
		const headers = new Headers({ "x-project": ".hidden" });
		expect(
			extractProjectFromRequest("POST", "/v1/messages", headers, bodyWithWd),
		).toBe("clankermux");
	});

	it("falls through to body tiers when the header is whitespace-only", () => {
		const headers = new Headers({ "x-project": "   " });
		expect(
			extractProjectFromRequest("POST", "/v1/messages", headers, bodyWithWd),
		).toBe("clankermux");
	});

	it("works with Headers constructed from a plain object (payload envelope backfill)", () => {
		const headers = new Headers({
			"x-project": "envelope-proj",
			"content-type": "application/json",
			"user-agent": "claude-cli/2.0.0",
		});
		expect(
			extractProjectFromRequest("POST", "/v1/messages", headers, bodyWithWd),
		).toBe("envelope-proj");
	});
});
