import type { ProjectAttributionSource } from "@clankermux/types";
import {
	exceedsProjectNameLimit,
	sanitizeProjectName,
	stripEnvMarkerTrailer,
} from "./project-name";
import type { RequestJsonBody } from "./request-body-context";
import type { SessionProjectCache } from "./session-project-cache";

/**
 * Tiered project-name extraction for routing affinity:
 *
 *   1. `x-project` header (explicit client opt-in, highest priority)
 *   2. Anchored working-directory labels in the system prompt
 *      ("Primary working directory:" wins over plain "Working directory:")
 *   3. Codex-style `<cwd>…</cwd>` tag in the FIRST user message only
 *   4. Session inheritance: requests with no anchored signal (Claude Code
 *      sidechains, title generation, count_tokens) inherit the project last
 *      anchored by the same Claude Code session (`metadata.user_id` →
 *      `session_id`, scoped per API key). `resolveProject` only READS the
 *      session cache — anchored seeds are committed by the caller AFTER
 *      request validation, so 400-rejected bodies can't poison the cache.
 *      A session that has seeded CONFLICTING projects is reported as
 *      `session_ambiguous` and inherits nothing (see session-project-cache).
 *
 * Every entry point reports WHICH tier fired alongside the project, so the
 * attribution can be audited after the fact instead of being guessed from the
 * project name (see `ProjectAttributionSource`).
 *
 * Each tier maps the captured path to a project name via
 * `mapWorkingDirToProject` and normalizes it; `null` means "unknown project"
 * and the caller falls back to non-project routing. There is deliberately no
 * "first absolute path anywhere" or markdown-H1 fallback — both produced
 * false positives (e.g. `.claude` memory paths, harness headings).
 */

// Line-anchored, case-sensitive label regexes. Pass 1 (Primary) runs to
// completion before pass 2; the lowercase "working" in "Primary working
// directory" keeps it from also matching the plain pass. Non-global,
// no nested quantifiers — linear-time per call (ReDoS-safe).
const PRIMARY_WORKING_DIR_RE = /^.*\bPrimary working directory\s*:\s*(.+)$/m;
const WORKING_DIR_RE = /^.*\bWorking directory\s*:\s*(.+)$/m;

// Codex environment context: <cwd>/path/to/project</cwd>
const CODEX_CWD_RE = /<cwd>([^<]+)<\/cwd>/;

// Per-chunk scan budget for the tier-3 user-message search.
const CWD_SCAN_MAX_CHARS = 4096;

