import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../../api";
import { AccountAddForm } from "./AccountAddForm";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement | null = null;
let saved: Array<{ modelMappings?: Record<string, string> }> = [];
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

function renderForm(
	onAddAccount: () => Promise<{ authUrl: string; sessionId: string }>,
): Promise<void> {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	return act(async () => {
		root?.render(
			<AccountAddForm
				onAddAccount={onAddAccount}
				onCompleteAccount={async () => {}}
				onAddZaiAccount={async () => {}}
				onAddMinimaxAccount={async () => {}}
				onAddAnthropicCompatibleAccount={async () => {}}
				onAddOpenAIAccount={async (params) => {
					saved.push(params);
				}}
				onAddAlibabaCodingPlanAccount={async () => {}}
				onAddKiloAccount={async () => {}}
				onAddOpenRouterAccount={async () => {}}
				onAddOllamaAccount={async () => {}}
				onAddOllamaCloudAccount={async () => {}}
				onCancel={() => {}}
				onSuccess={() => {}}
				onError={() => {}}
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

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = null;
	host = null;
	saved = [];
	mock.restore();
});
async function edit(id: string, value: string) {
	await act(async () =>
		typeInto(document.querySelector(`#${id}`) as HTMLInputElement, value),
	);
}
async function mount() {
	await renderForm(async () => ({ authUrl: "", sessionId: "" }));
	await selectMode("OpenAI-Compatible");
	await edit("name", "preview-test");
	await edit("apiKey", "preview-api-key");
	await edit("endpoint", "https://first.example/v1");
}
async function fetchModels() {
	await act(async () =>
		byText<HTMLButtonElement>("button", "Fetch models").click(),
	);
}
const result = {
	models: [
		{ id: "first-model", displayName: "First model" },
		{ id: "second-model", displayName: "Second model" },
	],
};
function deferred() {
	let resolve!: (value: typeof result) => void;
	const promise = new Promise<typeof result>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("account model discovery", () => {
	it("preserves manual mappings on fetch and saves explicit choices", async () => {
		spyOn(api, "previewOpenAICompatibleModels").mockResolvedValue(result);
		await mount();
		await edit("opusModel", "custom-model");
		await fetchModels();
		expect(document.querySelectorAll("datalist option").length).toBe(2);
		expect(
			(document.querySelector("#opusModel") as HTMLInputElement).value,
		).toBe("custom-model");
		expect(
			(document.querySelector("#sonnetModel") as HTMLInputElement).value,
		).toBe("");
		await edit("sonnetModel", "second-model");
		await act(async () =>
			byText<HTMLButtonElement>("button", "Continue").click(),
		);
		expect(saved).toHaveLength(1);
		expect(saved[0].modelMappings).toEqual({
			opus: "custom-model",
			sonnet: "second-model",
		});
	});
	it.each([
		"apiKey",
		"endpoint",
	])("clears selections and ignores an old in-flight response when %s changes", async (field) => {
		const old = deferred();
		let signal: AbortSignal | undefined;
		spyOn(api, "previewOpenAICompatibleModels")
			.mockImplementationOnce((_payload, s) => {
				signal = s;
				return old.promise;
			})
			.mockResolvedValue(result);
		await mount();
		await edit("opusModel", "old-model");
		await fetchModels();
		await edit(
			field,
			field === "apiKey" ? "new-api-key" : "https://second.example/v1",
		);
		expect(signal?.aborted).toBe(true);
		expect(
			(document.querySelector("#opusModel") as HTMLInputElement).value,
		).toBe("");
		await fetchModels();
		await act(async () =>
			old.resolve({ models: [{ id: "stale", displayName: "Stale" }] }),
		);
		expect(document.querySelector("datalist")?.textContent).not.toContain(
			"Stale",
		);
		expect(document.querySelectorAll("datalist option").length).toBe(2);
	});
	it("invalidates settled previews and clears mappings when the provider changes", async () => {
		spyOn(api, "previewOpenAICompatibleModels").mockResolvedValue(result);
		await mount();
		await fetchModels();
		await edit("opusModel", "first-model");
		await edit("endpoint", "https://second.example/v1");
		expect(document.querySelectorAll("datalist option").length).toBe(0);
		expect(
			(document.querySelector("#opusModel") as HTMLInputElement).value,
		).toBe("");
		await edit("opusModel", "second-model");
		await selectMode("Anthropic-Compatible");
		await edit("opusModel", "anthropic-model");
		await selectMode("OpenAI-Compatible");
		expect(
			(document.querySelector("#opusModel") as HTMLInputElement).value,
		).toBe("");
		expect(document.querySelectorAll("datalist option").length).toBe(0);
	});
	it("keeps manual entry usable after discovery fails", async () => {
		spyOn(api, "previewOpenAICompatibleModels").mockRejectedValue(
			new Error("Endpoint rejected the API key."),
		);
		await mount();
		await fetchModels();
		expect(host?.textContent).toContain(
			"You can still enter model IDs manually",
		);
		await edit("haikuModel", "manual-model");
		await act(async () =>
			byText<HTMLButtonElement>("button", "Continue").click(),
		);
		expect(saved[0].modelMappings).toEqual({ haiku: "manual-model" });
	});
	it("cancels discovery when switching provider and ignores its late response", async () => {
		const old = deferred();
		let signal: AbortSignal | undefined;
		spyOn(api, "previewOpenAICompatibleModels").mockImplementation(
			(_payload, s) => {
				signal = s;
				return old.promise;
			},
		);
		await mount();
		await fetchModels();
		await selectMode("Claude CLI OAuth");
		expect(signal?.aborted).toBe(true);
		await act(async () => old.resolve(result));
		await selectMode("OpenAI-Compatible");
		expect(document.querySelectorAll("datalist option").length).toBe(0);
	});
});
