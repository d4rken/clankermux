/**
 * Human-readable labels for provider keys.
 *
 * Lives in core rather than the dashboard because the SERVABLE CLASS a pool is
 * grouped into is labelled from it (`pool-classes.ts`), and those labels are
 * published — the pacing and quota surfaces name a class "Claude" or "OpenAI"
 * on the wire, so a widget can render a row without a table of its own. A copy
 * of this map in the dashboard would let the page and the API disagree about
 * what to call the same pool.
 *
 * Display only. Nothing routes, matches or keys on these strings; the internal
 * provider identifier (see `PROVIDER_NAMES` in `@clankermux/types`) is the
 * identity, and the values here can be reworded freely.
 */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
	anthropic: "Anthropic",
	"claude-console-api": "Claude API",
	"anthropic-compatible": "Anthropic-Compatible",
	codex: "OpenAI",
	"openai-compatible": "OpenAI-Compatible",
	zai: "z.ai",
	minimax: "MiniMax",
	kilo: "Kilo",
	openrouter: "OpenRouter",
	"alibaba-coding-plan": "Alibaba",
	qwen: "Qwen",
	ollama: "Ollama",
	"ollama-cloud": "Ollama Cloud",
};

/**
 * Turn a provider key into a human-readable label (e.g. "codex" -> "OpenAI").
 * Falls back to Title Case over `-`/`_`/space-separated segments so an unknown
 * provider still renders sensibly rather than as a raw key.
 */
export function providerDisplayName(provider: string): string {
	const known = PROVIDER_DISPLAY_NAMES[provider];
	if (known) return known;
	return provider
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}