/**
 * Guard against prompt text reaching the project name.
 *
 * `WORKING_DIR_RE` captures to end of line and `CODEX_CWD_RE` captures across
 * newlines, so whatever the client wrote after the label is captured with the
 * path. The project is NOT display-only — it is persisted, offered as a
 * dashboard filter, used as a load-balancer affinity partition key, and seeds
 * the session project cache (where a conflicting seed withholds the project for
 * the rest of the window) — so a rejected capture returns `null` and seeds
 * nothing rather than being cleaned up into something plausible.
 *
 * Three rules, applied to the raw capture before `sanitizeProjectName` sees it:
 *
 *  a. Trim boundary whitespace, THEN reject any remaining ASCII control char.
 *     Order matters both ways: checking before `sanitizeProjectName` strips
 *     them is what stops `repo\nLEAKED sk-…` fusing into `repoLEAKED sk-…`, and
 *     trimming first is what keeps a pretty-printed `<cwd>\n/home/u/repo\n</cwd>`
 *     working.
 *  b. Reject — never truncate — a candidate over `PROJECT_NAME_MAX_LEN`
 *     (enforced in `normalizeProjectCandidate`, which also covers the
 *     `x-project` header). Truncation is the mechanism that manufactured
 *     plausible names out of prompt tails.
 *  c. Reject whitespace in an UNQUOTED capture, allow it when the capture was
 *     quoted. An unquoted path containing spaces is indistinguishable from a
 *     path followed by same-line prose, so no heuristic can separate them;
 *     quoting removes the ambiguity. One exception, applied first: a recognized
 *     Claude Code env-marker trailer is stripped, because that marker is an
 *     anchor that says where the path ends (clients that collapse the prompt's
 *     newlines put the whole env block on the label's line). Prose with no such
 *     marker is untouched and still rejected.
 *
 * Deliberately NOT rules: a word-count cap and a secret-token-shape regex. Both
 * misfired in both directions — `ignore prior instructions` is four words and a
 * `token=` prefix defeats an anchored token regex, while the legitimate repo
 * name `2026-client-migration-dashboard` reads as a secret. The residual is
 * that a whitespace-free single token still passes; it is bounded and cannot
 * carry prose.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting them is the point
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;
const WHITESPACE_RE = /\s/;

// Windows paths: `C:\Users\Alice\myproj` and `\\server\share\myproj`. Without
// the separator swap the whole string is a single segment, so the entire path —
// user name included — became the project.
const WINDOWS_DRIVE_PREFIX_RE = /^[A-Za-z]:/;
const UNC_HOST_PREFIX_RE = /^\/\/[^/]+/;

// Common "container" directories directly under /home/<user> or
// /Users/<user> that hold projects rather than being projects themselves.
const HOME_CONTAINER_DIRS = new Set([
	"Desktop",
	"projects",
	"repos",
	"src",
	"git_repos",
]);

export function normalizeProjectCandidate(
	raw: string | undefined | null,
): string | null {
	// Rule (b): an over-long candidate is refused, not sliced to fit.
	if (exceedsProjectNameLimit(raw)) return null;
	const sanitized = sanitizeProjectName(raw);
	if (!sanitized) return null;
	// Dot-leading names are hidden/infra dirs (.claude, .config), never a
	// project the user would recognize.
	if (sanitized.startsWith(".")) return null;
	return sanitized;
}

export function mapWorkingDirToProject(wd: string): string | null {
	// Rule (d): normalize Windows separators and drop a drive/UNC-host prefix so
	// the segment walk below sees the same shape it does on POSIX.
	const normalized = wd
		.replace(/\\/g, "/")
		.replace(WINDOWS_DRIVE_PREFIX_RE, "")
		.replace(UNC_HOST_PREFIX_RE, "");
	const segments = normalized
		.split("/")
		.filter((segment) => segment.length > 0);
	if (segments.length === 0) return null;

	let candidate: string | null;
	if (segments[0] === "home" || segments[0] === "Users") {
		// Drop the /home (or /Users) prefix and the user segment, then skip
		// consecutive container dirs; the next segment is the project root.
		let index = 2;
		while (
			index < segments.length &&
			HOME_CONTAINER_DIRS.has(segments[index])
		) {
			index++;
		}
		candidate = index < segments.length ? segments[index] : null;
	} else {
		// Non-home paths (/workspace, /srv/data/myproj): use the basename.
		candidate = segments[segments.length - 1];
	}

	return normalizeProjectCandidate(candidate);
}

function extractSystemPrompt(body: RequestJsonBody | null): string | null {
	if (!body) return null;
	const system = body.system;

	if (typeof system === "string") {
		return system;
	}

	if (Array.isArray(system)) {
		return system
			.filter(
				(item): item is { type?: string; text: string } =>
					typeof item === "object" &&
					item !== null &&
					(item as { type?: string }).type === "text" &&
					typeof (item as { text?: unknown }).text === "string",
			)
			.map((item) => item.text)
			.join("\n");
	}

	return null;
}

function stripSurroundingQuotes(value: string): {
	value: string;
	quoted: boolean;
} {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' || first === "'") && first === last) {
			return { value: value.slice(1, -1), quoted: true };
		}
	}
	return { value, quoted: false };
}

/**
 * Turn a raw working-directory capture into a project name, applying rules
 * (a) and (c) of the guard documented above. Returns `null` for anything that
 * carries prompt text rather than a path.
 */
