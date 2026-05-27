import type { RequestAffinityScope } from "@clankermux/types";

function sanitizeAffinityHeader(value: string | null): string | null {
	if (!value) return null;
	const sanitized = Array.from(value)
		.filter((char) => {
			const code = char.charCodeAt(0);
			return code >= 0x20 && code !== 0x7f;
		})
		.join("")
		.trim();
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

	const codexThread = sanitizeAffinityHeader(headers.get("thread-id"));
	if (codexThread) {
		return { key: codexThread, scope: "codex_thread" };
	}

	return { key: null, scope: null };
}
