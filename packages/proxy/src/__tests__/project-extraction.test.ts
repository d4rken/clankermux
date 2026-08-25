import { describe, expect, it } from "bun:test";
import { defaultProjectRules, type ProjectRules } from "@clankermux/types";
import {
	extractProjectFromBody as extractProjectFromBodyWith,
	extractProjectFromRequest as extractProjectFromRequestWith,
	extractSessionId,
	isAnchoredSource,
	mapWorkingDirToProject as mapWorkingDirToProjectWith,
	normalizeProjectCandidate,
	resolveProject as resolveProjectWith,
} from "../project-extraction";
import { PROJECT_NAME_MAX_LEN } from "../project-name";
import type { RequestJsonBody } from "../request-body-context";
import { SessionProjectCache } from "../session-project-cache";

// Attribution is rules-driven now. These wrappers bind the DEFAULT rules — the
// ones a deployment gets with no configuration — so every assertion below reads
// as "what happens out of the box", and a test that cares about a specific rule
// set passes its own.
const RULES = defaultProjectRules();

const mapWorkingDirToProject = (wd: string, rules: ProjectRules = RULES) =>
	mapWorkingDirToProjectWith(wd, rules);

const extractProjectFromBody = (
	body: RequestJsonBody | null,
	rules: ProjectRules = RULES,
) => extractProjectFromBodyWith(body, rules);

const extractProjectFromRequest = (
	method: string,
	path: string,
	headers: Headers,
	body: RequestJsonBody | null,
	rules: ProjectRules = RULES,
) => extractProjectFromRequestWith(method, path, headers, body, rules);

