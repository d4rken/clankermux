import { isCodexClient } from "@clankermux/core";
import type { RequestAffinityScope } from "@clankermux/types";

function sanitizeAffinityHeader(value: string | null): string | null {
	if (!value) return null;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
	const sanitized = value.replace(/[\x00-\x1F\x7F]/g, "").trim();
	if (!sanitized) return null;
	return sanitized.slice(0, 128);
}

export function extractRequestAffinity(headers: Headers): {
	key: string | null;
	scope: RequestAffinityScope | null;
} {
	const claudeSession = sanitizeAffinityHeader(
		headers.get("x-claude-code-session-id"),
	);
	if (claudeSession) {
		return { key: claudeSession, scope: "claude_session" };
	}

	// Shared with harness detection deliberately. A client upgrade changed
	// `originator` from `codex_cli_rs` to `codex-tui`, which silently switched
	// Codex thread affinity off for two days; the literal living in two files is
	// what kept the second one from being fixed with the first.
	const codexThread = isCodexClient(headers)
		? sanitizeAffinityHeader(headers.get("thread-id"))
		: null;
	if (codexThread) {
		return { key: codexThread, scope: "codex_thread" };
	}

	return { key: null, scope: null };
}
