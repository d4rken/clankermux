/**
 * Extract the per-request "reasoning effort" from a parsed request body.
 *
 * Storage representation (single TEXT value, null when absent):
 *   - Anthropic `thinking: { type: "enabled", budget_tokens: N }` →
 *     `"thinking:<N>"`, or bare `"thinking"` when enabled without a numeric
 *     budget. `type: "disabled"` → null.
 *   - OpenAI Responses `reasoning: { effort: "<string>" }` → the raw effort
 *     string as-is (arbitrary vocabulary: minimal/low/medium/high/xhigh/max/…).
 * Explicit settings take precedence over implicit thinking budgets, in this
 * order: reasoning.effort, reasoning_effort, the last mid-conversation update
 * (a system message's output_config.effort, which Claude Code sends when the
 * user changes effort and which supersedes the level the request started
 * with), then the top-level output_config.effort.
 */
export function parseReasoningEffort(body: unknown): string | null {
	if (!isRecord(body)) return null;

	const explicit = (body.reasoning as { effort?: unknown } | undefined)?.effort;
	if (typeof explicit === "string" && explicit.length > 0) return explicit;
	const chatEffort = body.reasoning_effort;
	if (typeof chatEffort === "string" && chatEffort.length > 0)
		return chatEffort;
	const update = Array.isArray(body.messages)
		? body.messages
				.map(systemMessageEffort)
				.findLast((effort) => effort !== null)
		: undefined;
	if (update) return update;
	const adaptiveEffort = (
		body.output_config as { effort?: unknown } | undefined
	)?.effort;
	if (typeof adaptiveEffort === "string" && adaptiveEffort.length > 0)
		return adaptiveEffort;
	const thinking = body.thinking;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function systemMessageEffort(message: unknown): string | null {
	if (!isRecord(message) || message.role !== "system") return null;
	const effort = (message.output_config as { effort?: unknown } | undefined)
		?.effort;
	return typeof effort === "string" && effort.length > 0 ? effort : null;
}

/**
 * Point `holder[key]` at a copy of its object with `effort` mapped, dropping
 * the key when the copy is empty. `undefined` from `map` removes the effort.
 * Returns whether anything changed.
 */
function mapNestedEffort(
	holder: Record<string, unknown>,
	key: string,
	map: (effort: unknown) => unknown,
): boolean {
	const config = holder[key];
	if (!isRecord(config) || !Object.hasOwn(config, "effort")) return false;
	const effort = map(config.effort);
	if (effort === config.effort) return false;
	const { effort: _effort, ...rest } = config;
	const next = effort === undefined ? rest : { ...rest, effort };
	if (Object.keys(next).length) holder[key] = next;
	else delete holder[key];
	return true;
}

/** Map the request's output_config.effort and every system-message update. */
function mapOutputConfigEfforts(
	body: Record<string, unknown>,
	map: (effort: unknown) => unknown,
): void {
	mapNestedEffort(body, "output_config", map);
	if (!Array.isArray(body.messages)) return;
	let changed = false;
	const messages = body.messages.map((message: unknown) => {
		if (!isRecord(message) || message.role !== "system") return message;
		const copy = { ...message };
		if (!mapNestedEffort(copy, "output_config", map)) return message;
		changed = true;
		return copy;
	});
	if (changed) body.messages = messages;
}

/**
 * Remove every effort control {@link parseReasoningEffort} reads, so the
 * upstream falls back to its own default. Everything else stays: a thinking
 * budget and the non-effort `reasoning` fields reached these targets before
 * aliases offered an effort. Adaptive thinking goes too, since it only means
 * something together with an effort. Nested objects are replaced, never
 * edited: a body from `withPatchedModel` shares them with its parent, which
 * later attempts to other destinations still send.
 */
export function stripEffortControls(body: Record<string, unknown>): void {
	delete body.reasoning_effort;
	mapNestedEffort(body, "reasoning", () => undefined);
	if (isRecord(body.thinking) && body.thinking.type === "adaptive")
		delete body.thinking;
	mapOutputConfigEfforts(body, () => undefined);
}

/**
 * Rewrite the request's output_config.effort and each system-message update
 * through `clamp`, replacing rather than editing the objects that change.
 */
export function clampOutputConfigEffort(
	body: Record<string, unknown>,
	clamp: (effort: string) => string,
): void {
	mapOutputConfigEfforts(body, (effort) =>
		typeof effort === "string" ? clamp(effort) : effort,
	);
}