function projectFromCapture(raw: string | undefined): string | null {
	if (raw === undefined) return null;

	// (a) Trim first, then reject on what is LEFT — boundary newlines are
	// formatting, embedded ones are two different pieces of text.
	const trimmed = raw.trim();
	if (!trimmed || CONTROL_CHAR_RE.test(trimmed)) return null;

	let { value, quoted } = stripSurroundingQuotes(trimmed);
	if (!quoted) {
		// A client that collapses the newlines out of its system prompt puts the
		// whole environment block on the label's line. An ANCHORED, recognized
		// marker says where the path ends, so the trailer is dropped before rule
		// (c) runs — the only case in which relaxing the whitespace test is safe.
		// A capture with no recognized marker comes back unchanged and is still
		// rejected below.
		//
		// The quote test is then RE-RUN: with the trailer sitting outside the
		// closing quote the capture as a whole does not look quoted, and rule
		// (c)'s guarantee — quoting makes a spaced path work — has to survive a
		// flattened block.
		({ value, quoted } = stripSurroundingQuotes(stripEnvMarkerTrailer(value)));
	}
	if (!value) return null;
	// (c) Only a quoted capture may contain whitespace.
	if (!quoted && WHITESPACE_RE.test(value)) return null;

	return mapWorkingDirToProject(value);
}

function projectFromLabelMatch(match: RegExpMatchArray | null): string | null {
	return projectFromCapture(match?.[1]);
}

function collectFirstUserMessageTexts(body: RequestJsonBody): string[] {
	const messages = body.messages;
	if (!Array.isArray(messages)) return [];

	const firstUser = messages.find(
		(message): message is { role: string; content: unknown } =>
			typeof message === "object" &&
			message !== null &&
			(message as { role?: unknown }).role === "user",
	);
	if (!firstUser) return [];

	const content = firstUser.content;
	if (typeof content === "string") return [content];
	if (Array.isArray(content)) {
		return content
			.filter(
				(block): block is { type?: string; text: string } =>
					typeof block === "object" &&
					block !== null &&
					(block as { type?: string }).type === "text" &&
					typeof (block as { text?: unknown }).text === "string",
			)
			.map((block) => block.text);
	}
	return [];
}

/** Sources a body-only extraction can report (tiers 2–3, or nothing). */
export type BodyProjectSource = Extract<
	ProjectAttributionSource,
	"wd_primary" | "wd_plain" | "codex_cwd" | "none"
>;

/** Sources a full request extraction can report (tiers 1–3, or nothing). */
export type RequestProjectSource = BodyProjectSource | "header";

const NO_BODY_PROJECT = { project: null, source: "none" } as const;

export function extractProjectFromBody(body: RequestJsonBody | null): {
	project: string | null;
	source: BodyProjectSource;
} {
	if (!body) return NO_BODY_PROJECT;

	// Tier 2: anchored working-directory labels in the system prompt.
	const systemPrompt = extractSystemPrompt(body);
	if (systemPrompt) {
		const primary = projectFromLabelMatch(
			systemPrompt.match(PRIMARY_WORKING_DIR_RE),
		);
		if (primary) return { project: primary, source: "wd_primary" };

		const plain = projectFromLabelMatch(systemPrompt.match(WORKING_DIR_RE));
		if (plain) return { project: plain, source: "wd_plain" };
	}

	// Tier 3: codex <cwd> tag — first user message only, never the rest of
	// the conversation, and only the head of each text chunk.
	for (const text of collectFirstUserMessageTexts(body)) {
		const match = text.slice(0, CWD_SCAN_MAX_CHARS).match(CODEX_CWD_RE);
		const project = projectFromCapture(match?.[1]);
		if (project) return { project, source: "codex_cwd" };
	}

	return NO_BODY_PROJECT;
}

// Paths eligible for project attribution (anchored tiers AND session
// inheritance). count_tokens shares the session's body shape and metadata.
const PROJECT_ELIGIBLE_PATHS = new Set([
	"/v1/messages",
	"/v1/messages/count_tokens",
]);

// Defensive bound on session_id (real Claude Code session ids are UUIDs).
const SESSION_ID_MAX_LENGTH = 64;

export function extractProjectFromRequest(
	method: string,
	path: string,
	headers: Headers,
	body: RequestJsonBody | null,
): { project: string | null; source: RequestProjectSource } {
	if (method !== "POST" || !PROJECT_ELIGIBLE_PATHS.has(path)) {
		return NO_BODY_PROJECT;
	}

	// Tier 1: explicit header.
	const headerProject = normalizeProjectCandidate(headers.get("x-project"));
	if (headerProject) return { project: headerProject, source: "header" };

	return extractProjectFromBody(body);
}

