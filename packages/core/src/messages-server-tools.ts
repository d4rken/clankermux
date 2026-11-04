/**
 * Providers whose Messages path rebuilds each tool from its `input_schema`
 * (as an OpenAI function, a Responses function or a Devin tool definition), so
 * an Anthropic-defined tool such as `web_search_20250305` cannot survive it.
 * Providers that forward the Messages body are absent: the upstream decides.
 */
const REFUSES_MESSAGES_SERVER_TOOLS: ReadonlySet<string> = new Set([
	"codex",
	"openai-compatible",
	"kilo",
	"qwen",
	"devin",
]);

export function refusesMessagesServerTools(provider: string): boolean {
	return REFUSES_MESSAGES_SERVER_TOOLS.has(provider);
}
