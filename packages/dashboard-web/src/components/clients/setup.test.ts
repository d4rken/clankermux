import { expect, it } from "bun:test";
import type { ClientModelMetadata } from "@clankermux/types";
import {
	type ClientSetupModel,
	clientSetup,
	clientSetupExports,
	destinationsLabel,
	publishedCatalogue,
} from "./setup";

it("labels provider exclusion destinations and invalid empty exclusions", () => {
	const accounts = [{ id: "a", name: "Anthropic", provider: "anthropic" }];
	expect(
		destinationsLabel(
			{
				pinnedAccountId: null,
				pinnedProviders: null,
				excludedProviders: ["anthropic"],
			},
			accounts,
		),
	).toBe("All except anthropic");
	expect(
		destinationsLabel(
			{ pinnedAccountId: null, pinnedProviders: null, excludedProviders: [] },
			accounts,
		),
	).toBe("Invalid provider exclusions");
	expect(
		destinationsLabel(
			{ pinnedAccountId: null, pinnedProviders: null },
			accounts,
		),
	).toBe("All providers");
});

const model = (
	id: string,
	metadata?: ClientModelMetadata,
): ClientSetupModel => ({
	id,
	displayName: id.toUpperCase(),
	targetModel: id,
	accountIds: null,
	...(metadata ? { metadata } : {}),
});
const full: ClientModelMetadata = {
	contextWindow: 872_000,
	maxOutputTokens: 128_000,
	reasoning: true,
	inputModalities: ["text", "image"],
	cost: {
		input: 10,
		output: 50,
		cacheRead: 1,
		cacheWrite: 12.5,
		tiers: [
			{ inputTokensAbove: 200_000, input: 20, output: 100 },
			{ inputTokensAbove: 272_000, input: 30, output: 150 },
		],
	},
};

it("escapes model names and secrets in copied setup", () => {
	const setup = clientSetup(
		"claude-code",
		"http://host:8080",
		"a'$(secret)",
		"claude-test",
		[],
	);
	expect(setup.snippet).toContain("'a'\\''$(secret)'");
	expect(setup.snippet).toContain(
		"CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1",
	);
	expect(setup.snippet).toContain("CLAUDE_CODE_GATEWAY_HINT_HEADERS=1");
});
it("uses the Responses SDK for OpenCode and declares the selected models", () => {
	const setup = clientSetup(
		"opencode",
		"http://host:8080",
		"secret",
		"gpt-test",
		[
			{
				id: "gpt-test",
				displayName: "Test",
				targetModel: "gpt-test",
				accountIds: null,
			},
		],
	);
	const config = JSON.parse(setup.snippet);
	expect(config.provider.clankermux.npm).toBe("@ai-sdk/openai");
	expect(config.provider.clankermux.options.baseURL).toBe(
		"http://host:8080/wire/openai/v1",
	);
	expect(config.model).toBe("clankermux/gpt-test");
	expect(config.provider.clankermux.models["gpt-test"].name).toBe("Test");
});

it("keeps Codex shell exports separate from TOML", () => {
	const recipe = clientSetup(
		"codex",
		"http://host",
		"test-key",
		"gpt-test",
		[],
	);
	expect(recipe.snippet).not.toContain("test-key");
	expect(recipe.environment).toBe("export CLANKERMUX_API_KEY='test-key'");
});
it("applies the selected Pi and Oh My Pi default to their launch commands", () => {
	expect(clientSetup("pi", "http://host", "key", "selected", []).command).toBe(
		"pi --model 'clankermux/selected'",
	);
	expect(
		clientSetup("oh-my-pi", "http://host", "key", "selected", []).command,
	).toBe("omp --model 'clankermux/selected'");
	expect(
		clientSetup("oh-my-pi", "http://host", "key", null, []).snippet,
	).toContain("models: []");
});

it("offers Claude JSON settings and shell exports with the same credentials", () => {
	const exports = clientSetupExports(
		"claude-code",
		"http://host",
		"a'$(secret)",
		"claude-test",
		[],
	);
	// biome-ignore lint/style/noNonNullAssertion: clientSetupExports always emits a settings entry for claude-code
	const json = exports.find((e) => e.id === "settings")!;
	expect(JSON.parse(json.snippet).env).toEqual({
		ANTHROPIC_BASE_URL: "http://host/wire/anthropic",
		ANTHROPIC_AUTH_TOKEN: "a'$(secret)",
		CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
		CLAUDE_CODE_GATEWAY_HINT_HEADERS: "1",
		ANTHROPIC_MODEL: "claude-test",
	});
	expect(exports.find((e) => e.id === "shell")?.snippet).toBe(
		clientSetup("claude-code", "http://host", "a'$(secret)", "claude-test", [])
			.snippet,
	);
});
it("keeps Codex required environment instructions with its TOML export", () => {
	const exports = clientSetupExports(
		"codex",
		"http://host",
		"key",
		"gpt-test",
		[],
	);
	expect(exports[0]?.snippet).toContain('env_key = "CLANKERMUX_API_KEY"');
	expect(exports[0]?.environment).toContain("key");
});

