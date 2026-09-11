/**
 * Extract the per-request "reasoning effort" from a parsed request body.
 *
 * Storage representation (single TEXT value, null when absent):
 *   - Anthropic `thinking: { type: "enabled", budget_tokens: N }` →
 *     `"thinking:<N>"`, or bare `"thinking"` when enabled without a numeric
 *     budget. `type: "disabled"` → null.
 *   - OpenAI Responses `reasoning: { effort: "<string>" }` → the raw effort
 *     string as-is (arbitrary vocabulary: minimal/low/medium/high/xhigh/max/…).
 * Explicit reasoning.effort, reasoning_effort and output_config.effort take
 * precedence over implicit thinking budgets, in that order.
 */
export function parseReasoningEffort(body: unknown): string | null {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return null;
	}
	const record = body as Record<string, unknown>;

	const explicit = (record.reasoning as { effort?: unknown } | undefined)
		?.effort;
	if (typeof explicit === "string" && explicit.length > 0) return explicit;
	const chatEffort = record.reasoning_effort;
	if (typeof chatEffort === "string" && chatEffort.length > 0)
		return chatEffort;
	const adaptiveEffort = (
		record.output_config as { effort?: unknown } | undefined
	)?.effort;
	if (typeof adaptiveEffort === "string" && adaptiveEffort.length > 0)
		return adaptiveEffort;
	const thinking = record.thinking;
	if (typeof thinking === "object" && thinking !== null) {
		const t = thinking as Record<string, unknown>;
		if (t.type === "enabled") {
			const budget = t.budget_tokens;
			if (typeof budget === "number" && Number.isFinite(budget)) {
				return `thinking:${budget}`;
			}
			return "thinking";
		}
		return null;
	}

	return null;
}
