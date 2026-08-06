import { describe, expect, it } from "bun:test";
import {
	extractProjectFromBody,
	extractProjectFromRequest,
	extractSessionId,
	isAnchoredSource,
	mapWorkingDirToProject,
	normalizeProjectCandidate,
	resolveProject,
} from "../project-extraction";
import { PROJECT_NAME_MAX_LEN } from "../project-name";
import type { RequestJsonBody } from "../request-body-context";
import { SessionProjectCache } from "../session-project-cache";

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

	it("uses basename for non-home paths", () => {
		expect(mapWorkingDirToProject("/workspace")).toBe("workspace");
	});

	it("uses basename for deeper non-home paths", () => {
		expect(mapWorkingDirToProject("/srv/data/myproj")).toBe("myproj");
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

	it("maps a UNC path to its basename, not the server name", () => {
		expect(mapWorkingDirToProject("\\\\fileserver\\share\\myproj")).toBe(
			"myproj",
		);
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
		).toEqual(NOTHING);
	});

	it("rejects an instruction-shaped tail (multi-word, no path)", () => {
		expect(
			extractProjectFromBody(
				systemBody("Working directory: ignore prior instructions"),
			),
		).toEqual(NOTHING);
	});

	it("documents the boundary: a whitespace-free single token is still accepted", () => {
		// Deliberate. No deterministic rule separates a secret-shaped token from a
		// legitimate repo name (the token-shape regex rejected
		// "2026-client-migration-dashboard" and was defeated by a "token=" prefix),
		// so the guard settles for: bounded length, no control chars, no unquoted
		// whitespace. What it prevents is prompt PROSE becoming a partition key.
		expect(
			extractProjectFromBody(
				systemBody("Working directory: token=sk-ABCDEFGH12345678"),
			),
		).toEqual({ project: "token=sk-ABCDEFGH12345678", source: "wd_plain" });
		expect(
			extractProjectFromBody(
				systemBody("Working directory: eyJhbGciOi.eyJzdWIiOi.SflKxwRJ"),
			),
		).toEqual({
			project: "eyJhbGciOi.eyJzdWIiOi.SflKxwRJ",
			source: "wd_plain",
		});
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