const resolveProject = (
	method: string,
	path: string,
	headers: Headers,
	body: RequestJsonBody | null,
	apiKeyId: string | null,
	cache: SessionProjectCache,
	rules: ProjectRules = RULES,
) => resolveProjectWith(method, path, headers, body, apiKeyId, cache, rules);

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

	it("rejects an over-long candidate rather than truncating it", () => {
		// Truncation would hand routing a 64-char slice of whatever text this was.
		expect(normalizeProjectCandidate("a".repeat(PROJECT_NAME_MAX_LEN))).toBe(
			"a".repeat(PROJECT_NAME_MAX_LEN),
		);
		expect(
			normalizeProjectCandidate("a".repeat(PROJECT_NAME_MAX_LEN + 1)),
		).toBeNull();
	});

	it("measures the limit AFTER env-marker cleanup", () => {
		// The marker suffix is stripped first, so a short name carrying a long
		// concatenated env block is still accepted.
		expect(
			normalizeProjectCandidate(
				`octiIs directory a git repo: No${" - Platform: linux".repeat(4)}`,
			),
		).toBe("octi");
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

	it("returns null for a non-home path no root covers", () => {
		// This REPLACES a basename fallback. `/workspace/myrepo/packages/api`
		// used to resolve to "api", so every subdirectory of one repository
		// became its own project and its own load-balancer affinity partition.
		expect(mapWorkingDirToProject("/workspace")).toBeNull();
		expect(mapWorkingDirToProject("/workspace/myrepo/packages/api")).toBeNull();
		expect(mapWorkingDirToProject("/srv/data/myproj")).toBeNull();
	});

	it("resolves a non-home path once a root covers it", () => {
		const rules = { roots: ["/workspace"], overrides: [] };
		// And it resolves to the REPOSITORY, not the leaf directory, which is
		// what the basename fallback got wrong.
		expect(
			mapWorkingDirToProject("/workspace/myrepo/packages/api", rules),
		).toBe("myrepo");
	});

	it("maps a Windows drive path without leaking the user name", () => {
		// Splitting on "/" alone left the whole backslash string as ONE segment,
		// so the stored project was "C:\Users\Alice\myproj" — user name included.
		expect(mapWorkingDirToProject("C:\\Users\\Alice\\myproj")).toBe("myproj");
		expect(mapWorkingDirToProject("D:/Users/Alice/projects/my-app")).toBe(
			"my-app",
		);
	});

	it("returns null for a bare Windows home dir", () => {
		expect(mapWorkingDirToProject("C:\\Users\\Alice")).toBeNull();
	});

	it("keeps the UNC host, so a root names the server as well as the share", () => {
		expect(mapWorkingDirToProject("\\\\fileserver\\share\\myproj")).toBeNull();
		// A root naming only the share does NOT match: the host is part of the
		// path's identity, so two servers exporting `share` stay distinct.
		expect(
			mapWorkingDirToProject("\\\\fileserver\\share\\myproj", {
				roots: ["/share"],
				overrides: [],
			}),
		).toBeNull();
		expect(
			mapWorkingDirToProject("\\\\fileserver\\share\\myproj", {
				roots: ["/fileserver/share"],
				overrides: [],
			}),
		).toBe("myproj");
		// A wildcard host is available for operators who genuinely want every
		// server treated alike — but they have to ask for it.
		expect(
			mapWorkingDirToProject("\\\\fileserver\\share\\myproj", {
				roots: ["/*/share"],
				overrides: [],
			}),
		).toBe("myproj");
	});

	it("rejects a candidate longer than the limit instead of truncating it", () => {
		const atLimit = "a".repeat(PROJECT_NAME_MAX_LEN);
		expect(mapWorkingDirToProject(`/home/u/${atLimit}`)).toBe(atLimit);
		expect(mapWorkingDirToProject(`/home/u/${atLimit}b`)).toBeNull();
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
		expect(extractProjectFromBody(body)).toEqual({
			project: "clankermux",
			source: "wd_primary",
		});
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
		expect(extractProjectFromBody(body)).toEqual({
			project: "clankermux",
			source: "wd_plain",
		});
	});

	it("rejects an UNQUOTED path with spaces but accepts the quoted form", () => {
		// An unquoted spaced path is indistinguishable from a path followed by
		// same-line prose, so it is refused; quoting removes the ambiguity.
		const unquoted: RequestJsonBody = {
			system:
				"# Environment\nPrimary working directory: /Users/Me/My Project\nIs a git repository: false\n",
			messages: [{ role: "user", content: "hi" }],
		};
		expect(extractProjectFromBody(unquoted)).toEqual({
			project: null,
			source: "none",
		});

		const quoted: RequestJsonBody = {
			system:
				'# Environment\nPrimary working directory: "/Users/Me/My Project"\nIs a git repository: false\n',
			messages: [{ role: "user", content: "hi" }],
		};
		expect(extractProjectFromBody(quoted)).toEqual({
			project: "My Project",
			source: "wd_primary",
		});
	});

	it("strips surrounding quotes from the captured path", () => {
		const body: RequestJsonBody = {
			system: '<env>\nWorking directory: "/home/darken/octi"\n</env>',
			messages: [{ role: "user", content: "hi" }],
		};
		expect(extractProjectFromBody(body)).toEqual({
			project: "octi",
			source: "wd_plain",
		});
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
		expect(extractProjectFromBody(body)).toEqual({
			project: "clankermux",
			source: "wd_primary",
		});
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
		expect(extractProjectFromBody(body)).toEqual({
			project: "clankermux",
			source: "codex_cwd",
		});
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
		expect(extractProjectFromBody(body)).toEqual({
			project: "clankermux",
			source: "codex_cwd",
		});
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
		expect(extractProjectFromBody(body)).toEqual({
			project: null,
			source: "none",
		});
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
		expect(extractProjectFromBody(body)).toEqual({
			project: null,
			source: "none",
		});
	});

	it("returns null for a markdown-H1-only system prompt (H1 fallback dropped)", () => {
		const body: RequestJsonBody = {
			system: "# Harness\nstuff",
			messages: [{ role: "user", content: "hi" }],
		};
		expect(extractProjectFromBody(body)).toEqual({
			project: null,
			source: "none",
		});
	});

	it("returns null for a null body", () => {
		expect(extractProjectFromBody(null)).toEqual({
			project: null,
			source: "none",
		});
	});

	it("returns null for a body with no system and no messages", () => {
		const body: RequestJsonBody = { model: "claude-opus-4-8" };
		expect(extractProjectFromBody(body)).toEqual({
			project: null,
			source: "none",
		});
	});
});

/**
 * The extracted project is not display-only: it is persisted on the request row,
 * offered in the dashboard filter, and used as a load-balancer affinity
 * partition key. Anything the guard lets through therefore has to be a project
 * name, not a fragment of the prompt that happened to follow the label.
 */
