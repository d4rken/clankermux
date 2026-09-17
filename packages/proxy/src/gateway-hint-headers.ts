import type { GatewayHintMetadata } from "@clankermux/types";

// Claude Code 2.1.273+, enabled by CLAUDE_CODE_GATEWAY_HINT_HEADERS=1.
const HINT_FIELDS = [
	["x-claude-code-request-class", "gatewayHintRequestClass", 256],
	["x-claude-code-agent-type", "gatewayHintAgentType", 256],
	["x-claude-code-prev-tool-durations", "gatewayHintPrevToolDurations", 2048],
	["x-claude-code-compaction", "gatewayHintCompaction", 256],
	["x-claude-code-context-compacted", "gatewayHintContextCompacted", 256],
] as const;

export const GATEWAY_HINT_HEADERS = HINT_FIELDS.map(([header]) => header);

export function extractGatewayHints(
	headers: Record<string, string>,
): GatewayHintMetadata {
	const hints: GatewayHintMetadata = {};
	for (const [name, raw] of Object.entries(headers)) {
		const field = HINT_FIELDS.find(([header]) => header === name.toLowerCase());
		if (!field || typeof raw !== "string") continue;
		// biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters from stored diagnostics
		const value = raw.replace(/[\x00-\x1F\x7F]/g, "").trim();
		if (value) hints[field[1]] = value.slice(0, field[2]);
	}
	return hints;
}
