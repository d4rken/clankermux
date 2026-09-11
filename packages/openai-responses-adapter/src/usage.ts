import type { AnthropicUsage, ResponsesUsage } from "./types";

/** Usage events are partial cumulative snapshots, including the final input counts. */
export function mergeAnthropicUsage(
	target: AnthropicUsage,
	update: Record<string, unknown> | undefined,
): void {
	if (!update) return;
	for (const field of [
		"input_tokens",
		"output_tokens",
		"cache_read_input_tokens",
		"cache_creation_input_tokens",
	] as const) {
		const value = update[field];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0)
			target[field] = value;
	}
}

export function translateAnthropicUsage(usage: AnthropicUsage): ResponsesUsage {
	// Anthropic input_tokens excludes cached input; Responses includes it.
	const input =
		usage.input_tokens +
		(usage.cache_read_input_tokens ?? 0) +
		(usage.cache_creation_input_tokens ?? 0);
	return {
		input_tokens: input,
		output_tokens: usage.output_tokens,
		total_tokens: input + usage.output_tokens,
		...(usage.cache_read_input_tokens !== undefined ||
		usage.cache_creation_input_tokens !== undefined
			? {
					input_tokens_details: {
						cached_tokens: usage.cache_read_input_tokens ?? 0,
						...(usage.cache_creation_input_tokens !== undefined
							? { cache_write_tokens: usage.cache_creation_input_tokens }
							: {}),
					},
				}
			: {}),
	};
}
