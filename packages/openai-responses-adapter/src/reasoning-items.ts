import type { OutputReasoningItem } from "./types";

/**
 * Reasoning items minted from Anthropic thinking. A client replays them in
 * later input, where only the id shape tells them apart from OpenAI's own:
 *
 *   resp_0123456789abcdef01234567_rs_0   minted here, no encrypted_content
 *   rs_68a1…                             issued by OpenAI, with encrypted_content
 */
export function reasoningItemId(
	responseId: string,
	outputIndex: number,
): string {
	return `${responseId}_rs_${outputIndex}`;
}

export function reasoningItem(id: string, text: string): OutputReasoningItem {
	return {
		type: "reasoning",
		id,
		summary: [],
		content: [{ type: "reasoning_text", text }],
	};
}

const MINTED_REASONING_ID = /^resp_[0-9a-f]{24}_rs_\d+$/;

/** An input item that replays one of this proxy's reasoning items. */
export function isMintedReasoningItem(item: unknown): boolean {
	if (!item || typeof item !== "object") return false;
	const { type, id, encrypted_content } = item as Record<string, unknown>;
	return (
		type === "reasoning" &&
		typeof id === "string" &&
		MINTED_REASONING_ID.test(id) &&
		encrypted_content == null
	);
}