/**
 * Pull the Claude Code session id out of `body.metadata.user_id`, which is a
 * JSON-encoded STRING like
 * `{"device_id":"…","account_uuid":"","session_id":"<uuid>"}`.
 * Returns null for anything malformed, empty, or implausibly long.
 */
export function extractSessionId(body: RequestJsonBody | null): string | null {
	const metadata = body?.metadata;
	if (typeof metadata !== "object" || metadata === null) return null;

	const userId = (metadata as { user_id?: unknown }).user_id;
	if (typeof userId !== "string") return null;

	try {
		const parsed: unknown = JSON.parse(userId);
		if (typeof parsed !== "object" || parsed === null) return null;

		const sessionId = (parsed as { session_id?: unknown }).session_id;
		if (typeof sessionId !== "string") return null;

		const trimmed = sessionId.trim();
		if (trimmed.length === 0 || trimmed.length > SESSION_ID_MAX_LENGTH) {
			return null;
		}
		return trimmed;
	} catch {
		return null;
	}
}

/** The tiers that come from the request itself rather than session history. */
export type AnchoredProjectSource = Extract<
	ProjectAttributionSource,
	"header" | "wd_primary" | "wd_plain" | "codex_cwd"
>;

const ANCHORED_SOURCES: ReadonlySet<string> = new Set<AnchoredProjectSource>([
	"header",
	"wd_primary",
	"wd_plain",
	"codex_cwd",
]);

/**
 * True for the tiers whose project came from THIS request (header, working-dir
 * label, codex cwd). Only an anchored resolution may seed the session cache —
 * seeding from an inherited value would let one mis-attribution self-perpetuate.
 */
export function isAnchoredSource(
	source: ProjectAttributionSource | null,
): source is AnchoredProjectSource {
	return source !== null && ANCHORED_SOURCES.has(source);
}

/**
 * Outcome of {@link resolveProject}. Discriminated on `source` so an
 * "attributed to a project but the project is null" state is unrepresentable:
 *
 *  - `source: null` — the request was never ELIGIBLE for attribution (non-POST,
 *    or a path outside PROJECT_ELIGIBLE_PATHS). Persisted as NULL.
 *  - `source: "none" | "session_ambiguous"` — eligible, but no project: either
 *    no tier fired, or the session's history is conflicted and was withheld.
 *  - anything else — a project was resolved and is non-null.
 */
export type ResolvedProject =
	| { source: null; project: null; sessionKey: string | null }
	| {
			source: "none" | "session_ambiguous";
			project: null;
			sessionKey: string | null;
	  }
	| {
			source: Exclude<ProjectAttributionSource, "none" | "session_ambiguous">;
			project: string;
			sessionKey: string | null;
	  };

/**
 * Full project resolution: anchored tiers 1–3 first, then tier-4 session
 * inheritance from `cache`. READ-ONLY with respect to the cache (a hit only
 * refreshes LRU recency) — the caller commits anchored seeds after request
 * validation so invalid, 400-rejected bodies never poison the cache.
 *
 * A session the cache has flagged AMBIGUOUS (it seeded conflicting projects)
 * yields `session_ambiguous` with a null project: the request is recorded as
 * un-attributable rather than being given a coin-flip project.
 */
export function resolveProject(
	method: string,
	path: string,
	headers: Headers,
	body: RequestJsonBody | null,
	apiKeyId: string | null,
	cache: SessionProjectCache,
): ResolvedProject {
	if (method !== "POST" || !PROJECT_ELIGIBLE_PATHS.has(path)) {
		return { project: null, source: null, sessionKey: null };
	}

	const sessionId = extractSessionId(body);
	const sessionKey = sessionId ? `${apiKeyId ?? "anon"}:${sessionId}` : null;

	const anchored = extractProjectFromRequest(method, path, headers, body);
	if (anchored.project !== null && anchored.source !== "none") {
		return { project: anchored.project, source: anchored.source, sessionKey };
	}

	if (sessionKey) {
		const inherited = cache.lookup(sessionKey);
		if (inherited.ambiguous) {
			return { project: null, source: "session_ambiguous", sessionKey };
		}
		if (inherited.project !== null) {
			return {
				project: inherited.project,
				source: "session_inherited",
				sessionKey,
			};
		}
	}

	return { project: null, source: "none", sessionKey };
}
