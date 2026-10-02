import type { OutputReasoningItem } from "./types";

export function reasoningItem(id: string, text: string): OutputReasoningItem {
	return {
		type: "reasoning",
		id,
		summary: [],
		content: [{ type: "reasoning_text", text }],
	};
}
