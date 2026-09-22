import { afterEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AccountAddForm } from "./AccountAddForm";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface MimoAccountParams {
	name: string;
	apiKey: string;
	priority: number;
	customEndpoint?: string;
}

const MODE_OPTION = "MiMo Token Plan (API Key)";

let root: Root | null = null;
let host: HTMLElement | null = null;
let saved: MimoAccountParams[] = [];
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

/**
 * The whole form, not the fields component alone: what has to hold is that the
 * region chosen in the dropdown is the endpoint the API call receives, and the
 * submit path that builds that call lives in AccountAddForm.
 */
function renderForm(): Promise<void> {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	return act(async () => {
		root?.render(
			<AccountAddForm
				onAddAccount={async () => ({ authUrl: "", sessionId: "" })}
				onCompleteAccount={async () => {}}
				onAddZaiAccount={async () => {}}
				onAddMinimaxAccount={async () => {}}
				onAddAnthropicCompatibleAccount={async () => {}}
				onAddOpenAIAccount={async () => {}}
				onAddAlibabaCodingPlanAccount={async () => {}}
				onAddKiloAccount={async () => {}}
				onAddOpenRouterAccount={async () => {}}
				onAddOllamaAccount={async () => {}}
				onAddOllamaCloudAccount={async () => {}}
				onAddGrokAccount={async () => {}}
				onAddMimoAccount={async (params: MimoAccountParams) => {
					saved.push(params);
				}}
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
 * Pick from a Radix Select by keyboard. It has no native `<select>` behind it,
 * and happy-dom has no pointer stack, so ArrowDown to open and Enter on the
 * option is the only way in.
 */
async function pick(triggerId: string, optionText: string): Promise<void> {
	const trigger = document.querySelector(`#${triggerId}`) as HTMLElement;
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

/** Select the MiMo mode and fill in the fields every case needs. */
async function startMimoAccount(): Promise<void> {
	await renderForm();
	await pick("mode", MODE_OPTION);
	await edit("name", "mimo-account");
	await edit("apiKey", "tp-secret");
}

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = null;
	host = null;
	saved = [];
	errors = [];
	mock.restore();
});

// Mutable, not `as const`: bun's `it.each` single-argument overload takes a
// `T[]`, so a readonly tuple matches none of its three overloads.
const regions = [
	{
		option: "Singapore (token-plan-sgp)",
		endpoint: "https://token-plan-sgp.xiaomimimo.com/anthropic",
	},
	{
		option: "China (token-plan-cn)",
		endpoint: "https://token-plan-cn.xiaomimimo.com/anthropic",
	},
	{
		option: "Europe (token-plan-ams)",
		endpoint: "https://token-plan-ams.xiaomimimo.com/anthropic",
	},
];

describe("MiMo Token Plan account fields", () => {
	it("renders a password API key field and no endpoint field until one is asked for", async () => {
		await renderForm();
		await pick("mode", MODE_OPTION);
		const apiKey = document.querySelector("#apiKey") as HTMLInputElement | null;
		expect(apiKey).not.toBeNull();
		expect(apiKey?.type).toBe("password");
		expect(document.querySelector("#customEndpoint")).toBeNull();
		expect(document.querySelector("#mimo-region")).not.toBeNull();
	});

	it.each(regions)("submits the $option base URL", async ({
		option,
		endpoint,
	}) => {
		await startMimoAccount();
		await pick("mimo-region", option);
		await submit();
		expect(errors).toEqual([]);
		expect(saved).toEqual([
			{
				name: "mimo-account",
				apiKey: "tp-secret",
				priority: 0,
				customEndpoint: endpoint,
			},
		]);
	});

	it("omits the endpoint entirely when no region is picked", async () => {
		await startMimoAccount();
		await submit();
		expect(errors).toEqual([]);
		expect(saved).toHaveLength(1);
		expect(saved[0]).not.toHaveProperty("customEndpoint");
	});

	it("omits the endpoint when the override is chosen but left blank", async () => {
		await startMimoAccount();
		await pick("mimo-region", "Other (enter a base URL)");
		await submit();
		expect(errors).toEqual([]);
		expect(saved).toHaveLength(1);
		expect(saved[0]).not.toHaveProperty("customEndpoint");
	});

	it("submits a base URL typed into the override field", async () => {
		await startMimoAccount();
		await pick("mimo-region", "Other (enter a base URL)");
		await edit(
			"customEndpoint",
			"https://token-plan-jp.xiaomimimo.com/anthropic",
		);
		await submit();
		expect(errors).toEqual([]);
		expect(saved).toEqual([
			{
				name: "mimo-account",
				apiKey: "tp-secret",
				priority: 0,
				customEndpoint: "https://token-plan-jp.xiaomimimo.com/anthropic",
			},
		]);
	});

	it("drops a region picked before the mode changed away from MiMo", async () => {
		await startMimoAccount();
		await pick("mimo-region", "China (token-plan-cn)");
		await pick("mode", "Grok (API Key)");
		expect(document.querySelector("#mimo-region")).toBeNull();
		await pick("mode", MODE_OPTION);
		await edit("apiKey", "tp-secret");
		await submit();
		expect(errors).toEqual([]);
		expect(saved).toHaveLength(1);
		expect(saved[0]).not.toHaveProperty("customEndpoint");
	});
});
