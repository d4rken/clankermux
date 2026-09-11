import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../../api";
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
				onAddDevinAccount={record("devin")}
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

	it.each(modes)("submits account credentials for $provider", async ({
		provider,
		option,
	}) => {
		await renderForm();
		await selectMode(option);
		await edit("name", `${provider}-account`);
		await edit("apiKey", `${provider}-key`);
		await submit();
		expect(errors).toEqual([]);
		expect(saved[provider]).toEqual([
			{
				name: `${provider}-account`,
				apiKey: `${provider}-key`,
				priority: 0,
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

it("imports a Devin session token with SWE-2 defaults", async () => {
	await renderForm();
	await selectMode("Devin (Subscription)");
	await edit("name", "devin-free");
	await edit("devin-token", "session-secret");
	await act(async () => {
		byText<HTMLButtonElement>("button", "Continue").click();
	});
	expect(saved.devin?.[0]).toMatchObject({
		name: "devin-free",
		apiKey: "session-secret",
		priority: 0,
	});
	expect(errors).toEqual([]);
});

it("hands Devin login to the chosen browser and completes using the hosted login code", async () => {
	const start = spyOn(api, "startDevinLogin").mockResolvedValue({
		sessionId: "login-1",
		authUrl: "https://app.devin.ai/auth/cli/continue?state=test",
		expiresAt: Date.now() + 60_000,
	});
	const complete = spyOn(api, "completeDevinLogin").mockResolvedValue({
		message: "Added",
		account: { id: "devin-1" },
	} as never);
	await renderForm();
	await selectMode("Devin (Subscription)");
	await edit("name", "Free");
	await act(async () =>
		byText<HTMLButtonElement>("button", "Sign in with Devin").click(),
	);
	expect(start).toHaveBeenCalledWith({ name: "Free", priority: 0 });
	expect(
		document.querySelector<HTMLAnchorElement>(
			'a[href^="https://app.devin.ai/"]',
		)?.target,
	).toBe("_blank");
	expect(document.body.textContent).toContain("Copy your login code");
	expect(document.body.textContent).toContain("code expires after 5 minutes");
	expect(document.body.textContent).not.toContain("localhost");
	const input = document.querySelector<HTMLInputElement>("#devin-code");
	expect(input?.type).toBe("password");
	expect(input?.getAttribute("autocomplete")).toBe("off");
	expect(input?.getAttribute("autocorrect")).toBe("off");
	expect(input?.getAttribute("autocapitalize")).toBe("none");
	expect(input?.getAttribute("spellcheck")).toBe("false");
	await edit("devin-code", "   ");
	expect(
		byText<HTMLButtonElement>("button", "Complete Devin sign-in").disabled,
	).toBe(true);
	const code = "private-code";
	await edit("devin-code", ` ${code} `);
	await act(async () =>
		byText<HTMLButtonElement>("button", "Complete Devin sign-in").click(),
	);
	expect(complete).toHaveBeenCalledWith({ sessionId: "login-1", code });
	expect(document.querySelector("#devin-code")).toBeNull();
	expect(errors).toEqual([]);
});

it("shows Devin discovery with central routing guidance and clears it when the token changes", async () => {
	spyOn(api, "discoverDevinModels").mockResolvedValue({
		models: [
			{
				id: "swe-2-high",
				name: "SWE-2 High",
				disabled: false,
				disabledReason: null,
			},
		],
		usage: { planName: "Free", canUseCli: true },
	});
	await renderForm();
	await selectMode("Devin (Subscription)");
	await edit("name", "Free");
	await edit("devin-token", "first-token");
	await act(async () =>
		byText<HTMLButtonElement>("button", "Check access and models").click(),
	);
	expect(document.querySelector("#devin-model")).toBeNull();
	expect(document.body.textContent).toContain("swe-2-high");
	expect(document.body.textContent).toContain("Routing page");
	await edit("devin-token", "second-token");
	expect(document.body.textContent).not.toContain("swe-2-high");
	expect(document.querySelector("#devin-model")).toBeNull();
	await submit();
	expect(saved.devin?.[0]?.apiKey).toBe("second-token");
	expect(saved.devin?.[0]?.modelMappings).toBeUndefined();
});
