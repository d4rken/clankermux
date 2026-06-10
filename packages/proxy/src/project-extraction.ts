import { sanitizeProjectName } from "./project-name";
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
	const sanitized = sanitizeProjectName(raw);
	if (!sanitized) return null;
	// Dot-leading names are hidden/infra dirs (.claude, .config), never a
	// project the user would recognize.
	if (sanitized.startsWith(".")) return null;
	return sanitized;
}

export function mapWorkingDirToProject(wd: string): string | null {
	const segments = wd.split("/").filter((segment) => segment.length > 0);
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

function stripSurroundingQuotes(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' || first === "'") && first === last) {
			return value.slice(1, -1);
		}
	}
	return value;
}

function projectFromLabelMatch(match: RegExpMatchArray | null): string | null {
	const captured = match?.[1]?.trim();
	if (!captured) return null;
	return mapWorkingDirToProject(stripSurroundingQuotes(captured));
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

export function extractProjectFromBody(
	body: RequestJsonBody | null,
): string | null {
	if (!body) return null;

	// Tier 2: anchored working-directory labels in the system prompt.
	const systemPrompt = extractSystemPrompt(body);
	if (systemPrompt) {
		const primary = projectFromLabelMatch(
			systemPrompt.match(PRIMARY_WORKING_DIR_RE),
		);
		if (primary) return primary;

		const plain = projectFromLabelMatch(systemPrompt.match(WORKING_DIR_RE));
		if (plain) return plain;
	}

	// Tier 3: codex <cwd> tag — first user message only, never the rest of
	// the conversation, and only the head of each text chunk.
	for (const text of collectFirstUserMessageTexts(body)) {
		const match = text.slice(0, CWD_SCAN_MAX_CHARS).match(CODEX_CWD_RE);
		if (match?.[1]) {
			const project = mapWorkingDirToProject(match[1].trim());
			if (project) return project;
		}
	}

	return null;
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
): string | null {
	if (method !== "POST" || !PROJECT_ELIGIBLE_PATHS.has(path)) return null;

	// Tier 1: explicit header.
	const headerProject = normalizeProjectCandidate(headers.get("x-project"));
	if (headerProject) return headerProject;

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

export interface ResolvedProject {
	project: string | null;
	source: "anchored" | "inherited" | null;
	sessionKey: string | null;
}

/**
 * Full project resolution: anchored tiers 1–3 first, then tier-4 session
 * inheritance from `cache`. READ-ONLY with respect to the cache (a hit only
 * refreshes LRU recency) — the caller commits anchored seeds after request
 * validation so invalid, 400-rejected bodies never poison the cache.
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
	if (anchored) {
		return { project: anchored, source: "anchored", sessionKey };
	}

	if (sessionKey) {
		const inherited = cache.get(sessionKey);
		if (inherited) {
			return { project: inherited, source: "inherited", sessionKey };
		}
	}

	return { project: null, source: null, sessionKey };
}
