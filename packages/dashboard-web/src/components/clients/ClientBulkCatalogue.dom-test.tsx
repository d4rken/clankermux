import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ClientModel, ClientView } from "@clankermux/types";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ClientBulkCatalogue } from "./ClientBulkCatalogue";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let done = 0;
let appliedWith: ClientView[] | null = null;
let posted: { path: string; body: unknown }[] = [];
let reviewResponse: unknown = null;
let commitResponse: ClientView[] = [];

const client = (id: string, models: ClientModel[]): ClientView => ({
	apiKeyId: id,
	application: "generic",
	revision: 1,
	notices: [],
	aliasRules: [],
	key: {
		id,
		name: `Client ${id}`,
		application: null,
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
		openai: { models, defaultModel: null },
		codex: { models: [], defaultModel: null },
	},
});
const shared: ClientModel = {
	id: "shared",
	displayName: "Shared",
	targetModel: "shared",
	accountIds: null,
};
const alpha = client("alpha", [
	shared,
	{
		id: "fast",
		displayName: "Fast",
		targetModel: "target-a",
		accountIds: ["a"],
	},
]);
const bravo = client("bravo", [
	shared,
	{
		id: "fast",
		displayName: "Fast",
		targetModel: "target-b",
		accountIds: ["a"],
	},
]);

/** The one "changed" preview the review tests reuse. */
const previewWithEverything = {
	token: "bulk-token",
	operation: {
		format: "openai",
		mode: "replace",
		models: [
			{
				id: "fast",
				displayName: "Fast",
				targetModel: "target-z",
				accountIds: ["a"],
			},
		],
	},
	clients: [
		{
			apiKeyId: "alpha",
			name: "Client alpha",
			status: "changed",
			reason: null,
			added: ["added-one"],
			removed: ["removed-one"],
			modified: ["fast"],
			defaultModelChange: { from: "shared", to: null },
			notices: ["Removing a discovery entry retains its alias route."],
		},
		{
			apiKeyId: "bravo",
			name: "Client bravo",
			status: "unchanged",
			reason: null,
			added: [],
			removed: [],
			modified: [],
			defaultModelChange: null,
			notices: [],
		},
		{
			apiKeyId: "charlie",
			name: "Client charlie",
			status: "rejected",
			reason: "Rule Manual pin conflicts with API key destinations",
			added: [],
			removed: [],
			modified: [],
			defaultModelChange: null,
			notices: [],
		},
	],
};

async function mount(clients: ClientView[] = [alpha, bravo]) {
	posted = [];
	done = 0;
	appliedWith = null;
	spyOn(globalThis, "fetch").mockImplementation((async (
		input: unknown,
		init?: { body?: unknown },
	) => {
		const path = String(input);
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		posted.push({ path, body });
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
					accounts: [],
				},
			});
		if (path.endsWith("/bulk/review"))
			return Response.json({
				data: reviewResponse ?? {
					token: "bulk-token",
					operation: body.operation,
					clients: clients.map((c) => ({
						apiKeyId: c.apiKeyId,
						name: c.key.name,
						status: "changed",
						reason: null,
						added: ["new"],
						removed: [],
						modified: [],
						defaultModelChange: null,
						notices: [],
					})),
				},
			});
		if (path.endsWith("/bulk/commit"))
			return Response.json({ data: { clients: commitResponse } });
		throw new Error(`Unexpected request ${path}`);
	}) as unknown as typeof fetch);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await rerender(clients);
	// Let the suggestions request settle before anything reads the candidates.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
