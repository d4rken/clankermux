import type { ProjectAttributionSource, ProjectRules } from "@clankermux/types";
import {
	exceedsProjectNameLimit,
	PROJECT_NAME_MAX_LEN,
	sanitizeProjectName,
} from "./project-name";
import {
	isUsableWorkingDir,
	resolveConfiguredProject,
} from "./project-path-match";
import {
	ANCHOR_SCAN_MAX_CHARS,
	extractRepoRoot,
	repoRootToCandidate,
} from "./repo-root-anchor";
import type { RequestJsonBody } from "./request-body-context";
import type { SessionProjectCache } from "./session-project-cache";

/**
 * Tiered project-name extraction for routing affinity:
 *
 *   1. `x-project` header (explicit client opt-in, highest priority)
 *   2. An operator-configured path override (see `ProjectRules`) matching the
 *      working directory the request claims. Never second-guessed: the
 *      configured name is used verbatim, dot-leading rejection included.
 *   3. The repository root named by the client's own instruction files
 *      (see repo-root-anchor.ts), validated as an ancestor of that working
 *      directory. Outranks the folder walk because it READ the root rather
 *      than deducing which path segment was likely to be one.
 *   4. The operator-configured project roots applied to the working directory,
 *      which comes from an anchored label in the system prompt ("Primary
 *      working directory:" wins over plain "Working directory:") or from a
 *      Codex-style `<cwd>…</cwd>` tag in the FIRST user message only. The
 *      recorded source says which of those supplied the path.
 *   5. Session inheritance: requests with no anchored signal (Claude Code
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
 *     quoting removes the ambiguity.
 *
 * Deliberately NOT rules: a word-count cap and a secret-token-shape regex. Both
 * misfired in both directions — `ignore prior instructions` is four words and a
 * `token=` prefix defeats an anchored token regex, while the legitimate repo
 * name `2026-client-migration-dashboard` reads as a secret. The residual is
 * that a whitespace-free single token still passes; it is bounded and cannot
 * carry prose.
 *
 * ACCEPTED CONSEQUENCE — do not "fix" this. A client that collapses the
 * newlines out of its system prompt puts the whole environment block on the
 * label's line, and rule (c) then rejects it:
 *
 *   "Working directory: /home/darken/clankermux Is directory a git repo: Yes"
 *     -> null   (the newline-separated form still resolves; the label regexes
 *                are line-anchored, so the block never enters the capture)
 *
 * Stripping a recognized env-marker trailer before rule (c) was tried and
 * removed. Every variant of it misattributed instead: the marker words are
 * matched case-insensitively, so `/workspace/model/repo` truncated to
 * `workspace`; requiring whitespace before the marker fixed that but then a
 * quoted path with a marker-named directory — `"/workspace/Data Platform/repo"
 * Shell: bash` — truncated to `Data`. Nothing separates "trailer" from
 * "directory named like a marker" inside a capture we did not tokenize.
 *
 * The invariant is therefore: CORRECT, OR NOTHING, NEVER WRONG. A null falls
 * through to session inheritance and costs one request's attribution; a wrong
 * project merges two codebases into one load-balancer affinity partition and
 * mislabels their telemetry until someone notices.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting them is the point
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;
const WHITESPACE_RE = /\s/;

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

/**
 * Normalize a name the OPERATOR configured, rather than one we inferred.
 *
 * Same cleanup and same length cap as {@link normalizeProjectCandidate}, minus
 * the dot-leading rejection. That rejection exists to stop a session that
 * happens to sit in an infrastructure directory from being labelled with it;
 * it has no business overruling an operator who wrote the mapping by hand.
 */
export function normalizeConfiguredName(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	// Length and control characters only. Emphatically NOT sanitizeProjectName:
	// that strips a trailing run starting at "Platform", "Shell", "Model" and
	// friends, which exists to clean up a name SCRAPED out of a Claude Code
	// environment block. Applied to a name the operator typed it silently
	// mangles legitimate ones — `Acme Platform` becomes `Acme`, and `model`
	// becomes null — which is the opposite of the guarantee this tier makes.
	if (CONTROL_CHAR_RE.test(trimmed)) return null;
	if (trimmed.length > PROJECT_NAME_MAX_LEN) return null;
	return trimmed;
}

