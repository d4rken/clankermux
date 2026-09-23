import {
	ALIAS_REASONING_EFFORTS,
	type ClientApplication,
	type ClientFormat,
	type ClientModel,
	type ClientModelMetadata,
} from "@clankermux/types";
export const APPLICATIONS: Record<ClientApplication, string> = {
	generic: "Generic / script",
	"claude-code": "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	"oh-my-pi": "Oh My Pi",
	pi: "Pi Agent",
};
export const FORMATS: Record<ClientFormat, string> = {
	anthropic: "Anthropic-style discovery",
	openai: "OpenAI-style discovery",
	codex: "Codex rich catalogue",
};
/** Tab-width names for the same formats. */
export const FORMAT_LABELS: Record<ClientFormat, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	codex: "Codex",
};
/**
 * Claude Code only accepts an Anthropic-style ID that reads as one. The server
 * rejects the rest outright, so this is the same rule on both sides of the
 * wire; `client-service.test.ts` pins the server half.
 */
export const needsClaudeAlias = (id: string) => !/claude|anthropic/i.test(id);
export const destinationsLabel = (
	key: {
		pinnedAccountId: string | null;
		pinnedProviders: string[] | null;
		excludedProviders?: string[] | null;
	},
	accounts: { id: string; name: string }[],
) =>
	key.pinnedAccountId
		? (accounts.find((a) => a.id === key.pinnedAccountId)?.name ??
			"Unavailable account")
		: key.pinnedProviders
			? key.pinnedProviders.join(", ")
			: key.excludedProviders?.length
				? `All except ${key.excludedProviders.join(", ")}`
				: key.excludedProviders
					? "Invalid provider exclusions"
					: "All providers";
export const preferredFormat = (
	application: ClientApplication,
): ClientFormat =>
	application === "claude-code"
		? "anthropic"
		: application === "codex"
			? "codex"
			: "openai";
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/**
 * A published model plus whatever ClankerMux could substantiate about its
 * route. Metadata is resolved per dialog and never stored with the catalogue.
 */
export interface ClientSetupModel extends ClientModel {
	metadata?: ClientModelMetadata;
}
/**
 * Pi and Oh My Pi take the same field set; only the syntax differs. Every key
 * is omitted where the value is unknown — the client's own documented default
 * beats a number this proxy cannot stand behind.
 */
function piFields(metadata: ClientModelMetadata | undefined) {
	return {
		...(metadata?.reasoning === undefined
			? {}
			: { reasoning: metadata.reasoning }),
		...(metadata?.inputModalities ? { input: metadata.inputModalities } : {}),
		...(metadata?.contextWindow === undefined
			? {}
			: { contextWindow: metadata.contextWindow }),
		...(metadata?.maxOutputTokens === undefined
			? {}
			: { maxTokens: metadata.maxOutputTokens }),
	};
}
/**
 * Pi's `thinkingLevelMap` for the efforts this route is known to accept.
 *
 * Pi keeps an unmapped level and passes its name through verbatim, except
 * `xhigh`/`max`, which need an explicit entry to be selectable at all. So the
 * whole canonical set has to be written out: an effort the route does NOT
 * accept is `null` (removed), not absent (kept). Every alias publishes the
 * same fixed range and the gateway maps the chosen level onto each target; a
 * model with no substantiated list gets no map.
 *
 * `off` is always `null`. Pi's own default for an unmapped `off` is to send
 * `reasoning: { effort: "none" }` on every non-thinking request, and `none` is
 * outside this proxy's effort vocabulary — `resolveReasoningEffort` throws on
 * it, and only the Codex provider's own special case keeps that from surfacing.
 * `null` makes Pi send no reasoning field instead.
 *
 * Oh My Pi does not get this key: whether its loader accepts it is unverified,
 * the same reason `tiers` is left out of its cost block.
 */
function piThinkingLevelMap(metadata: ClientModelMetadata | undefined) {
	const efforts = metadata?.supportedReasoningEfforts;
	if (!efforts?.length) return {};
	return {
		thinkingLevelMap: {
			off: null,
			...Object.fromEntries(
				ALIAS_REASONING_EFFORTS.map((effort) => [
					effort,
					efforts.includes(effort) ? effort : null,
				]),
			),
		},
	};
}