/** Re-render the open panel with a different set of selected clients. */
async function rerender(clients: ClientView[]) {
	await act(async () => {
		root?.render(
			<ClientBulkCatalogue
				clients={clients}
				accounts={[
					{ id: "a", name: "Account A", provider: "openai-compatible" },
				]}
				onCancel={() => {}}
				onApplied={(clients) => {
					done += 1;
					appliedWith = clients;
				}}
			/>,
		);
	});
}
function button(label: string): HTMLButtonElement {
	const found = [...document.querySelectorAll("button")].find(
		(b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === label,
	);
	if (!found) throw new Error(`Missing button ${label}`);
	return found;
}
async function click(label: string) {
	const target = button(label);
	await act(async () => {
		target.click();
	});
}
function checkbox(label: string): HTMLInputElement {
	const found = document.querySelector<HTMLInputElement>(
		`input[type="checkbox"][aria-label="${label}"]`,
	);
	if (!found) throw new Error(`Missing checkbox ${label}`);
	return found;
}
async function check(label: string) {
	const box = checkbox(label);
	await act(async () => {
		box.click();
	});
}
async function choose(label: string, value: string) {
	const el = document.querySelector<HTMLSelectElement>(
		`select[aria-label="${label}"]`,
	);
	if (!el) throw new Error(`Missing select ${label}`);
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLSelectElement.prototype,
			"value",
		)?.set?.call(el, value);
		el.dispatchEvent(new Event("change", { bubbles: true }));
	});
}
async function typeInto(selector: string, value: string) {
	const input = document.querySelector<HTMLInputElement>(selector);
	if (!input) throw new Error(`Missing input ${selector}`);
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
const filterModels = (value: string) => typeInto('input[type="search"]', value);
async function stageCustom(fields: {
	id: string;
	target?: string;
	name?: string;
	destination?: string;
}) {
	await typeInto("#bulk-model-id", fields.id);
	await typeInto("#bulk-target-id", fields.target ?? "");
	await typeInto("#bulk-display-name", fields.name ?? "");
	if (fields.destination) {
		const label = [...document.querySelectorAll("label")].find(
			(l) => l.textContent?.trim() === fields.destination,
		);
		const box = label?.querySelector("input");
		if (!box) throw new Error(`Missing destination ${fields.destination}`);
		await act(async () => {
			box.click();
		});
	}
	await click("Add to list");
}
const rows = () =>
	[...document.querySelectorAll("[data-candidate]")].map((n) =>
		n.getAttribute("data-candidate"),
	);
const rowText = (id: string) =>
	document.querySelector(`[data-candidate="${id}"]`)?.textContent ?? "";

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	reviewResponse = null;
	commitResponse = [];
	mock.restore();
});

describe("bulk catalogue editing", () => {
	it("unions the selected clients' entries with suggestions and counts coverage", async () => {
		await mount();
		expect(posted).toEqual([
			{
				path: "/api/clients/suggestions",
				body: {
					destinations: { accountId: null, providers: null },
					refresh: false,
				},
			},
		]);
		expect(rows()).toEqual(["fast", "new", "shared"]);
		expect(rowText("shared")).toContain("In 2 of 2");
		expect(rowText("new")).toContain("In 0 of 2");
		expect(document.body.textContent).toContain("Edit catalogues");
		expect(document.body.textContent).toContain("Client alpha");
	});

	it("refuses to add an ID the selected clients define differently, but still removes it", async () => {
		await mount();
		expect(rowText("fast")).toContain("Defined differently in 2 clients");
		await check("Select fast");
		expect(button("Add to all selected").disabled).toBe(true);
		expect(button("Remove from all selected").disabled).toBe(false);
		await check("Select fast");
		await check("Select shared");
		expect(button("Add to all selected").disabled).toBe(false);
	});

	it("posts the checked entries as an add operation", async () => {
		await mount();
		expect(button("Add to all selected").disabled).toBe(true);
		await check("Select new");
		await click("Add to all selected");
		expect(posted.at(-1)).toEqual({
			path: "/api/clients/bulk/review",
			body: {
				clientIds: ["alpha", "bravo"],
				operation: {
					format: "openai",
					mode: "add",
					models: [
						{
							id: "new",
							displayName: "New model",
							targetModel: "new",
							accountIds: null,
						},
					],
				},
			},
		});
	});

	it("narrows the rendered rows to the filter and reports how many it shows", async () => {
		await mount();
		await filterModels("FAST");
		expect(rows()).toEqual(["fast"]);
		expect(document.body.textContent).toContain("1 of 3 shown");
		await filterModels("no such model");
		expect(rows()).toEqual([]);
		expect(document.body.textContent).toContain("No models match this filter.");
		await click("Clear");
		expect(rows()).toEqual(["fast", "new", "shared"]);
	});

	it("keeps a checked entry the filter hides in the posted operation", async () => {
		await mount();
		await check("Select new");
		await filterModels("shared");
		expect(rows()).toEqual(["shared"]);
		expect(document.body.textContent).toContain(
			"1 selected · 1 hidden by the filter",
		);
		await click("Add to all selected");
		expect(posted.at(-1)?.body).toMatchObject({
			operation: { mode: "add", models: [{ id: "new" }] },
		});
	});

	it("previews every outcome and applies only when something changes", async () => {
		reviewResponse = previewWithEverything;
		await mount();
		await check("Select shared");
		await click("Remove from all selected");
		expect(document.body.textContent).toContain("1 of 3 clients will change");
		const preview = document.querySelector('[aria-label="Bulk edit preview"]');
		expect(preview?.textContent).toContain("added-one");
		expect(preview?.textContent).toContain("removed-one");
		// A repointed ID is only visible through `modified`; the added and removed
		// sets are identical on both sides of it.
		expect(preview?.textContent).toContain("fast: target-a → target-z");
		expect(preview?.textContent).toContain("Default model cleared");
		expect(preview?.textContent).toContain(
			"Rule Manual pin conflicts with API key destinations",
		);
		expect(preview?.textContent).toContain(
			"Removing a discovery entry retains its alias route.",
		);
		await click("Apply to 1 client");
		expect(posted.at(-1)).toEqual({
			path: "/api/clients/bulk/commit",
			body: { token: "bulk-token" },
		});
		expect(done).toBe(1);
		// Still open, ready for the second half of a remove-then-add swap.
		expect(document.body.textContent).toContain("Applied to 1 client.");
		expect(rows()).toEqual(["fast", "new", "shared"]);
		expect(checkbox("Select shared").checked).toBe(false);
	});

	it("hands the committed clients to the caller", async () => {
		commitResponse = [client("alpha", [shared])];
		await mount();
		await check("Select shared");
		await click("Add to all selected");
		await click("Apply to 2 clients");
		expect(appliedWith).toEqual(commitResponse);
	});

	it("disables apply when no client would change, and goes back with the selection intact", async () => {
		reviewResponse = {
			token: "bulk-token",
			operation: { format: "openai", mode: "add", models: [] },
			clients: [
				{
					apiKeyId: "alpha",
					name: "Client alpha",
					status: "unchanged",
					reason: null,
					added: [],
					removed: [],
					modified: [],
					defaultModelChange: null,
					notices: [],
				},
			],
		};
		await mount();
		await check("Select shared");
		await click("Add to all selected");
		expect(button("Apply to 0 clients").disabled).toBe(true);
		await click("Back");
		expect(checkbox("Select shared").checked).toBe(true);
	});

	it("sends no replace until the confirmation, and starts from that client's own entries", async () => {
		await mount();
		await choose("Start from", "alpha");
		await click("Replace catalogue for 2 clients");
		expect(posted.map((p) => p.path)).toEqual(["/api/clients/suggestions"]);
		await click("Replace catalogues");
		expect(posted.at(-1)).toEqual({
			path: "/api/clients/bulk/review",
			body: {
				clientIds: ["alpha", "bravo"],
				operation: {
					format: "openai",
					mode: "replace",
					// alpha's own definition of `fast`, not whichever one won the
					// deduplicated union that bravo also contributes to.
					models: [
						shared,
						{
							id: "fast",
							displayName: "Fast",
							targetModel: "target-a",
							accountIds: ["a"],
						},
					],
					defaultModel: null,
				},
			},
		});
	});
});

