import { expect, it } from "bun:test";
import { clientSetup } from "./setup";

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