describe("extractProjectFromBody — prompt-leak guard", () => {
	function systemBody(system: string): RequestJsonBody {
		return { system, messages: [{ role: "user", content: "hi" }] };
	}

	function codexBody(text: string): RequestJsonBody {
		return {
			system: "You are a coding agent running in a terminal.",
			messages: [{ role: "user", content: text }],
		};
	}

	const NOTHING = { project: null, source: "none" } as const;

	it("rejects same-line prose trailing an unquoted path", () => {
		expect(
			extractProjectFromBody(
				systemBody(
					"Working directory: /home/u/projects/repo LEAKED SECRET sk-ABCDEFGH12345678",
				),
			),
		).toEqual(NOTHING);
	});

	it("rejects a long prompt tail instead of truncating it into a plausible name", () => {
		// The 64-char truncation is what used to manufacture a project name out of
		// prompt text; the tail must be refused outright.
		expect(
			extractProjectFromBody(
				systemBody(
					"Working directory: /home/u/projects/repo followed by a long tail of leaked prompt text that keeps going and going",
				),
			),
		).toEqual(NOTHING);
	});

	it("rejects a labelled path surrounded by prose lines", () => {
		expect(
			extractProjectFromBody(
				systemBody(
					"some notes\nWorking directory: /srv/app - set this before running\nmore notes",
				),
			),
		).toEqual(NOTHING);
	});

	it("rejects a codex <cwd> whose path is followed by a newline and prose", () => {
		// CODEX_CWD_RE captures across newlines, and the control-char strip in
		// sanitizeProjectName used to FUSE the two lines into "repoLEAKED sk-…".
		expect(
			extractProjectFromBody(
				codexBody("<cwd>/home/u/projects/repo\nLEAKED sk-AAAAAAAA1111</cwd>"),
			),
		).toEqual(NOTHING);
	});

	it("rejects a tab inside the capture", () => {
		expect(
			extractProjectFromBody(systemBody("Working directory: /srv/app\tnotes")),
		).toEqual(NOTHING);
	});

	it("still accepts the real Claude Code environment block", () => {
		expect(
			extractProjectFromBody(
				systemBody(
					"<env>\nWorking directory: /home/darken/clankermux\nIs directory a git repo: Yes\nPlatform: linux\n</env>",
				),
			),
		).toEqual({ project: "clankermux", source: "wd_plain" });
	});

	it("rejects a COLLAPSED env block — accepted regression, do not 'fix' it", () => {
		// A client that flattens the prompt's newlines puts the whole block on the
		// label's line, and rule (c) then rejects it. Stripping a recognized marker
		// trailer first was tried and removed: every variant misattributed instead
		// (see the guard notes in project-extraction.ts). Correct, or nothing.
		expect(
			extractProjectFromBody(
				systemBody(
					"Working directory: /home/darken/clankermux Is directory a git repo: Yes Platform: linux",
				),
			),
		).toEqual(NOTHING);
		expect(
			extractProjectFromBody(
				systemBody(
					"Primary working directory: /home/darken/clankermux - Is a git repository: true",
				),
			),
		).toEqual(NOTHING);

		// The newline-separated form — what Claude Code actually sends — is
		// unaffected: the label regexes are line-anchored, so the env block never
		// enters the capture in the first place.
		expect(
			extractProjectFromBody(
				systemBody(
					"Working directory: /home/darken/clankermux\nIs directory a git repo: Yes\nPlatform: linux",
				),
			),
		).toEqual({ project: "clankermux", source: "wd_plain" });
	});

	it("never truncates a path at a directory named like an env marker", () => {
		// The worst failure mode of the removed trailer strip: a WRONG project
		// rather than none, merging two codebases into one affinity partition.
		// Roots are configured here because the point under test is the marker
		// guard, not whether the layout is recognized.
		const rules = {
			roots: [
				"/workspace/model",
				"/workspace/Model",
				"/workspace/shell",
				"/workspace/platform",
				// The UNC case below: host `model`, share `share`. The host is part
				// of the path now, so the root has to name it.
				"/model/share",
			],
			overrides: [],
		};
		for (const wd of [
			"/workspace/model/repo",
			"/workspace/Model/repo",
			"/workspace/shell/repo",
			"/workspace/platform/repo",
		]) {
			expect(
				extractProjectFromBody(systemBody(`Working directory: ${wd}`), rules),
			).toEqual({ project: "repo", source: "wd_plain" });
		}
		expect(
			extractProjectFromBody(
				systemBody("Working directory: \\\\model\\share\\repo"),
				rules,
			),
		).toEqual({ project: "repo", source: "wd_plain" });
	});

	it("rejects a quoted path trailed by an env block rather than guessing", () => {
		// The trailer sits outside the closing quote, so the capture as a whole is
		// unquoted and rule (c) rejects it. Re-testing for quotes after a trailer
		// strip made this resolve — and truncated `"/workspace/Data Platform/repo"
		// Shell: bash` to `Data`. Failing safe is the trade we took.
		expect(
			extractProjectFromBody(
				systemBody(
					'Working directory: "/workspace/My Project" Platform: linux',
				),
			),
		).toEqual(NOTHING);
		expect(
			extractProjectFromBody(
				systemBody(
					'Working directory: "/workspace/Data Platform/repo" Shell: bash',
				),
			),
		).toEqual(NOTHING);
	});

	it("rejects leaked prose that happens to be followed by an env marker", () => {
		// Nothing in the capture rescues it: rule (c) sees unquoted whitespace.
		expect(
			extractProjectFromBody(
				systemBody(
					"Working directory: /home/u/projects/repo LEAKED SECRET sk-ABCDEFGH12345678 Platform: linux",
				),
			),
		).toEqual(NOTHING);
	});

	it("still accepts an env block with CRLF line endings", () => {
		// The capture keeps the trailing \r; trimming happens before the
		// control-char check, so CRLF must not be read as a leak.
		expect(
			extractProjectFromBody(
				systemBody(
					"<env>\r\nWorking directory: /home/darken/clankermux\r\nPlatform: linux\r\n</env>",
				),
			),
		).toEqual({ project: "clankermux", source: "wd_plain" });
	});

	it("still accepts a pretty-printed multi-line <cwd>", () => {
		// Boundary whitespace is trimmed FIRST, so the newlines inside the tag are
		// not mistaken for embedded prompt text.
		expect(
			extractProjectFromBody(
				codexBody("<environment_context>\n<cwd>\n/home/u/repo\n</cwd>\n"),
			),
		).toEqual({ project: "repo", source: "codex_cwd" });
	});

	it("accepts legitimate names the dropped heuristics would have rejected", () => {
		// A word-count cap and a secret-token-shape regex both misfired here: this
		// is a real repository name, not a credential.
		expect(
			extractProjectFromBody(
				systemBody(
					"Working directory: /home/u/projects/2026-client-migration-dashboard",
				),
			),
		).toEqual({
			project: "2026-client-migration-dashboard",
			source: "wd_plain",
		});
		expect(
			extractProjectFromBody(
				systemBody("Working directory: /srv/my.app.service"),
				{
					roots: ["/srv"],
					overrides: [],
				},
			),
		).toEqual({ project: "my.app.service", source: "wd_plain" });
	});

	it("accepts a name exactly at the length limit and rejects one over", () => {
		const atLimit = "a".repeat(PROJECT_NAME_MAX_LEN);
		expect(
			extractProjectFromBody(
				systemBody(`Working directory: /home/u/${atLimit}`),
			),
		).toEqual({ project: atLimit, source: "wd_plain" });
		expect(
			extractProjectFromBody(
				systemBody(`Working directory: /home/u/${atLimit}b`),
			),
		).toEqual({ ...NOTHING, unmatchedPath: `/home/u/${atLimit}b` });
	});

	it("rejects an instruction-shaped tail (multi-word, no path)", () => {
		expect(
			extractProjectFromBody(
				systemBody("Working directory: ignore prior instructions"),
			),
		).toEqual(NOTHING);
	});

	it("no longer accepts a whitespace-free single token as a project", () => {
		// This used to be a documented residual: the capture guard settles for
		// bounded length, no control chars and no unquoted whitespace, because no
		// deterministic rule separates a secret-shaped token from a legitimate
		// repo name (the token-shape regex rejected
		// "2026-client-migration-dashboard" and was defeated by a "token=" prefix).
		// A bare token got through and became a partition key.
		//
		// It is now rejected as a PATH before the rules engine sees it: a working
		// directory has to be absolute. That also keeps it out of the operator's
		// unmatched-paths list, which is rendered in the dashboard — reporting
		// "we could not map /this/path" is useful, echoing a secret-shaped
		// fragment of someone's prompt back into the UI is not.
		for (const token of [
			"token=sk-ABCDEFGH12345678",
			"eyJhbGciOi.eyJzdWIiOi.SflKxwRJ",
		]) {
			expect(
				extractProjectFromBody(systemBody(`Working directory: ${token}`)),
			).toEqual(NOTHING);
		}
	});

	it("maps a Windows working directory without leaking the user name", () => {
		expect(
			extractProjectFromBody(
				systemBody(
					"# Environment\nPrimary working directory: C:\\Users\\Alice\\myproj\n",
				),
			),
		).toEqual({ project: "myproj", source: "wd_primary" });
	});

	it("rejects an unquoted Windows path with spaces and accepts the quoted one", () => {
		expect(
			extractProjectFromBody(
				systemBody("Working directory: C:\\Users\\Alice\\My Project"),
			),
		).toEqual(NOTHING);
		expect(
			extractProjectFromBody(
				systemBody('Working directory: "C:\\Users\\Alice\\My Project"'),
			),
		).toEqual({ project: "My Project", source: "wd_plain" });
	});
});

