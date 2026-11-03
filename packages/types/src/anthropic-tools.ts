/**
 * Whether a Messages `tools[]` entry is a server tool (web search, code
 * execution, bash, editor, computer use) rather than a client-defined one.
 *
 *   { name: "Read", input_schema: {...} }                  -> false
 *   { type: "custom", name: "Read", input_schema: {...} }  -> false
 *   { type: "web_search_20250305", name: "web_search" }    -> true
 */
export function isAnthropicServerTool(
	tool: unknown,
): tool is Record<string, unknown> & { type: unknown } {
	if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
	const { type } = tool as { type?: unknown };
	return type !== undefined && type !== "custom";
}
