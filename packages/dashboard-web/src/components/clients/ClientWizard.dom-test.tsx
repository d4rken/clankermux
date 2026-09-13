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
		(b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === text,
	);
	if (!button) throw new Error(`Missing ${text}`);
	await act(async () => {
		button.click();
	});
}
function select(label: string) {
	const el = [...document.querySelectorAll("label")]
		.find((l) => l.textContent?.trim().startsWith(label))
		?.querySelector("select");
	if (!el) throw new Error(`Missing ${label} select`);
	return el;
}
async function choose(label: string, value: string) {
	const el = select(label);
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLSelectElement.prototype,
			"value",
		)?.set?.call(el, value);
		el.dispatchEvent(new Event("change", { bubbles: true }));
	});
}
async function type(id: string, value: string) {
	const input = document.getElementById(id) as HTMLInputElement;
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
function catalogueOf(format: string) {
	return reviewed?.catalogues[format as keyof ClientDraft["catalogues"]];
}
const DEFAULT_SUGGESTIONS = [
	{
		id: "new",
		displayName: "New model",
		accountIds: ["a"],
		codexMetadataAvailable: false,
	},
];
let suggested = DEFAULT_SUGGESTIONS;
let suggestionFetches = 0;
let suggestionBodies: unknown[] = [];
/** Set to hold the next suggestions response open until it is resolved. */
let gate: { release: () => void; opened: Promise<void> } | null = null;
function holdSuggestions() {
	let release = () => {};
	const opened = new Promise<void>((resolve) => {
		release = resolve;
	});
	gate = { release, opened };
	return () => {
		gate = null;
		release();
	};
}
async function mount(
	client: ClientView | null = existing,
	jump = false,
	models = DEFAULT_SUGGESTIONS,
) {
	reviewed = undefined;
	suggested = models;
	suggestionFetches = 0;
	suggestionBodies = [];
	gate = null;
	spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const path = String(input);
		if (path.endsWith("/suggestions")) {
			suggestionFetches += 1;
			suggestionBodies.push(JSON.parse(String(init?.body)));
			if (gate) await gate.opened;
			return Response.json({
				data: {
					models: suggested,
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
		}
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
				client={client ? structuredClone(client) : undefined}
				accounts={[{ id: "a", name: "Account", provider: "openai-compatible" }]}
				onCancel={() => {}}
				onSaved={() => {}}
			/>,
		);
	});
	if (!client) return;
	if (jump) await click("Catalogue");
	else {
		await click("Next");
		await click("Next");
	}
}
/** Mount a brand-new client, name it, and stop on the Application step. */
async function mountNew(models = DEFAULT_SUGGESTIONS) {
	await mount(null, false, models);
	await type("client-name", "Fresh");
}
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	mock.restore();
});
describe("client catalogue editing", () => {
	it("jumps straight to catalogues and preserves each format while navigating", async () => {
		await mount(existing, true);
		expect(document.body.textContent).toContain("1 selected");
		await click("Deselect all in tab");
		const tab = document.querySelector<HTMLButtonElement>(
			'[role="tab"][data-state="inactive"]',
		)!;
		await act(async () => {
			tab.dispatchEvent(
				new MouseEvent("mousedown", { bubbles: true, button: 0 }),
			);
			tab.click();
		});
		await click("Select all in tab");
		await choose("Default model for setup", "new");
		await click("Application");
		await click("Catalogue");
		await click("Review");
		expect(reviewed?.catalogues.openai.models).toEqual([]);
		expect(reviewed?.catalogues.anthropic.models.map((m) => m.id)).toEqual([
			"new",
		]);
	});

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
		await click("Deselect all in tab");
		await click("Review changes");
		expect(reviewed?.catalogues.openai).toMatchObject({
			models: [],
			defaultModel: null,
		});
	});
});

const RICH = [
	...DEFAULT_SUGGESTIONS,
	{
		id: "rich",
		displayName: "Rich model",
		accountIds: ["a"],
		codexMetadataAvailable: true,
	},
];