describe("extractProjectFromBody — tier ordering", () => {
	function body(system: string): RequestJsonBody {
		return { system, messages: [{ role: "user", content: "hi" }] };
	}

	const INSTRUCTIONS =
		"Contents of /home/darken/clankermux/.claude/CLAUDE.md (project instructions, checked into the codebase):";

	it("prefers a path override over everything the request implies", () => {
		// The operator's mapping is the one signal that is a decision rather than
		// an inference, so nothing outranks it.
		expect(
			extractProjectFromBody(
				body(
					`Working directory: /home/darken/clankermux\n${INSTRUCTIONS}\n# Rules`,
				),
				{
					roots: ["/home/*"],
					overrides: [{ prefix: "/home/darken/clankermux", name: "muxer" }],
				},
			),
		).toEqual({ project: "muxer", source: "path_override" });
	});

	it("lets an override name a dot-leading directory the heuristic refuses", () => {
		// The whole reason the override tier skips the dot rule: sessions in
		// /home/u/.claude were unattributable and could not be made otherwise.
		expect(
			extractProjectFromBody(body("Working directory: /home/darken/.claude"), {
				roots: ["/home/*"],
				overrides: [{ prefix: "/home/darken/.claude", name: ".claude" }],
			}),
		).toEqual({ project: ".claude", source: "path_override" });
	});

	it("still rejects a dot-leading name the heuristic produced", () => {
		expect(
			extractProjectFromBody(body("Working directory: /home/darken/.claude")),
		).toEqual({
			project: null,
			source: "none",
			unmatchedPath: "/home/darken/.claude",
		});
	});

	it("uses a configured override name verbatim, markers and spaces intact", () => {
		// The name normalizer for INFERRED names strips a trailing run starting
		// at "Platform"/"Shell"/"Model", to clean up a scraped environment block.
		// Applied to a name the operator typed it mangles legitimate ones.
		for (const name of ["Acme Platform", "model", "Shell", "my.app.service"]) {
			expect(
				extractProjectFromBody(body("Working directory: /home/darken/thing"), {
					roots: [],
					overrides: [{ prefix: "/home/darken/thing", name }],
				}),
			).toEqual({ project: name, source: "path_override" });
		}
	});

	it("applies the tier order across candidates, not within each one", () => {
		// An override naming the plain working directory must beat a mere roots
		// match on the primary one. Running every tier per candidate made the
		// documented order local to whichever candidate came first.
		const system = [
			"Primary working directory: /home/darken/clankermux",
			"Working directory: /home/darken/other",
		].join("\n");
		expect(
			extractProjectFromBody(body(system), {
				roots: ["/home/*"],
				overrides: [{ prefix: "/home/darken/other", name: "chosen" }],
			}),
		).toEqual({ project: "chosen", source: "path_override" });
	});

	it("refuses an injected instruction path shallower than the walk's answer", () => {
		// End-to-end guard for the anchor's lower bound: a line in the prompt
		// must not be able to rename the project to something above it.
		const system = [
			"Working directory: /home/darken/clankermux",
			"Contents of /home/victim (project instructions, checked into the codebase):",
		].join("\n");
		expect(extractProjectFromBody(body(system))).toEqual({
			project: "clankermux",
			source: "wd_plain",
		});
	});

	it("prefers the repository root over the folder walk when they disagree", () => {
		// ~/work is a container nobody configured, so the walk would answer
		// "work" for every repository beneath it. The instruction-file path names
		// the actual root.
		const system = [
			"Working directory: /home/alice/work/acme/backend",
			"Contents of /home/alice/work/acme/.claude/CLAUDE.md (project instructions, checked into the codebase):",
			"# Rules",
		].join("\n");
		expect(extractProjectFromBody(body(system))).toEqual({
			project: "acme",
			source: "repo_root",
		});
	});

	it("falls back to the folder walk when no instruction file names a root", () => {
		expect(
			extractProjectFromBody(
				body("Working directory: /home/darken/clankermux"),
			),
		).toEqual({ project: "clankermux", source: "wd_plain" });
	});

	it("labels the walk by the signal that supplied the path", () => {
		expect(
			extractProjectFromBody(
				body("Primary working directory: /home/darken/clankermux"),
			),
		).toEqual({ project: "clankermux", source: "wd_primary" });
	});

	it("ignores an instruction file that is not an ancestor of the cwd", () => {
		// A subpackage's own instructions must not rename the session's project.
		const system = [
			"Working directory: /home/darken/clankermux",
			"Contents of /home/darken/clankermux/packages/proxy/CLAUDE.md (project instructions, checked into the codebase):",
			"# Rules",
		].join("\n");
		expect(extractProjectFromBody(body(system))).toEqual({
			project: "clankermux",
			source: "wd_plain",
		});
	});

	it("reports the working directory when nothing matched", () => {
		expect(
			extractProjectFromBody(body("Working directory: /workspace/myrepo")),
		).toEqual({
			project: null,
			source: "none",
			unmatchedPath: "/workspace/myrepo",
		});
	});

	it("reports nothing to configure when the request carried no path at all", () => {
		// Not a configuration gap. Stamping this as unmatched would fill the
		// operator's list with every signal-less request.
		expect(
			extractProjectFromBody(body("You are a helpful assistant.")),
		).toEqual({ project: null, source: "none" });
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
		).toEqual({
			project: "my-proj",
			source: "header",
		});
	});

	it("returns null for GET /v1/messages even with a header", () => {
		const headers = new Headers({ "x-project": "my-proj" });
		expect(
			extractProjectFromRequest("GET", "/v1/messages", headers, bodyWithWd),
		).toEqual({
			project: null,
			source: "none",
		});
	});

	it("extracts on POST /v1/messages/count_tokens (path gate widened for tier 4)", () => {
		const headers = new Headers({ "x-project": "my-proj" });
		expect(
			extractProjectFromRequest(
				"POST",
				"/v1/messages/count_tokens",
				headers,
				bodyWithWd,
			),
		).toEqual({
			project: "my-proj",
			source: "header",
		});
	});

	it("extracts body tiers on POST /v1/messages/count_tokens without a header", () => {
		expect(
			extractProjectFromRequest(
				"POST",
				"/v1/messages/count_tokens",
				new Headers(),
				bodyWithWd,
			),
		).toEqual({
			project: "clankermux",
			source: "wd_primary",
		});
	});

	it("still rejects unrelated paths", () => {
		const headers = new Headers({ "x-project": "my-proj" });
		expect(
			extractProjectFromRequest("POST", "/v1/complete", headers, bodyWithWd),
		).toEqual({
			project: null,
			source: "none",
		});
	});

	it("falls through to body tiers when the header is dot-leading", () => {
		const headers = new Headers({ "x-project": ".hidden" });
		expect(
			extractProjectFromRequest("POST", "/v1/messages", headers, bodyWithWd),
		).toEqual({
			project: "clankermux",
			source: "wd_primary",
		});
	});

	it("falls through to body tiers when the header is whitespace-only", () => {
		const headers = new Headers({ "x-project": "   " });
		expect(
			extractProjectFromRequest("POST", "/v1/messages", headers, bodyWithWd),
		).toEqual({
			project: "clankermux",
			source: "wd_primary",
		});
	});

	it("works with Headers constructed from a plain object (payload envelope backfill)", () => {
		const headers = new Headers({
			"x-project": "envelope-proj",
			"content-type": "application/json",
			"user-agent": "claude-cli/2.0.0",
		});
		expect(
			extractProjectFromRequest("POST", "/v1/messages", headers, bodyWithWd),
		).toEqual({
			project: "envelope-proj",
			source: "header",
		});
	});
});

