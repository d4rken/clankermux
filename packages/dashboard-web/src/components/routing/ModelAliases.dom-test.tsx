import { afterEach, expect, it, mock, spyOn } from "bun:test";
import type { ModelAlias } from "@clankermux/types";
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
async function mount() {
	spyOn(api, "get").mockResolvedValue({ data: [alias] });
	spyOn(api, "getAccounts").mockResolvedValue([]);
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