describe("custom batch entries", () => {
	it("stages an alias no client publishes, checks it, and posts it whole", async () => {
		await mount();
		await stageCustom({
			id: "shared[1m]",
			target: "shared",
			name: "Shared long context",
			destination: "Account A",
		});
		expect(rows()).toEqual(["fast", "new", "shared", "shared[1m]"]);
		expect(checkbox("Select shared[1m]").checked).toBe(true);
		expect(rowText("shared[1m]")).toContain("Custom");
		expect(rowText("shared[1m]")).toContain("In 0 of 2");
		await click("Add to all selected");
		expect(posted.at(-1)).toEqual({
			path: "/api/clients/bulk/review",
			body: {
				clientIds: ["alpha", "bravo"],
				operation: {
					format: "openai",
					mode: "add",
					models: [
						{
							id: "shared[1m]",
							displayName: "Shared long context",
							targetModel: "shared",
							accountIds: ["a"],
						},
					],
				},
			},
		});
	});

	it("takes a staged entry back out of the list and the selection", async () => {
		await mount();
		await stageCustom({ id: "typo" });
		expect(checkbox("Select typo").checked).toBe(true);
		await click("Remove typo from the list");
		expect(rows()).toEqual(["fast", "new", "shared"]);
		expect(button("Add to all selected").disabled).toBe(true);
	});

	it("refuses a colliding ID and an alias with no destination", async () => {
		await mount();
		const requests = posted.length;
		await stageCustom({ id: "shared" });
		expect(document.body.textContent).toContain(
			"shared is already in this list",
		);
		await stageCustom({ id: "shared-1m", target: "shared" });
		expect(document.body.textContent).toContain(
			"Choose at least one destination for an alias",
		);
		expect(rows()).toEqual(["fast", "new", "shared"]);
		expect(posted.length).toBe(requests);
	});

	it("keeps the staged definition when a client turns up publishing that ID", async () => {
		await mount();
		await stageCustom({
			id: "late",
			target: "late-target",
			destination: "Account A",
		});
		await rerender([
			client("alpha", [
				shared,
				{
					id: "late",
					displayName: "Late",
					targetModel: "elsewhere",
					accountIds: ["a"],
				},
			]),
			bravo,
		]);
		expect(rowText("late")).toContain("late → late-target");
		expect(rowText("late")).toContain("In 1 of 2");
		expect(rowText("late")).toContain("Defined differently in 1 client");
		expect(button("Add to all selected").disabled).toBe(true);
	});
});