const SESSION_UUID = "6fa3b1de-1234-4abc-9def-0123456789ab";

function metadataWith(userId: unknown): RequestJsonBody {
	return { metadata: { user_id: userId } };
}

function encodeUserId(sessionId: string): string {
	return JSON.stringify({
		device_id: "device-1",
		account_uuid: "",
		session_id: sessionId,
	});
}

describe("extractSessionId", () => {
	it("extracts the session id from valid Claude Code metadata", () => {
		expect(extractSessionId(metadataWith(encodeUserId(SESSION_UUID)))).toBe(
			SESSION_UUID,
		);
	});

	it("returns null for a null body", () => {
		expect(extractSessionId(null)).toBeNull();
	});

	it("returns null when metadata is missing", () => {
		expect(extractSessionId({ model: "claude-opus-4-8" })).toBeNull();
	});

	it("returns null when metadata is not an object", () => {
		expect(extractSessionId({ metadata: "nope" })).toBeNull();
	});

	it("returns null when user_id is not a string", () => {
		expect(extractSessionId(metadataWith(42))).toBeNull();
		expect(
			extractSessionId(metadataWith({ session_id: SESSION_UUID })),
		).toBeNull();
	});

	it("returns null for malformed JSON in user_id", () => {
		expect(extractSessionId(metadataWith("{not json"))).toBeNull();
	});

	it("returns null when the parsed user_id is not an object", () => {
		expect(extractSessionId(metadataWith('"just a string"'))).toBeNull();
	});

	it("returns null when session_id is missing or not a string", () => {
		expect(
			extractSessionId(metadataWith(JSON.stringify({ device_id: "d" }))),
		).toBeNull();
		expect(
			extractSessionId(metadataWith(JSON.stringify({ session_id: 7 }))),
		).toBeNull();
	});

	it("returns null for empty or whitespace-only session_id", () => {
		expect(extractSessionId(metadataWith(encodeUserId("")))).toBeNull();
		expect(extractSessionId(metadataWith(encodeUserId("   ")))).toBeNull();
	});

	it("returns null for a session_id longer than 64 characters", () => {
		expect(
			extractSessionId(metadataWith(encodeUserId("x".repeat(65)))),
		).toBeNull();
		expect(extractSessionId(metadataWith(encodeUserId("x".repeat(64))))).toBe(
			"x".repeat(64),
		);
	});
});