/**
 * Map a working directory to a project using the operator's configured roots.
 *
 * Returns null for a path no root matches. That is the whole point: the
 * previous implementation fell back to the BASENAME for any path outside
 * `/home` or `/Users`, which turned every subdirectory of a repository into
 * its own project and fed that name straight into the load balancer's affinity
 * partition key. An unknown layout is now reported as unknown so the operator
 * can name it, instead of being guessed at.
 */
export function mapWorkingDirToProject(
	wd: string,
	rules: ProjectRules,
): string | null {
	const resolved = resolveConfiguredProject(wd, rules);
	if (!resolved) return null;
	if (resolved.kind === "override") {
		return normalizeConfiguredName(resolved.name);
	}
	return normalizeProjectCandidate(resolved.segment);
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
 * Turn a raw working-directory capture into a trustworthy PATH, applying rules
 * (a) and (c) of the guard documented above. Returns `null` for anything that
 * carries prompt text rather than a path.
 *
 * Stops at the path rather than continuing to a project name, because two
 * later tiers need the path itself: the override list matches against it, and
 * the repository-root anchor is only trusted when it is an ancestor of it.
 */
function pathFromCapture(raw: string | undefined): string | null {
	if (raw === undefined) return null;

	// (a) Trim first, then reject on what is LEFT — boundary newlines are
	// formatting, embedded ones are two different pieces of text.
	const trimmed = raw.trim();
	if (!trimmed || CONTROL_CHAR_RE.test(trimmed)) return null;

	const { value, quoted } = stripSurroundingQuotes(trimmed);
	if (!value) return null;
	// (c) Only a quoted capture may contain whitespace.
	if (!quoted && WHITESPACE_RE.test(value)) return null;

	// (e) It has to be a path: absolute, and with no unresolved `.`/`..`. This
	// is what keeps a prompt fragment out of the rules engine entirely — a bare
	// `token=sk-…` or a relative `home/u/repo` would otherwise be matched
	// against the roots AND, when nothing matched, recorded as an "unmatched
	// path" and shown in the dashboard.
	if (!isUsableWorkingDir(value)) return null;

	return value;
}

function pathFromLabelMatch(match: RegExpMatchArray | null): string | null {
	return pathFromCapture(match?.[1]);
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

/** Sources a body-only extraction can report (tiers 2–5, or nothing). */
export type BodyProjectSource = Extract<
	ProjectAttributionSource,
	| "path_override"
	| "repo_root"
	| "wd_primary"
	| "wd_plain"
	| "codex_cwd"
	| "none"
>;

/** Sources a full request extraction can report (tiers 1–5, or nothing). */
export type RequestProjectSource = BodyProjectSource | "header";

const NO_BODY_PROJECT = { project: null, source: "none" } as const;

/** Which signal produced a candidate working directory. */
type WorkingDirSource = Extract<
	ProjectAttributionSource,
	"wd_primary" | "wd_plain" | "codex_cwd"
>;

interface WorkingDirCandidate {
	path: string;
	source: WorkingDirSource;
}

/**
 * Every working directory the body claims, most trustworthy first.
 *
 * A LIST rather than a single value because the tiers below can decline a
 * path — an unconfigured layout, a name that fails normalization — and the
 * next signal deserves its turn. The previous implementation got this for free
 * by falling through from the "Primary working directory" label to the plain
 * one when the first produced no name; keeping the candidates ordered
 * preserves that without special-casing it.
 */
function collectWorkingDirCandidates(
	body: RequestJsonBody,
): WorkingDirCandidate[] {
	const candidates: WorkingDirCandidate[] = [];

	const systemPrompt = extractSystemPrompt(body);
	if (systemPrompt) {
		const primary = pathFromLabelMatch(
			systemPrompt.match(PRIMARY_WORKING_DIR_RE),
		);
		if (primary) candidates.push({ path: primary, source: "wd_primary" });

		const plain = pathFromLabelMatch(systemPrompt.match(WORKING_DIR_RE));
		if (plain) candidates.push({ path: plain, source: "wd_plain" });
	}

	// Codex `<cwd>` tag — first user message only, never the rest of the
	// conversation, and only the head of each text chunk.
	for (const text of collectFirstUserMessageTexts(body)) {
		const match = text.slice(0, CWD_SCAN_MAX_CHARS).match(CODEX_CWD_RE);
		const path = pathFromCapture(match?.[1]);
		if (path) {
			candidates.push({ path, source: "codex_cwd" });
			break;
		}
	}

	return candidates;
}

/**
 * The text the repository-root anchor scans: the whole system prompt (bounded
 * by the client) plus a capped head of the first user message, which is where
 * Claude Code puts the instruction-file contents.
 */
function collectAnchorText(body: RequestJsonBody): string {
	const parts: string[] = [];
	const systemPrompt = extractSystemPrompt(body);
	if (systemPrompt) parts.push(systemPrompt);

	// Per-chunk AND total budget. The per-chunk cap alone bounds nothing: the
	// first user message can carry an unbounded number of text blocks, and this
	// runs on every eligible request. Truncating is safe for the same reason the
	// per-chunk cap is (see repo-root-anchor: every instruction path in a
	// repository reduces to the same root).
	let budget = ANCHOR_SCAN_MAX_CHARS;
	for (const text of collectFirstUserMessageTexts(body)) {
		if (budget <= 0) break;
		const slice = text.slice(0, Math.min(budget, ANCHOR_SCAN_MAX_CHARS));
		parts.push(slice);
		budget -= slice.length;
	}
	return parts.join("\n");
}

/**
 * Tiers 2–5, in priority order, for each candidate working directory.
 *
 *   2  path override   what the operator stated; never second-guessed
 *   3  repo-root anchor what the client's own instruction files revealed
 *   4  configured roots what the layout implies
 *
 * The order is "explicit beats observed beats inferred". The anchor outranks
 * the roots walk because it read the repository root out of the request rather
 * than deducing which path segment was likely to be one; where they disagree
 * — a monorepo under a container directory nobody configured — the anchor is
 * the one that saw the answer.
 */
export function extractProjectFromBody(
	body: RequestJsonBody | null,
	rules: ProjectRules,
): {
	project: string | null;
	source: BodyProjectSource;
	/**
	 * The best working directory that produced no project, for the operator's
	 * "these paths matched no rule" list. Null when the body claimed no usable
	 * working directory at all, which is not an attribution gap but a request
	 * that never carried the signal.
	 */
	unmatchedPath?: string | null;
} {
	if (!body) return NO_BODY_PROJECT;

	const candidates = collectWorkingDirCandidates(body);
	if (candidates.length === 0) return NO_BODY_PROJECT;

	const anchorText = collectAnchorText(body);
	const resolved = candidates.map((candidate) => ({
		candidate,
		configured: resolveConfiguredProject(candidate.path, rules),
	}));

	// TIER-first, not candidate-first. Running every tier for the first
	// candidate before looking at the second would make the tier order local to
	// a candidate rather than global: an explicit override naming the plain
	// "Working directory" would lose to a mere roots match on the "Primary
	// working directory", which is the opposite of what the documented order
	// promises.

	// Tier 2: explicit override.
	for (const { configured } of resolved) {
		if (configured?.kind !== "override") continue;
		const name = normalizeConfiguredName(configured.name);
		if (name) return { project: name, source: "path_override" };
	}

	// Tier 3: repository root named by the client's instruction files, bounded
	// BELOW by the directory the roots walk already chose. It may only refine
	// that answer downwards — see rule 3 in repo-root-anchor. With no root match
	// there is no floor, so the anchor does not fire: an unbounded anchor is
	// steerable by anything that can write into the prompt.
	for (const { candidate, configured } of resolved) {
		if (configured?.kind !== "root") continue;
		const root = extractRepoRoot(
			anchorText,
			candidate.path,
			configured.projectDir,
		);
		if (!root) continue;
		const project = normalizeProjectCandidate(repoRootToCandidate(root));
		if (project) return { project, source: "repo_root" };
	}

	// Tier 4: the configured roots. Labelled by which signal supplied the path,
	// so the stored attribution still says where the path came from.
	for (const { candidate, configured } of resolved) {
		if (configured?.kind !== "root") continue;
		const project = normalizeProjectCandidate(configured.segment);
		if (project) return { project, source: candidate.source };
	}

	return { ...NO_BODY_PROJECT, unmatchedPath: candidates[0].path };
}

// Paths eligible for project attribution (anchored tiers AND session
// inheritance).
//
// count_tokens is listed because it is a per-session call that SHOULD carry
// the session's identity, not because it currently does. Claude Code 2.1.241
// sends `{model, messages, tools}` and nothing else on this path: no `system`,
// no `metadata`, and no session id in any header. Every anchored tier
// therefore finds nothing, `extractSessionId` has nothing to parse, and
// inheritance cannot fire — so in practice every count_tokens request is
// unattributed. Leave it eligible so a client that does send `metadata` is
// attributed, but do not expect this path to resolve.
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
	rules: ProjectRules,
): {
	project: string | null;
	source: RequestProjectSource;
	unmatchedPath?: string | null;
} {
	if (method !== "POST" || !PROJECT_ELIGIBLE_PATHS.has(path)) {
		return NO_BODY_PROJECT;
	}

	// Tier 1: explicit header.
	const headerProject = normalizeProjectCandidate(headers.get("x-project"));
	if (headerProject) return { project: headerProject, source: "header" };

	return extractProjectFromBody(body, rules);
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
	| "header"
	| "path_override"
	| "repo_root"
	| "wd_primary"
	| "wd_plain"
	| "codex_cwd"
>;

const ANCHORED_SOURCES: ReadonlySet<string> = new Set<AnchoredProjectSource>([
	"header",
	"path_override",
	"repo_root",
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
			/**
			 * A working directory that matched no rule, for the operator's
			 * "unattributed paths" list. Only set on `none`, and only when the
			 * request actually carried a path — a request with no working
			 * directory at all is not a configuration gap.
			 */
			unmatchedPath?: string | null;
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
	rules: ProjectRules,
): ResolvedProject {
	if (method !== "POST" || !PROJECT_ELIGIBLE_PATHS.has(path)) {
		return { project: null, source: null, sessionKey: null };
	}

	const sessionId = extractSessionId(body);
	const sessionKey = sessionId ? `${apiKeyId ?? "anon"}:${sessionId}` : null;

	const anchored = extractProjectFromRequest(
		method,
		path,
		headers,
		body,
		rules,
	);
	if (anchored.project !== null && anchored.source !== "none") {
		return { project: anchored.project, source: anchored.source, sessionKey };
	}

	// An explicit working directory that matched no rule BLOCKS inheritance.
	// The request said where it is; we just do not know that place. Inheriting
	// here would answer a question about directory B with the project of
	// directory A — a definite wrong project, and precisely the outcome
	// removing the basename fallback was meant to avoid. It also has to be
	// reported, or the one signal telling the operator to add a root is
	// swallowed by a cache hit.
	if (anchored.unmatchedPath) {
		return {
			project: null,
			source: "none",
			sessionKey,
			unmatchedPath: anchored.unmatchedPath,
		};
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

	// The key is present only when there is something to report. A request that
	// carried no working directory at all is not a configuration gap, and
	// stamping `unmatchedPath: null` on it would make every signal-less
	// count_tokens call look like one.
	return anchored.unmatchedPath
		? {
				project: null,
				source: "none",
				sessionKey,
				unmatchedPath: anchored.unmatchedPath,
			}
		: { project: null, source: "none", sessionKey };
}