describe("new client setup defaults", () => {
	it("seeds only the application's own format and leaves the rest opt-in", async () => {
		await mountNew(RICH);
		await choose("Application", "codex");
		await click("Next");
		await click("Next");
		await choose("Default model for setup", "rich");
		await click("Review");
		expect(catalogueOf("codex")?.models.map((m) => m.id)).toEqual(["rich"]);
		expect(catalogueOf("codex")?.defaultModel).toBe("rich");
		expect(catalogueOf("openai")?.models).toEqual([]);
		expect(catalogueOf("anthropic")?.models).toEqual([]);
	});

	it("aliases seeded Claude Code entries and seeds nothing else", async () => {
		await mountNew();
		await choose("Application", "claude-code");
		await click("Next");
		await click("Next");
		await choose("Default model for setup", "claude-new");
		await click("Review");
		expect(catalogueOf("anthropic")?.models).toEqual([
			{
				id: "claude-new",
				displayName: "New model",
				targetModel: "new",
				accountIds: ["a"],
			},
		]);
		expect(catalogueOf("openai")?.models).toEqual([]);
	});

	it("moves an untouched seed to the new application's format", async () => {
		await mountNew(RICH);
		await click("Next");
		await click("Next");
		expect(document.body.textContent).toContain("2 selected");
		await click("Application");
		await choose("Application", "codex");
		await click("Catalogue");
		await choose("Default model for setup", "rich");
		await click("Review");
		expect(catalogueOf("openai")?.models).toEqual([]);
		expect(catalogueOf("codex")?.models.map((m) => m.id)).toEqual(["rich"]);
		// Destinations never changed, so the reseed reused the cached result.
		expect(suggestionFetches).toBe(1);
	});

	it("keeps an edited catalogue when the application changes", async () => {
		await mountNew(RICH);
		await click("Next");
		await click("Next");
		await click("Deselect all in tab");
		await click("Application");
		await choose("Application", "opencode");
		await click("Catalogue");
		await click("Review");
		expect(catalogueOf("openai")).toMatchObject({
			models: [],
			defaultModel: null,
		});
	});

	it("blocks review until every populated catalogue names a default", async () => {
		await mountNew();
		await click("Next");
		await click("Next");
		await click("Review");
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"OpenAI-style discovery",
		);
		expect(reviewed).toBeUndefined();
		await choose("Default model for setup", "new");
		await click("Review");
		expect(catalogueOf("openai")?.defaultModel).toBe("new");
	});

	it("withdraws a pending seed when the operator returns to a format they edited", async () => {
		await mountNew(RICH);
		await click("Next");
		await click("Next");
		await click("Deselect all in tab");
		await click("Application");
		// Away and straight back, never opening the catalogue in between.
		await choose("Application", "codex");
		await choose("Application", "generic");
		await click("Catalogue");
		expect(document.body.textContent).toContain("0 selected");
		await click("Review");
		expect(catalogueOf("openai")).toMatchObject({
			models: [],
			defaultModel: null,
		});
		expect(catalogueOf("codex")?.models).toEqual([]);
	});

	it("keeps a chosen default through a round trip to another application", async () => {
		await mountNew(RICH);
		await click("Next");
		await click("Next");
		await choose("Default model for setup", "rich");
		await click("Application");
		await choose("Application", "codex");
		await choose("Application", "generic");
		await click("Catalogue");
		await click("Review");
		expect(catalogueOf("openai")?.defaultModel).toBe("rich");
		expect(catalogueOf("openai")?.models.map((m) => m.id)).toEqual([
			"new",
			"rich",
		]);
	});

	it("locks the application and destination choices while discovery is in flight", async () => {
		await mountNew();
		let release = holdSuggestions();
		await click("Catalogue");
		expect(select("Application").disabled).toBe(true);
		await act(async () => release());
		await act(async () => {});
		await click("Destinations");
		await choose("Allowed destinations", "account");
		release = holdSuggestions();
		await click("Catalogue");
		expect(select("Allowed destinations").disabled).toBe(true);
		await act(async () => release());
		await act(async () => {});
		await click("Application");
		expect(select("Application").disabled).toBe(false);
	});

	it("reseeds from the new destinations rather than the cached suggestions", async () => {
		await mountNew(RICH);
		await click("Next");
		await click("Next");
		expect(suggestionBodies).toEqual([
			{ destinations: { accountId: null, providers: null }, refresh: false },
		]);
		await click("Destinations");
		await choose("Allowed destinations", "account");
		await click("Application");
		await choose("Application", "codex");
		await click("Catalogue");
		expect(suggestionBodies.at(-1)).toEqual({
			destinations: { accountId: "a", providers: null },
			refresh: false,
		});
		await choose("Default model for setup", "rich");
		await click("Review");
		expect(catalogueOf("codex")?.models.map((m) => m.id)).toEqual(["rich"]);
		expect(catalogueOf("openai")?.models).toEqual([]);
	});

	it("refuses to review a new client whose catalogue was never opened", async () => {
		await mountNew();
		await click("Review");
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"Choose your catalogue models before reviewing",
		);
		expect(reviewed).toBeUndefined();
		expect(suggestionBodies).toEqual([]);
	});

	it("requires reselection when the chosen default is removed", async () => {
		await mountNew(RICH);
		await click("Next");
		await click("Next");
		await choose("Default model for setup", "rich");
		const row = [...document.querySelectorAll("label")].find((el) =>
			el.textContent?.includes("Rich model"),
		);
		await act(async () => {
			row?.querySelector("input")?.click();
		});
		await click("Review");
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"OpenAI-style discovery",
		);
		expect(reviewed).toBeUndefined();
		await choose("Default model for setup", "new");
		await click("Review");
		expect(catalogueOf("openai")?.defaultModel).toBe("new");
	});

	it("never applies new-client seeding to an existing profile", async () => {
		const client = structuredClone(existing);
		client.application = "codex";
		client.catalogues.codex = {
			models: [
				{
					id: "kept",
					targetModel: "kept",
					displayName: "Kept model",
					accountIds: null,
					codexMetadata: { slug: "kept" },
				},
			],
			defaultModel: "kept",
		};
		await mount(client, true, RICH);
		await click("Application");
		await choose("Application", "generic");
		await click("Catalogue");
		await click("Review");
		expect(catalogueOf("codex")?.models).toEqual(
			client.catalogues.codex.models,
		);
		expect(catalogueOf("codex")?.defaultModel).toBe("kept");
		expect(catalogueOf("openai")).toMatchObject({
			models: [{ id: "old" }],
			defaultModel: "old",
		});
	});

	it("requires a default for a side catalogue the operator opted into", async () => {
		await mount(existing, true);
		const tab = document.querySelector<HTMLButtonElement>(
			'[role="tab"][data-state="inactive"]',
		)!;
		await act(async () => {
			tab.dispatchEvent(
				new MouseEvent("mousedown", { bubbles: true, button: 0 }),
			);
			tab.click();
		});
		await click("Select all in tab");
		await click("Review");
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"Anthropic-style discovery",
		);
		expect(reviewed).toBeUndefined();
		await choose("Default model for setup", "new");
		await click("Review");
		expect(catalogueOf("anthropic")?.defaultModel).toBe("new");
		expect(catalogueOf("openai")?.defaultModel).toBe("old");
	});
});