describe("resolveProject", () => {
	const anchoredBody: RequestJsonBody = {
		system:
			"# Environment\nPrimary working directory: /home/darken/clankermux\n",
		messages: [{ role: "user", content: "hi" }],
		metadata: { user_id: encodeUserId(SESSION_UUID) },
	};
	const signalLessBody: RequestJsonBody = {
		system: "You are a security monitor.",
		messages: [{ role: "user", content: "review this" }],
		metadata: { user_id: encodeUserId(SESSION_UUID) },
	};

	it("does not inherit over an explicit working directory that matched no rule", () => {
		// The request said where it is; we just do not know that place.
		// Inheriting answers a question about directory B with directory A's
		// project — a definite WRONG project, and the exact outcome removing the
		// basename fallback was meant to avoid. The path must also be reported,
		// or the one signal telling the operator to add a root is swallowed by a
		// cache hit.
		const cache = new SessionProjectCache();
		cache.set(`key-1:${SESSION_UUID}`, "repoA");
		const resolved = resolveProject(
			"POST",
			"/v1/messages",
			new Headers(),
			{
				system: "Working directory: /workspace/repoB\n",
				messages: [{ role: "user", content: "hi" }],
				metadata: { user_id: encodeUserId(SESSION_UUID) },
			},
			"key-1",
			cache,
		);
		expect(resolved).toEqual({
			project: null,
			source: "none",
			sessionKey: `key-1:${SESSION_UUID}`,
			unmatchedPath: "/workspace/repoB",
		});
	});

	it("still inherits for a request that carried no working directory at all", () => {
		// The case inheritance exists for: sidechains, title generation. Blocking
		// it here would break the tier, not protect anything.
		const cache = new SessionProjectCache();
		cache.set(`key-1:${SESSION_UUID}`, "repoA");
		const resolved = resolveProject(
			"POST",
			"/v1/messages",
			new Headers(),
			signalLessBody,
			"key-1",
			cache,
		);
		expect(resolved).toEqual({
			project: "repoA",
			source: "session_inherited",
			sessionKey: `key-1:${SESSION_UUID}`,
		});
	});

	it("anchored signal wins, reports sessionKey, and does NOT write the cache", () => {
		const cache = new SessionProjectCache();
		const resolved = resolveProject(
			"POST",
			"/v1/messages",
			new Headers(),
			anchoredBody,
			"key-1",
			cache,
		);
		expect(resolved).toEqual({
			project: "clankermux",
			source: "wd_primary",
			sessionKey: `key-1:${SESSION_UUID}`,
		});
		expect(cache.size()).toBe(0);
	});

	it("inherits from a pre-seeded cache when no anchored signal exists", () => {
		const cache = new SessionProjectCache();
		cache.set(`key-1:${SESSION_UUID}`, "clankermux");
		const resolved = resolveProject(
			"POST",
			"/v1/messages",
			new Headers(),
			signalLessBody,
			"key-1",
			cache,
		);
		expect(resolved).toEqual({
			project: "clankermux",
			source: "session_inherited",
			sessionKey: `key-1:${SESSION_UUID}`,
		});
	});

	it("returns all-null project/source when no session metadata and no anchor", () => {
		const cache = new SessionProjectCache();
		const resolved = resolveProject(
			"POST",
			"/v1/messages",
			new Headers(),
			{ messages: [{ role: "user", content: "hi" }] },
			"key-1",
			cache,
		);
		expect(resolved).toEqual({
			project: null,
			source: "none",
			sessionKey: null,
		});
	});

	it("scopes sessionKey to 'anon' when apiKeyId is null", () => {
		const cache = new SessionProjectCache();
		const resolved = resolveProject(
			"POST",
			"/v1/messages",
			new Headers(),
			anchoredBody,
			null,
			cache,
		);
		expect(resolved.sessionKey).toBe(`anon:${SESSION_UUID}`);
	});

	it("count_tokens path is eligible for anchored extraction", () => {
		const cache = new SessionProjectCache();
		const resolved = resolveProject(
			"POST",
			"/v1/messages/count_tokens",
			new Headers(),
			anchoredBody,
			"key-1",
			cache,
		);
		expect(resolved.project).toBe("clankermux");
		expect(resolved.source).toBe("wd_primary");
	});

	it("count_tokens path is eligible for inheritance", () => {
		const cache = new SessionProjectCache();
		cache.set(`key-1:${SESSION_UUID}`, "clankermux");
		const resolved = resolveProject(
			"POST",
			"/v1/messages/count_tokens",
			new Headers(),
			signalLessBody,
			"key-1",
			cache,
		);
		expect(resolved).toEqual({
			project: "clankermux",
			source: "session_inherited",
			sessionKey: `key-1:${SESSION_UUID}`,
		});
	});

	it("GET requests return all-null and never touch the cache", () => {
		const cache = new SessionProjectCache();
		cache.set(`key-1:${SESSION_UUID}`, "clankermux");
		const resolved = resolveProject(
			"GET",
			"/v1/messages",
			new Headers(),
			anchoredBody,
			"key-1",
			cache,
		);
		expect(resolved).toEqual({ project: null, source: null, sessionKey: null });
		expect(cache.size()).toBe(1);
	});

	it("unrelated paths return all-null and never touch the cache", () => {
		const cache = new SessionProjectCache();
		cache.set(`key-1:${SESSION_UUID}`, "clankermux");
		const resolved = resolveProject(
			"POST",
			"/v1/complete",
			new Headers(),
			anchoredBody,
			"key-1",
			cache,
		);
		expect(resolved).toEqual({ project: null, source: null, sessionKey: null });
		expect(cache.size()).toBe(1);
	});

	it("does not inherit across apiKeyId boundaries for the same session id", () => {
		const cache = new SessionProjectCache();
		cache.set(`key-1:${SESSION_UUID}`, "clankermux");
		const resolved = resolveProject(
			"POST",
			"/v1/messages",
			new Headers(),
			signalLessBody,
			"key-2",
			cache,
		);
		expect(resolved).toEqual({
			project: null,
			source: "none",
			sessionKey: `key-2:${SESSION_UUID}`,
		});
	});

	it("reports source 'none' for an eligible signal-less request with a cold session", () => {
		const cache = new SessionProjectCache();
		const resolved = resolveProject(
			"POST",
			"/v1/messages",
			new Headers(),
			signalLessBody,
			"key-1",
			cache,
		);
		expect(resolved).toEqual({
			project: null,
			source: "none",
			sessionKey: `key-1:${SESSION_UUID}`,
		});
	});

	it("reports session_ambiguous (and no project) for a conflicted session", () => {
		const cache = new SessionProjectCache();
		cache.set(`key-1:${SESSION_UUID}`, "octi");
		cache.set(`key-1:${SESSION_UUID}`, "clankermux");

		const resolved = resolveProject(
			"POST",
			"/v1/messages",
			new Headers(),
			signalLessBody,
			"key-1",
			cache,
		);
		expect(resolved).toEqual({
			project: null,
			source: "session_ambiguous",
			sessionKey: `key-1:${SESSION_UUID}`,
		});
	});

	it("an anchored signal still wins over an ambiguous session", () => {
		const cache = new SessionProjectCache();
		cache.set(`key-1:${SESSION_UUID}`, "octi");
		cache.set(`key-1:${SESSION_UUID}`, "clankermux");

		const resolved = resolveProject(
			"POST",
			"/v1/messages",
			new Headers(),
			anchoredBody,
			"key-1",
			cache,
		);
		expect(resolved).toEqual({
			project: "clankermux",
			source: "wd_primary",
			sessionKey: `key-1:${SESSION_UUID}`,
		});
	});

	it("marks a session that transitions projects ambiguous (seed A → inherit A → seed B)", () => {
		const cache = new SessionProjectCache();
		const headers = new Headers();
		const projectABody: RequestJsonBody = {
			...anchoredBody,
			system: "# Environment\nPrimary working directory: /home/darken/octi\n",
		};

		// Seed A: anchored resolve, caller commits the seed post-validation.
		const seedA = resolveProject(
			"POST",
			"/v1/messages",
			headers,
			projectABody,
			"key-1",
			cache,
		);
		expect(seedA.project).toBe("octi");
		expect(seedA.sessionKey).not.toBeNull();
		expect(
			cache.set(seedA.sessionKey as string, seedA.project as string),
		).toBeNull();

		// Inherit A on a signal-less sidechain request.
		expect(
			resolveProject(
				"POST",
				"/v1/messages",
				headers,
				signalLessBody,
				"key-1",
				cache,
			).project,
		).toBe("octi");

		// Seed B: the session moved to another project; set() reports A.
		const seedB = resolveProject(
			"POST",
			"/v1/messages",
			headers,
			anchoredBody,
			"key-1",
			cache,
		);
		expect(seedB.project).toBe("clankermux");
		expect(cache.set(seedB.sessionKey as string, seedB.project as string)).toBe(
			"octi",
		);

		// The conflicting seed makes the session ambiguous: nothing is inherited
		// until the ambiguity window decays (see SessionProjectCache).
		expect(
			resolveProject(
				"POST",
				"/v1/messages",
				headers,
				signalLessBody,
				"key-1",
				cache,
			),
		).toEqual({
			project: null,
			source: "session_ambiguous",
			sessionKey: `key-1:${SESSION_UUID}`,
		});
	});
});

describe("isAnchoredSource", () => {
	it("accepts every tier-1..3 source", () => {
		expect(isAnchoredSource("header")).toBe(true);
		expect(isAnchoredSource("wd_primary")).toBe(true);
		expect(isAnchoredSource("wd_plain")).toBe(true);
		expect(isAnchoredSource("codex_cwd")).toBe(true);
	});

	it("rejects inherited, ambiguous, none and the ineligible null", () => {
		expect(isAnchoredSource("session_inherited")).toBe(false);
		expect(isAnchoredSource("session_ambiguous")).toBe(false);
		expect(isAnchoredSource("none")).toBe(false);
		expect(isAnchoredSource(null)).toBe(false);
	});
});
