import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ClientDraft, ClientView } from "@clankermux/types";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ClientWizard } from "./ClientWizard";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let reviewed: ClientDraft | undefined;
const existing: ClientView = {
	apiKeyId: "key",
	application: "generic",
	revision: 1,
	notices: [],
	aliasRules: [],
	key: {
		id: "key",
		name: "Client",
		prefixLast8: "abcdefgh",
		createdAt: "2026-01-01",
		lastUsed: null,
		usageCount: 0,
		isActive: true,
		pinnedAccountId: null,
		pinnedProviders: null,
	},
	catalogues: {
		anthropic: { models: [], defaultModel: null },
		openai: {
			models: [
				{
					id: "old",
					targetModel: "old",
					displayName: "Old model",
					accountIds: null,
				},
			],
			defaultModel: "old",
		},
		codex: { models: [], defaultModel: null },
	},
};
async function click(text: string) {
	const button = [...document.querySelectorAll("button")].find(
		(b) => b.textContent?.trim() === text,
	);
	if (!button) throw new Error(`Missing ${text}`);
	await act(async () => {
		button.click();
	});
}
async function mount(client = existing) {
	reviewed = undefined;
	spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const path = String(input);
		if (path.endsWith("/suggestions"))
			return Response.json({
				data: {
					models: [
						{
							id: "new",
							displayName: "New model",
							accountIds: ["a"],
							codexMetadataAvailable: false,
						},
					],
					accounts: [
						{
							id: "a",
							name: "Account",
							provider: "openai-compatible",
							completeness: "known-complete",
							error: null,
						},
					],
				},
			});
		if (path.endsWith("/review")) {
			reviewed = JSON.parse(String(init?.body));
			return Response.json({
				data: {
					token: "review",
					draft: reviewed,
					aliasRules: [],
					precedingRules: [],
					notices: [],
				},
			});
		}
		throw new Error(`Unexpected request ${path}`);
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<ClientWizard
				client={structuredClone(client)}
				accounts={[{ id: "a", name: "Account", provider: "openai-compatible" }]}
				onCancel={() => {}}
				onSaved={() => {}}
			/>,
		);
	});
	await click("Next");
	await click("Next");
}
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	mock.restore();
});
describe("client catalogue editing", () => {
	it("keeps new discoveries unselected during refresh", async () => {
		await mount();
		await click("Refresh suggestions");
		expect(document.body.textContent).toContain("1 selected");
		await click("Review changes");
		expect(reviewed?.catalogues.openai.models.map((m) => m.id)).toEqual([
			"old",
		]);
	});
	it("edits an existing display name and preserves its model identity", async () => {
		await mount();
		const buttons = [...document.querySelectorAll("button")].filter(
			(b) => b.textContent?.trim() === "Edit",
		);
		expect(buttons.length).toBe(2);
		await act(async () => {
			buttons.at(-1)?.click();
		});
		expect(
			(document.getElementById("model-id") as HTMLInputElement).value,
		).toBe("old");
		const input = document.getElementById("display-name") as HTMLInputElement;
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(input, "Renamed model");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await click("Update selection");
		await click("Review changes");
		expect(reviewed?.catalogues.openai.models).toEqual([
			{
				id: "old",
				targetModel: "old",
				displayName: "Renamed model",
				accountIds: null,
			},
		]);
	});
	it("shows every destination conflict and allows removing excluded alias accounts", async () => {
		const client = structuredClone(existing);
		client.key.pinnedAccountId = "a";
		client.catalogues.openai.models = [
			{
				id: "alias-one",
				targetModel: "upstream",
				displayName: "Alias one",
				accountIds: ["a", "excluded"],
			},
		];
		client.catalogues.anthropic.models = [
			{
				id: "alias-two",
				targetModel: "upstream",
				displayName: "Alias two",
				accountIds: ["excluded"],
			},
		];
		client.aliasRules = [
			{
				id: "retained",
				name: "Hidden alias route",
				position: 0,
				enabled: true,
				match_api_key_id: "key",
				match_model_kind: "exact",
				match_model_value: "hidden",
				pool_kind: "accounts",
				pool_account_ids: ["excluded"],
				pool_provider: null,
				target_kind: "literal",
				target_model: "upstream",
			},
		];
		await mount(client);
		const warning = document.querySelector('[role="alert"]');
		expect(warning?.textContent).toContain("alias-one");
		expect(warning?.textContent).toContain("alias-two");
		expect(warning?.textContent).toContain("Hidden alias route");
		const row = [...document.querySelectorAll("label")].find((el) =>
			el.textContent?.includes("Alias one"),
		);
		const button = row?.parentElement?.querySelector("button");
		await act(async () => {
			button?.click();
		});
		const excluded = [...document.querySelectorAll("label")].find((el) =>
			el.textContent?.includes("excluded (outside destinations)"),
		);
		const checkbox = excluded?.querySelector("input");
		expect(checkbox?.checked).toBe(true);
		await act(async () => {
			checkbox?.click();
		});
		await click("Update selection");
		expect(document.querySelector('[role="alert"]')?.textContent).not.toContain(
			"alias-one",
		);
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"alias-two",
		);
	});
	it("flags aliases with no destination and retained provider rules with no eligible account", async () => {
		const client = structuredClone(existing);
		client.key.pinnedAccountId = "missing";
		client.catalogues.openai.models = [
			{
				id: "empty-alias",
				targetModel: "upstream",
				displayName: "Empty alias",
				accountIds: null,
			},
		];
		client.aliasRules = [
			{
				id: "provider-rule",
				name: "Provider route",
				position: 0,
				enabled: true,
				match_api_key_id: "key",
				match_model_kind: "exact",
				match_model_value: "hidden",
				pool_kind: "provider",
				pool_account_ids: null,
				pool_provider: "codex",
				target_kind: "literal",
				target_model: "upstream",
			},
		];
		await mount(client);
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"empty-alias",
		);
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"Provider route",
		);
	});
	it("explicitly empties the list and clears a now-hidden default", async () => {
		await mount();
		await click("Deselect all");
		await click("Review changes");
		expect(reviewed?.catalogues.openai).toMatchObject({
			models: [],
			defaultModel: null,
		});
	});
});