for (const [application, tab, count] of [
	["opencode", "opencode.json", 1],
	["pi", "models.json", 2],
	["oh-my-pi", "models.yml", 2],
	["generic", "Shell environment", 1],
] as const) {
	it(`offers supported setup exports for ${application}`, () => {
		const exports = clientSetupExports(
			application,
			"http://host",
			"setup-secret",
			"model-test",
			[],
		);
		expect(exports).toHaveLength(count);
		expect(new Set(exports.map((e) => e.id)).size).toBe(count);
		expect(exports[0]?.tab).toBe(tab);
		expect(exports[0]?.snippet).toContain("setup-secret");
		if (application === "opencode" || application === "pi")
			expect(() => JSON.parse(exports[0]?.snippet)).not.toThrow();
		if (count === 2) {
			expect(exports[1]?.tab).toBe("Launch command");
			expect(exports[1]?.snippet).toContain("clankermux/model-test");
			expect(exports[1]?.note).toContain("Save the model configuration");
		}
	});
}

it("declares Pi's limits, modalities and tiered rates under Pi's own names", () => {
	const snippet = clientSetup("pi", "http://host", "key", "a", [
		model("a", full),
		model("b"),
	]).snippet;
	const [first, second] = JSON.parse(snippet).providers.clankermux.models;
	expect(first).toEqual({
		id: "a",
		name: "A",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 872_000,
		maxTokens: 128_000,
		cost: {
			input: 10,
			output: 50,
			cacheRead: 1,
			cacheWrite: 12.5,
			tiers: [
				{ inputTokensAbove: 200_000, input: 20, output: 100 },
				{ inputTokensAbove: 272_000, input: 30, output: 150 },
			],
		},
	});
	// A model nothing is known about keeps Pi's own defaults.
	expect(second).toEqual({ id: "b", name: "B" });
});

it("maps Pi's thinking levels onto the efforts the route accepts", () => {
	const snippet = clientSetup("pi", "http://host", "key", "a", [
		model("a", {
			...full,
			supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
		}),
		model("b", { ...full, supportedReasoningEfforts: ["low", "medium"] }),
		model("c", full),
	]).snippet;
	const [first, second, third] =
		JSON.parse(snippet).providers.clankermux.models;
	expect(first.thinkingLevelMap).toEqual({
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	});
	// An effort the route does not accept must be null, not absent: Pi keeps an
	// unmapped low/medium/high and would offer a level the route rejects.
	expect(second.thinkingLevelMap).toEqual({
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: null,
		xhigh: null,
		max: null,
	});
	// No substantiated effort list: no claim about thinking.
	expect(third).not.toHaveProperty("thinkingLevelMap");
});

it("writes the same fields as Oh My Pi YAML, without the tiers it does not document", () => {
	const snippet = clientSetup("oh-my-pi", "http://host", "key", "a", [
		model("a", full),
		model("b"),
	]).snippet;
	expect(snippet).toContain(
		[
			'      - id: "a"',
			'        name: "A"',
			"        reasoning: true",
			'        input: ["text","image"]',
			"        contextWindow: 872000",
			"        maxTokens: 128000",
			"        cost:",
			"          input: 10",
			"          output: 50",
			"          cacheRead: 1",
			"          cacheWrite: 12.5",
			'      - id: "b"',
			'        name: "B"',
		].join("\n"),
	);
	expect(snippet).not.toContain("tiers");
	expect(snippet).not.toContain("inputTokensAbove");
	expect(
		clientSetup("oh-my-pi", "http://host", "key", "a", [
			model("a", { ...full, supportedReasoningEfforts: ["low", "medium"] }),
		]).snippet,
	).not.toContain("thinkingLevelMap");
});

