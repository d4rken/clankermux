import type { ClientApplication } from "@clankermux/types";

/** Longest inbound user-agent kept verbatim on the request row. */
const MAX_USER_AGENT_CHARS = 256;

/** Longest generic harness label derived from an unrecognized user-agent. */
const MAX_HARNESS_CHARS = 64;

/**
 * User-agents of the Codex client family: `codex-tui`, `codex_exec` and the
 * `codex_cli_rs` the `originator` header names are surfaces of ONE harness,
 * which is why the rule matches the family prefix and not a single surface.
 * Which surface sent a request stays recoverable from the stored
 * `client_user_agent`, so collapsing them here loses nothing.
 */
const CODEX_USER_AGENT = /^codex[-_]/i;

/** User-agents emitted by pi and its pi-coding-agent distribution. */
const PI_USER_AGENT = /^pi(?:-agent|-coding-agent)?(?:[/\s]|$)/i;

export interface HarnessDetection {
	/**
	 * The harness family this request's own headers name, or `null` when they
	 * name none. NEVER a guess: a stored `null` is what lets analytics tell
	 * "observed" apart from "inferred at query time".
	 */
	harness: string | null;
	/** The normalized inbound user-agent, or `null` when the request carried none. */
	userAgent: string | null;
}

/**
 * Normalize an inbound `user-agent` for storage: strip control characters, trim,
 * and cap the length. `null` for anything that normalizes to empty.
 *
 * The same treatment `sanitizeAffinityHeader` gives the affinity headers, with a
 * longer cap — a Claude Code user-agent already runs past 60 characters, and
 * this value is read by humans rather than matched exactly.
 */
export function normalizeClientUserAgent(raw: string | null): string | null {
	if (!raw) return null;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
	const sanitized = raw.replace(/[\x00-\x1F\x7F]/g, "").trim();
	if (!sanitized) return null;
	return sanitized.slice(0, MAX_USER_AGENT_CHARS);
}

/**
 * The harness label the detector emits for a client's DECLARED application.
 *
 * Exists so the declared and the detected vocabulary provably cannot drift: the
 * inference SQL uses `client_profiles.application` verbatim as a harness label,
 * and `harness.test.ts` asserts this map is the identity on every non-`generic`
 * member. `generic` maps to `null` because it declares nothing.
 */
export const HARNESS_LABEL_FOR_APPLICATION: Record<
	ClientApplication,
	string | null
> = {
	generic: null,
	"claude-code": "claude-code",
	codex: "codex",
	opencode: "opencode",
	"oh-my-pi": "oh-my-pi",
	pi: "pi",
};

/**
 * Did a client of the Codex family send this request?
 *
 * Both surfaces a Codex client announces itself on are matched against the same
 * family pattern. Pinning either one to a single literal is what this rule
 * exists to prevent: `originator` moved from `codex_cli_rs` to `codex-tui` in a
 * client upgrade, and every check written against the old literal went quietly
 * false for traffic that was still Codex.
 *
 * `originator` gets the same sanitizing pass as the user-agent so an inbound
 * header cannot smuggle control characters past the pattern.
 */
export function isCodexClient(headers: Headers): boolean {
	const userAgent = normalizeClientUserAgent(headers.get("user-agent"));
	if (userAgent !== null && CODEX_USER_AGENT.test(userAgent)) return true;
	const originator = normalizeClientUserAgent(headers.get("originator"));
	return originator !== null && CODEX_USER_AGENT.test(originator);
}

/**
 * Which agent harness is behind this request, read from its own headers.
 *
 * The rules run in order and stop at the first match. The last one is the point
 * of the whole function: an unrecognized client is labelled with what it calls
 * ITSELF (the leading user-agent token) rather than with a guess, so an
 * SDK-mediated client reports the SDK (`openai`) instead of silently joining
 * the unknown bucket.
 *
 * `codex` — not `codex-cli` — is deliberate: that is the spelling
 * `ClientApplication` uses, and two spellings for one harness would split a
 * correctly-configured Codex key across two analytics rows and fire the
 * declared/detected mismatch badge on every one of its requests.
 */
export function detectHarness(headers: Headers): HarnessDetection {
	const userAgent = normalizeClientUserAgent(headers.get("user-agent"));

	if (userAgent && /claude-cli\/\d/i.test(userAgent)) {
		return { harness: "claude-code", userAgent };
	}
	if (isCodexClient(headers)) {
		return { harness: "codex", userAgent };
	}
	if (userAgent && PI_USER_AGENT.test(userAgent)) {
		return { harness: "pi", userAgent };
	}
	if (userAgent?.startsWith("QwenCode/")) {
		return { harness: "qwen-code", userAgent };
	}
	if (userAgent) {
		const token = userAgent
			.split(/[/\s]/, 1)[0]
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "")
			.slice(0, MAX_HARNESS_CHARS);
		return { harness: token === "" ? null : token, userAgent };
	}
	return { harness: null, userAgent: null };
}
