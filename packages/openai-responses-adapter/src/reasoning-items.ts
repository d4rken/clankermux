import type { OutputReasoningItem } from "./types";

/** Reasoning items minted from Anthropic thinking, e.g. `resp_…_rs_0`. */
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
