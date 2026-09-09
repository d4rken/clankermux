import { afterEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AccountAddForm } from "./AccountAddForm";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface ApiKeyAccountParams {
	name: string;
	apiKey: string;
	priority: number;
	customEndpoint?: string;
	modelMappings?: Record<string, string>;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let saved: Record<string, ApiKeyAccountParams[]> = {};
let errors: string[] = [];

/** Set a controlled input's value the way a real keystroke would. */
function typeInto(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(
		globalThis.HTMLInputElement.prototype,
		"value",
	)?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function byText<T extends Element>(selector: string, text: string): T {
	const match = Array.from(document.querySelectorAll(selector)).find(
		(el) => el.textContent?.trim() === text,
	);
	if (!match) throw new Error(`no ${selector} with text "${text}"`);
	return match as unknown as T;
}

function record(provider: string) {
	return async (params: ApiKeyAccountParams) => {
		const existing = saved[provider] ?? [];
		existing.push(params);
		saved[provider] = existing;
	};
}

function renderForm(): Promise<void> {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	return act(async () => {
		root?.render(
			<AccountAddForm
				onAddAccount={async () => ({ authUrl: "", sessionId: "" })}
				onCompleteAccount={async () => {}}
				onAddZaiAccount={record("zai")}
				onAddMinimaxAccount={record("minimax")}
				onAddAnthropicCompatibleAccount={record("anthropic-compatible")}
				onAddOpenAIAccount={record("openai-compatible")}
				onAddAlibabaCodingPlanAccount={record("alibaba-coding-plan")}
				onAddKiloAccount={record("kilo")}
				onAddOpenRouterAccount={record("openrouter")}
				onAddOllamaAccount={async () => {}}
				onAddOllamaCloudAccount={async () => {}}
				onCancel={() => {}}
				onSuccess={() => {}}
				onError={(message: string) => {
					errors.push(message);
				}}
			/>,
		);
	});
}

/**
 * Pick a mode from the Radix Select by keyboard. It has no native `<select>`
 * behind it, and happy-dom has no pointer stack, so ArrowDown to open and Enter
 * on the option is the only way in.
 */
async function selectMode(optionText: string): Promise<void> {
	const trigger = document.querySelector("#mode") as HTMLElement;
	trigger.focus();
	await act(async () => {
		trigger.dispatchEvent(
			new globalThis.KeyboardEvent("keydown", {
				key: "ArrowDown",
				bubbles: true,
			}),
		);
	});
	const option = Array.from(document.querySelectorAll('[role="option"]')).find(
		(el) => el.textContent?.includes(optionText),
	);
	if (!option) throw new Error(`no option matching "${optionText}"`);
	await act(async () => {
		option.dispatchEvent(
			new globalThis.KeyboardEvent("keydown", {
				key: "Enter",
				bubbles: true,
			}),
		);
	});
}

async function edit(id: string, value: string) {
	await act(async () =>
		typeInto(document.querySelector(`#${id}`) as HTMLInputElement, value),
	);
}

async function submit() {
	await act(async () =>
		byText<HTMLButtonElement>("button", "Continue").click(),
	);
}

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = null;
	host = null;
	saved = {};
	errors = [];
	mock.restore();
});

const modes = [
	{ provider: "openrouter", option: "OpenRouter (API Key)" },
	{ provider: "kilo", option: "Kilo Gateway (API Key)" },
	{
		provider: "alibaba-coding-plan",
		option: "Alibaba Coding Plan International (API Key)",
	},
] as const;

describe("account add form: API key provider modes", () => {
	it.each(
		modes,
	)("renders an API key field and no endpoint field for $provider", async ({
		option,
	}) => {
		await renderForm();
		await selectMode(option);
		const apiKey = document.querySelector("#apiKey") as HTMLInputElement | null;
		expect(apiKey).not.toBeNull();
		expect(apiKey?.type).toBe("password");
		expect(document.querySelector("#customEndpoint")).toBeNull();
		expect(document.querySelector("#endpoint")).toBeNull();
	});

	it.each(modes)("submits key and model mappings for $provider", async ({
		provider,
		option,
	}) => {
		await renderForm();
		await selectMode(option);
		await edit("name", `${provider}-account`);
		await edit("apiKey", `${provider}-key`);
		await edit("opusModel", "vendor/opus-model");
		await edit("sonnetModel", "vendor/sonnet-model");
		await edit("haikuModel", "vendor/haiku-model");
		await submit();
		expect(errors).toEqual([]);
		expect(saved[provider]).toEqual([
			{
				name: `${provider}-account`,
				apiKey: `${provider}-key`,
				priority: 0,
				modelMappings: {
					opus: "vendor/opus-model",
					sonnet: "vendor/sonnet-model",
					haiku: "vendor/haiku-model",
				},
			},
		]);
	});

	it("omits modelMappings when every family is left blank", async () => {
		await renderForm();
		await selectMode("OpenRouter (API Key)");
		await edit("name", "openrouter-account");
		await edit("apiKey", "openrouter-key");
		await submit();
		expect(errors).toEqual([]);
		expect(saved.openrouter).toEqual([
			{
				name: "openrouter-account",
				apiKey: "openrouter-key",
				priority: 0,
				modelMappings: undefined,
			},
		]);
	});

	it("drops an endpoint typed under a previous mode when the mode changes", async () => {
		await renderForm();
		await selectMode("Anthropic-Compatible");
		await edit("name", "openrouter-account");
		await edit("apiKey", "anthropic-compatible-key");
		await edit("customEndpoint", "foo");
		await selectMode("OpenRouter (API Key)");
		await edit("apiKey", "openrouter-key");
		await submit();
		expect(errors).toEqual([]);
		expect(saved.openrouter).toHaveLength(1);
		expect(saved.openrouter[0]).not.toHaveProperty("customEndpoint");
		expect(saved.openrouter[0].apiKey).toBe("openrouter-key");
	});

	it("clears the API key when the mode changes", async () => {
		await renderForm();
		await selectMode("Anthropic-Compatible");
		await edit("apiKey", "anthropic-compatible-key");
		await selectMode("OpenRouter (API Key)");
		expect((document.querySelector("#apiKey") as HTMLInputElement).value).toBe(
			"",
		);
	});
});
