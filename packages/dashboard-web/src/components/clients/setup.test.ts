import { expect, it } from "bun:test";
import { clientSetup, clientSetupExports } from "./setup";

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
	const json = exports.find((e) => e.id === "settings")!;
	expect(JSON.parse(json.snippet).env).toEqual({
		ANTHROPIC_BASE_URL: "http://host/wire/anthropic",
		ANTHROPIC_AUTH_TOKEN: "a'$(secret)",
		CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
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
