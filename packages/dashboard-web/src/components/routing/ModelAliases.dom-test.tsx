import { afterEach, expect, it, mock, spyOn } from "bun:test";
import type { ClientSuggestions, ModelAlias } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../../api";
import { ModelAliases } from "./ModelAliases";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLElement | undefined;
let client: QueryClient;
const alias: ModelAlias = {
	id: "alias:good-model",
	displayName: "Good model",
	revision: 4,
	targets: [
		{ model: "fable", accountIds: null },
		{ model: "gpt-6-astra", accountIds: ["a"] },
	],
};
async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
}
async function click(label: string) {
	const button = [...document.querySelectorAll("button")].find(
		(b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === label,
	);
	if (!button) throw new Error(`Missing ${label}`);
	await act(async () => button.click());
	await settle();
}
const suggestions: ClientSuggestions = {
	models: [
		{
			id: "fable",
			displayName: "Fable",
			accountIds: ["a", "b"],
			codexMetadataAvailable: false,
		},
		{
			id: "gpt-6-astra",
			displayName: "GPT-6 Astra",
			accountIds: ["a"],
			codexMetadataAvailable: true,
		},
		{
			id: "fast-only",
			displayName: "Fast",
			accountIds: ["b"],
			codexMetadataAvailable: false,
		},
		{
			id: "alias:good-model",
			displayName: "Good model",
			accountIds: ["a", "b"],
			codexMetadataAvailable: true,
		},
	],
	accounts: [],
};
function options(index: number): string[] {
	const input = document.getElementById(`alias-target-${index}`);
	const list = input?.getAttribute("list");
	expect(list).toBeTruthy();
	return [
		...(document.getElementById(list ?? "")?.querySelectorAll("option") ?? []),
	].map((option) => option.value);
}
async function typeModel(index: number, value: string) {
	const input = document.getElementById(
		`alias-target-${index}`,
	) as HTMLInputElement;
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function mount() {
	spyOn(api, "get").mockResolvedValue({ data: [alias] });
	spyOn(api, "getAccounts").mockResolvedValue([
		{ id: "a", name: "First account", provider: "codex" },
		{ id: "b", name: "Second account", provider: "anthropic" },
	] as never);
	spyOn(api, "post").mockResolvedValue({ data: suggestions });
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
			mutations: { retry: false },
		},
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<ModelAliases />
			</QueryClientProvider>,
		),
	);
	await settle();
}
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	client?.clear();
	mock.restore();
});
it("saves reordered targets with their account restrictions and edit revision", async () => {
	await mount();
	const save = spyOn(api, "put").mockResolvedValue({ data: alias });
	await click("Edit Good model");
	await click("Move target 2 up");
	await click("Save alias");
	expect(save).toHaveBeenCalledWith("/api/model-aliases/alias%3Agood-model", {
		...alias,
		targets: [alias.targets[1], alias.targets[0]],
	});
});
it("preserves the draft and shows revision conflict instead of closing the editor", async () => {
	await mount();
	spyOn(api, "put").mockRejectedValue(
		new Error("Model alias changed; reload before saving"),
	);
	await click("Edit Good model");
	await click("Save alias");
	expect(document.querySelector('[role="dialog"]')).not.toBeNull();
	expect(document.body.textContent).toContain(
		"Model alias changed; reload before saving",
	);
});
it("deletes with the displayed revision", async () => {
	await mount();
	const remove = spyOn(api, "delete").mockResolvedValue({ success: true });
	await click("Delete Good model");
	expect(remove).toHaveBeenCalledWith("/api/model-aliases/alias%3Agood-model", {
		body: JSON.stringify({ revision: 4 }),
		headers: { "Content-Type": "application/json" },
	});
});

it("loads concrete model suggestions only when the editor opens and scopes them per target", async () => {
	await mount();
	expect(api.post).not.toHaveBeenCalled();
	await click("Edit Good model");
	expect(api.post).toHaveBeenCalledWith("/api/clients/suggestions", {
		destinations: { accountId: null, providers: null },
		refresh: false,
	});
	expect(options(0)).toEqual(["fable", "gpt-6-astra", "fast-only"]);
	expect(options(1)).toEqual(["fable", "gpt-6-astra"]);
	const secondAccount = [...document.querySelectorAll("label")]
		.find((label) => label.textContent?.trim() === "Second account (anthropic)")
		?.querySelector<HTMLInputElement>("input");
	if (!secondAccount) throw new Error("Missing account checkbox");
	await act(async () => secondAccount.click());
	expect(options(1)).toContain("fast-only");
	await click("Move target 2 up");
	expect(options(0)).toContain("fast-only");
	expect(
		(document.getElementById("alias-target-0") as HTMLInputElement).value,
	).toBe("gpt-6-astra");
});

it("offers suggestions for new aliases and added fallback inputs", async () => {
	await mount();
	await click("Add alias");
	expect(options(0)).toEqual(["fable", "gpt-6-astra", "fast-only"]);
	await click("Add fallback");
	expect(options(1)).toEqual(options(0));
	await typeModel(1, "fast-only");
	expect(
		(document.getElementById("alias-target-1") as HTMLInputElement).value,
	).toBe("fast-only");
});

it("allows an unlisted model to be saved when suggestions fail", async () => {
	await mount();
	spyOn(api, "post").mockRejectedValue(new Error("Discovery unavailable"));
	const save = spyOn(api, "put").mockResolvedValue({ data: alias });
	await click("Edit Good model");
	expect(document.body.textContent).toContain("Model suggestions unavailable");
	await typeModel(0, "custom-model-id");
	await click("Save alias");
	expect(save).toHaveBeenCalledWith("/api/model-aliases/alias%3Agood-model", {
		...alias,
		targets: [{ model: "custom-model-id", accountIds: null }, alias.targets[1]],
	});
});
