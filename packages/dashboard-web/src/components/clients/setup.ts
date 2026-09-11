import type {
	ClientApplication,
	ClientFormat,
	ClientModel,
} from "@clankermux/types";
export const APPLICATIONS: Record<ClientApplication, string> = {
	generic: "Generic / script",
	"claude-code": "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	"oh-my-pi": "Oh My Pi",
	pi: "Pi Agent",
};
export const preferredFormat = (
	application: ClientApplication,
): ClientFormat =>
	application === "claude-code"
		? "anthropic"
		: application === "codex"
			? "codex"
			: "openai";
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export interface ClientSetupRecipe {
	label: string;
	snippet: string;
	note: string;
	environment?: string;
	command?: string;
}
export function clientSetup(
	application: ClientApplication,
	origin: string,
	secret: string,
	model: string | null,
	models: ClientModel[],
): ClientSetupRecipe {
	const base = `${origin}/wire/openai/v1`;
	const selected = model ?? models[0]?.id;
	if (application === "claude-code")
		return {
			label: "Shell environment",
			snippet: [
				`export ANTHROPIC_BASE_URL=${shell(`${origin}/wire/anthropic`)}`,
				`export ANTHROPIC_AUTH_TOKEN=${shell(secret)}`,
				"export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1",
				...(selected ? [`export ANTHROPIC_MODEL=${shell(selected)}`] : []),
			].join("\n"),
			note: "Start a new Claude Code session. Gateway model discovery caches by base URL; switching keys may require clearing ~/.claude/cache/gateway-models.json. An empty compatible list may show built-in models.",
		};
	if (application === "codex")
		return {
			label: "~/.codex/config.toml",
			environment: `export CLANKERMUX_API_KEY=${shell(secret)}`,
			snippet: [
				...(selected ? [`model = ${JSON.stringify(selected)}`] : []),
				'model_provider = "clankermux"',
				"",
				"[model_providers.clankermux]",
				'name = "ClankerMux"',
				`base_url = ${JSON.stringify(base)}`,
				'wire_api = "responses"',
				'env_key = "CLANKERMUX_API_KEY"',
			].join("\n"),
			note: "Restart Codex after changing the catalogue. Its local model cache can outlive a key change. Entries without known target metadata use the selected generic-list fallback, which Codex may replace with built-in models.",
		};
	if (application === "opencode")
		return {
			label: "Merge into ~/.config/opencode/opencode.json",
			snippet: JSON.stringify(
				{
					$schema: "https://opencode.ai/config.json",
					...(selected ? { model: `clankermux/${selected}` } : {}),
					provider: {
						clankermux: {
							npm: "@ai-sdk/openai",
							name: "ClankerMux",
							options: { baseURL: base, apiKey: secret },
							models: Object.fromEntries(
								models.map((m) => [m.id, { name: m.displayName }]),
							),
						},
					},
				},
				null,
				2,
			),
			note: "This preset uses Responses. OpenCode keeps its model definitions in this configuration; recopy the model section when you change the client catalogue.",
		};
	if (application === "pi")
		return {
			label: "Merge into ~/.pi/agent/models.json",
			command: selected
				? `pi --model ${shell(`clankermux/${selected}`)}`
				: "pi --provider clankermux",
			snippet: JSON.stringify(
				{
					providers: {
						clankermux: {
							baseUrl: base,
							api: "openai-responses",
							apiKey: secret,
							models: models.map((m) => ({ id: m.id, name: m.displayName })),
						},
					},
				},
				null,
				2,
			),
			note: "Choose ClankerMux and a model in Pi. Pi uses this local model list; recopy it after catalogue edits.",
		};
	if (application === "oh-my-pi")
		return {
			label: "Merge into ~/.omp/agent/models.yml",
			command: selected
				? `omp --model ${shell(`clankermux/${selected}`)}`
				: "omp --provider clankermux",
			snippet: [
				"providers:",
				"  clankermux:",
				`    baseUrl: ${JSON.stringify(base)}`,
				"    api: openai-responses",
				`    apiKey: ${JSON.stringify(secret)}`,
				models.length ? "    models:" : "    models: []",
				...models.flatMap((m) => [
					`      - id: ${JSON.stringify(m.id)}`,
					`        name: ${JSON.stringify(m.displayName)}`,
				]),
			].join("\n"),
			note: "Choose ClankerMux and a model in Oh My Pi. Its local list must be recopied after catalogue edits.",
		};
	return {
		label: "OpenAI-compatible environment",
		snippet: [
			`export OPENAI_BASE_URL=${shell(base)}`,
			`export OPENAI_API_KEY=${shell(secret)}`,
			...(selected ? [`export MODEL=${shell(selected)}`] : []),
		].join("\n"),
		note: `Use ${base}/responses or ${base}/chat/completions. Anthropic-style clients can use ${origin}/wire/anthropic. The key's destination restrictions apply to every protocol.`,
	};
}