it("nests OpenCode's limit and renames its cache rates", () => {
	const models = clientSetup("opencode", "http://host", "key", "a", [
		model("a", full),
		model("b"),
	]).snippet;
	expect(JSON.parse(models).provider.clankermux.models).toEqual({
		a: {
			name: "A",
			reasoning: true,
			attachment: true,
			limit: { context: 872_000, output: 128_000 },
			cost: {
				input: 10,
				output: 50,
				cache_read: 1,
				cache_write: 12.5,
				context_over_200k: { input: 20, output: 100 },
			},
		},
		b: { name: "B" },
	});
});

it("omits an OpenCode limit that is only half known, and a tier that is not the 200k one", () => {
	const entry = (metadata: ClientModelMetadata) =>
		JSON.parse(
			clientSetup("opencode", "http://host", "key", "a", [model("a", metadata)])
				.snippet,
		).provider.clankermux.models.a;
	// OpenCode marks context and output both required inside `limit`.
	expect(entry({ contextWindow: 872_000 }).limit).toBeUndefined();
	expect(entry({ maxOutputTokens: 128_000 }).limit).toBeUndefined();
	// `context_over_200k` is a fixed threshold: Astra's tier starts at 272k and
	// describes something else.
	expect(
		entry({
			cost: {
				input: 10,
				output: 50,
				tiers: [{ inputTokensAbove: 272_000, input: 30, output: 150 }],
			},
		}).cost,
	).toEqual({ input: 10, output: 50 });
	// An image-less model is still an answer: attachment is false, not absent.
	expect(entry({ inputModalities: ["text"] }).attachment).toBe(false);
	expect(entry({}).attachment).toBeUndefined();
});

it("emits the pre-metadata snippets when nothing is known", () => {
	const models = [model("a"), model("b")];
	expect(
		clientSetup("pi", "http://host:8080", "secret", "a", models).snippet,
	).toBe(`{
  "providers": {
    "clankermux": {
      "baseUrl": "http://host:8080/wire/openai/v1",
      "api": "openai-responses",
      "apiKey": "secret",
      "models": [
        {
          "id": "a",
          "name": "A"
        },
        {
          "id": "b",
          "name": "B"
        }
      ]
    }
  }
}`);
	expect(
		clientSetup("oh-my-pi", "http://host:8080", "secret", "a", models).snippet,
	).toBe(`providers:
  clankermux:
    baseUrl: "http://host:8080/wire/openai/v1"
    api: openai-responses
    apiKey: "secret"
    models:
      - id: "a"
        name: "A"
      - id: "b"
        name: "B"`);
	expect(
		clientSetup("opencode", "http://host:8080", "secret", "a", models).snippet,
	).toBe(`{
  "$schema": "https://opencode.ai/config.json",
  "model": "clankermux/a",
  "provider": {
    "clankermux": {
      "npm": "@ai-sdk/openai",
      "name": "ClankerMux",
      "options": {
        "baseURL": "http://host:8080/wire/openai/v1",
        "apiKey": "secret"
      },
      "models": {
        "a": {
          "name": "A"
        },
        "b": {
          "name": "B"
        }
      }
    }
  }
}`);
});

it("tells the operator what an omitted field and a published rate mean", () => {
	for (const application of ["pi", "oh-my-pi", "opencode"] as const) {
		const note = clientSetup(application, "http://host", "key", "a", []).note;
		expect(note).toContain("defaults");
		expect(note).toContain("list prices");
	}
});

it("hands Claude Code its catalogue under the names it lists, and every other client its stored IDs", () => {
	const model = (id: string) => ({
		id,
		displayName: id,
		targetModel: id,
		accountIds: null,
	});
	const catalogue = {
		models: [model("gpt-6-astra"), model("claude-opus-5-5")],
		defaultModel: "gpt-6-astra",
	};
	const claude = publishedCatalogue("claude-code", "anthropic", catalogue);
	expect(claude.models.map((m) => m.id)).toEqual([
		"claude-gpt-6-astra",
		"claude-opus-5-5",
	]);
	expect(claude.defaultModel).toBe("claude-gpt-6-astra");
	expect(
		clientSetupExports(
			"claude-code",
			"http://host",
			"key",
			claude.defaultModel,
			claude.models,
		)[0]?.snippet,
	).toContain('"ANTHROPIC_MODEL": "claude-gpt-6-astra"');
	expect(publishedCatalogue("generic", "anthropic", catalogue)).toBe(catalogue);
	expect(publishedCatalogue("claude-code", "openai", catalogue)).toBe(
		catalogue,
	);
});
