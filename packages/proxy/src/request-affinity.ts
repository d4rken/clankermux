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

	const isCodexClient =
		headers.get("originator") === "codex_cli_rs" ||
		headers.get("user-agent")?.startsWith("codex_cli_rs/") === true;
	const codexThread = isCodexClient
		? sanitizeAffinityHeader(headers.get("thread-id"))
		: null;
	if (codexThread) {
		return { key: codexThread, scope: "codex_thread" };
	}

	return { key: null, scope: null };
}
