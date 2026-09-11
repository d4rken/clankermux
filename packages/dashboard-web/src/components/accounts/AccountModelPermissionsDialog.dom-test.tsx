import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type Account, api } from "../../api";
import { AccountModelPermissionsDialog } from "./AccountModelPermissionsDialog";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient;
const data = {
	account_id: "account-a",
	generation: 7,
	completeness: "known-complete",
	discovered_ids: ["gpt-6-astra"],
	manual_ids: ["manual-model"],
	last_success_at: 100,
	last_attempt_at: 100,
	last_error: null,
};
async function mount(value = { ...data }) {
	spyOn(api, "get").mockImplementation(async () => ({ data: value }) as never);
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
			mutations: { retry: false },
		},
	});
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<QueryClientProvider client={client}>
				<AccountModelPermissionsDialog
					isOpen
					account={{ id: "account-a", name: "Experiment" } as Account}
					onOpenChange={() => {}}
				/>
			</QueryClientProvider>,
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
}
async function click(text: string) {
	const b = Array.from(document.querySelectorAll("button")).find(
		(el) => el.textContent === text,
	);
	if (!b) throw new Error(`Missing ${text}`);
	await act(async () => b.click());
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
}
async function edit(value: string) {
	await act(async () => {
		const input = document.querySelector("textarea");
		if (!input) throw new Error("Missing manual model editor");
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	client?.clear();
	root = null;
	mock.restore();
});
describe("account permitted models", () => {
	it("shows account discovery separately from manual additions and submits the edit generation", async () => {
		const put = spyOn(api, "put").mockResolvedValue({});
		await mount();
		expect(document.body.textContent).toContain("gpt-6-astra");
		expect(document.querySelector("textarea")?.value).toBe("manual-model");
		await edit("manual-model\n meta/muse-spark-1.3 \n");
		await click("Save manual models");
		expect(put).toHaveBeenCalledWith(
			"/api/accounts/account-a/model-permissions",
			{
				manual_ids: ["manual-model", "meta/muse-spark-1.3"],
				generation: 7,
				declare_empty: false,
			},
		);
	});
	it("refreshes only the saved account endpoint and retains saved manual models", async () => {
		const post = spyOn(api, "post").mockResolvedValue({});
		await mount();
		await click("Refresh discovery");
		expect(post).toHaveBeenCalledWith(
			"/api/accounts/account-a/model-permissions",
			{},
		);
		expect(document.querySelector("textarea")?.value).toBe("manual-model");
	});
	it("keeps a rejected stale edit visible with its original generation", async () => {
		const put = spyOn(api, "put").mockRejectedValue(
			new Error("Permissions changed; reload before saving"),
		);
		await mount();
		await edit("new-model");
		await click("Save manual models");
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"Permissions changed",
		);
		expect(document.querySelector("textarea")?.value).toBe("new-model");
		expect(put.mock.calls[0]?.[1]).toMatchObject({ generation: 7 });
	});
	it("distinguishes unknown discovery from an explicit empty permission set", async () => {
		const put = spyOn(api, "put").mockResolvedValue({});
		await mount({
			...data,
			completeness: "unknown",
			manual_ids: [],
			discovered_ids: [],
			last_success_at: null,
		} as never);
		expect(document.body.textContent).toContain("Unknown");
		await act(async () =>
			document
				.querySelector<HTMLInputElement>('input[type="checkbox"]')
				?.click(),
		);
		await click("Save manual models");
		expect(put.mock.calls[0]?.[1]).toMatchObject({
			manual_ids: [],
			declare_empty: true,
		});
	});
});