/** OpenCode's cost keys, which are snake_case where Pi's are camelCase. */
function openCodeCost(metadata: ClientModelMetadata | undefined) {
	const cost = metadata?.cost;
	if (!cost) return {};
	// A fixed-threshold field, so only a tier that starts exactly there fits it:
	// gpt-6-astra's tier starts at 272k and is correctly left out rather than
	// filed under a 200k threshold it does not describe.
	const over200k = cost.tiers?.find((t) => t.inputTokensAbove === 200_000);
	return {
		cost: {
			input: cost.input,
			output: cost.output,
			...(cost.cacheRead === undefined ? {} : { cache_read: cost.cacheRead }),
			...(cost.cacheWrite === undefined
				? {}
				: { cache_write: cost.cacheWrite }),
			...(over200k
				? {
						context_over_200k: {
							input: over200k.input,
							output: over200k.output,
							...(over200k.cacheRead === undefined
								? {}
								: { cache_read: over200k.cacheRead }),
							...(over200k.cacheWrite === undefined
								? {}
								: { cache_write: over200k.cacheWrite }),
						},
					}
				: {}),
		},
	};
}
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
	models: ClientSetupModel[],
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
				"export CLAUDE_CODE_GATEWAY_HINT_HEADERS=1",
				...(selected ? [`export ANTHROPIC_MODEL=${shell(selected)}`] : []),
			].join("\n"),
			note: "Start a new Claude Code session. Gateway model discovery caches by base URL; switching keys may require clearing ~/.claude/cache/gateway-models.json. An empty compatible list may show built-in models. Hint headers label requests by class and agent type in Request Details on Claude Code 2.1.273+.",
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
								models.map((m) => [
									m.id,
									{
										name: m.displayName,
										...(m.metadata?.reasoning === undefined
											? {}
											: { reasoning: m.metadata.reasoning }),
										...(m.metadata?.inputModalities
											? {
													attachment:
														m.metadata.inputModalities.includes("image"),
												}
											: {}),
										// `context` and `output` are both required inside `limit`,
										// so a half-known pair is no limit at all.
										...(m.metadata?.contextWindow !== undefined &&
										m.metadata.maxOutputTokens !== undefined
											? {
													limit: {
														context: m.metadata.contextWindow,
														output: m.metadata.maxOutputTokens,
													},
												}
											: {}),
										...openCodeCost(m.metadata),
									},
								]),
							),
						},
					},
				},
				null,
				2,
			),
			note: "This preset uses Responses. OpenCode keeps its model definitions in this configuration, so recopy the model section after catalogue edits; omitted limits fall back to its own defaults, and the rates are the catalogue's public list prices rather than what a pooled subscription bills.",
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
							models: models.map((m) => ({
								id: m.id,
								name: m.displayName,
								...piFields(m.metadata),
								...piThinkingLevelMap(m.metadata),
								...(m.metadata?.cost ? { cost: m.metadata.cost } : {}),
							})),
						},
					},
				},
				null,
				2,
			),
			note: "Choose ClankerMux and a model in Pi. Pi uses this local model list, so recopy it after catalogue edits; omitted limits fall back to Pi's own defaults, and the rates are the catalogue's public list prices rather than what a pooled subscription bills.",
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
					...Object.entries(piFields(m.metadata)).map(
						([key, value]) => `        ${key}: ${JSON.stringify(value)}`,
					),
					// `tiers` is left out on purpose: Oh My Pi documents cost as
					// input/output/cacheRead/cacheWrite with no such key, and whether its
					// loader ignores or rejects an unknown one is unverified — a rejected
					// key could fail the whole provider block.
					...(m.metadata?.cost
						? [
								"        cost:",
								...(
									["input", "output", "cacheRead", "cacheWrite"] as const
								).flatMap((key) =>
									m.metadata?.cost?.[key] === undefined
										? []
										: [
												`          ${key}: ${JSON.stringify(m.metadata.cost[key])}`,
											],
								),
							]
						: []),
				]),
			].join("\n"),
			note: "Choose ClankerMux and a model in Oh My Pi, whose local list must be recopied after catalogue edits. Omitted limits fall back to its own defaults, and the rates are the catalogue's public list prices rather than what a pooled subscription bills.",
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

export interface ClientSetupExport extends ClientSetupRecipe {
	id: string;
	tab: string;
}

export function clientSetupExports(
	application: ClientApplication,
	origin: string,
	secret: string,
	model: string | null,
	models: ClientSetupModel[],
): ClientSetupExport[] {
	const recipe = clientSetup(application, origin, secret, model, models);
	if (application === "claude-code") {
		const selected = model ?? models[0]?.id;
		return [
			{
				id: "settings",
				tab: "settings.json",
				label: "Merge into ~/.claude/settings.json",
				snippet: JSON.stringify(
					{
						env: {
							ANTHROPIC_BASE_URL: `${origin}/wire/anthropic`,
							ANTHROPIC_AUTH_TOKEN: secret,
							CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
							CLAUDE_CODE_GATEWAY_HINT_HEADERS: "1",
							...(selected ? { ANTHROPIC_MODEL: selected } : {}),
						},
					},
					null,
					2,
				),
				note: recipe.note,
			},
			{ ...recipe, id: "shell", tab: "Shell environment" },
		];
	}
	const exports: ClientSetupExport[] = [
		{
			...recipe,
			id: "settings",
			tab:
				application === "codex"
					? "config.toml"
					: application === "opencode"
						? "opencode.json"
						: application === "pi"
							? "models.json"
							: application === "oh-my-pi"
								? "models.yml"
								: "Shell environment",
		},
	];
	if (recipe.environment)
		exports.push({
			id: "shell",
			tab: "Required environment",
			label: "Required shell environment",
			snippet: recipe.environment,
			note: "Save the TOML configuration from the config.toml tab as well, then run this in the shell where you launch Codex.",
		});
	if (recipe.command)
		exports.push({
			id: "command",
			tab: "Launch command",
			label: "Launch client",
			snippet: recipe.command,
			note: "Save the model configuration from the first tab before using this command.",
		});
	return exports;
}
