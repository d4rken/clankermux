/**
 * Whether a Messages `tools[]` entry is an Anthropic-defined tool (web search,
 * code execution, bash, text editor, computer use) rather than one the client
 * defined with its own `input_schema`.
 *
 *   { name: "Read", input_schema: {...} }                  -> false
 *   { type: "custom", name: "Read", input_schema: {...} }  -> false
 *   { type: null, name: "Read", input_schema: {...} }      -> false
 *   { type: "web_search_20250305", name: "web_search" }    -> true
 */
export function isAnthropicServerTool(
	tool: unknown,
): tool is Record<string, unknown> & { type: unknown } {
	if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
	const { type } = tool as { type?: unknown };
	return type !== undefined && type !== null && type !== "custom";
}

/** The first Anthropic-defined tool type in a Messages body, or null. */
export function anthropicServerToolType(body: unknown): string | null {
	const tools =
		body && typeof body === "object" && !Array.isArray(body)
			? (body as { tools?: unknown }).tools
			: undefined;
	const tool = Array.isArray(tools)
		? tools.find(isAnthropicServerTool)
		: undefined;
	return tool ? String(tool.type) : null;
}

/**
 * A client-supplied tool type as it goes into an error message: quoted, so
 * control characters are escaped, and cut to 64 characters.
 *
 *   "web_search_20250305"  -> "\"web_search_20250305\""
 *   "a\nb"                 -> "\"a\\nb\""
 */
export function quotedToolType(type: unknown): string {
	return JSON.stringify(String(type).slice(0, 64));
}
