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
	global: null,
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
const charlie = client("charlie", []);
const newModel: ClientModel = {
	id: "new",
	displayName: "New model",
	targetModel: "new",
	accountIds: null,
};

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
						{
							id: "glm",
							displayName: "GLM",
							accountIds: ["z"],
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
					{ id: "z", name: "Account Z", provider: "zai" },
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
const filterPane = (pane: "available" | "selected", value: string) =>
	typeInto(`input[type="search"][aria-label$=" ${pane} models"]`, value);
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
const IN = "In catalogues";
const OUT = "Not in every catalogue";
const rows = (pane: string) =>
	[
		...(document
			.querySelector(`section[aria-label="${pane}"]`)
			?.querySelectorAll("[data-model-id]") ?? []),
	].map((n) => n.getAttribute("data-model-id"));
const rowText = (pane: string, id: string) =>
	document
		.querySelector(`section[aria-label="${pane}"]`)
		?.querySelector(`[data-model-id="${id}"]`)?.textContent ?? "";
const summary = () =>
	[...document.querySelectorAll('[role="status"]')]
		.map((n) => n.textContent)
		.join(" ");

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	reviewResponse = null;
	commitResponse = [];
	mock.restore();
});

describe("bulk catalogue editing", () => {
	it("places each model by how many selected clients publish it", async () => {
		await mount([alpha, bravo, charlie]);
		expect(posted).toEqual([
			{
				path: "/api/clients/suggestions",
				body: {
					destinations: { accountId: null, providers: null },
					refresh: false,
				},
			},
		]);
		expect(rows(IN)).toEqual(["fast", "shared"]);
		// Two of three clients publish these, so they are also still addable.
		expect(rows(OUT)).toEqual(["fast", "glm", "new", "shared"]);
		expect(rowText(IN, "shared")).toContain("In 2 of 3");
		expect(rowText(OUT, "new")).toContain("In 0 of 3");
		expect(document.body.textContent).toContain("Edit catalogues");
		expect(document.body.textContent).toContain("Client alpha");
	});

	it("stages one intent per model and moves it out of the other column", async () => {
		await mount([alpha, bravo, charlie]);
		await click("Add shared");
		expect(rows(OUT)).not.toContain("shared");
		expect(rowText(IN, "shared")).toContain("Adding to 1 client");
		await click("Remove shared");
		expect(rows(IN)).not.toContain("shared");
		expect(rowText(OUT, "shared")).toContain("Removing from 2 clients");
		await click("Undo shared");
		expect(rows(IN)).toContain("shared");
		expect(rows(OUT)).toContain("shared");
		expect(summary()).toContain("Move models between the columns");
	});

	it("moving a row back to where every client already has it undoes the intent", async () => {
		await mount();
		await click("Remove shared");
		expect(rows(IN)).toEqual(["fast"]);
		await click("Add shared");
		expect(rows(IN)).toEqual(["fast", "shared"]);
		expect(rowText(IN, "shared")).not.toContain("Adding");
		expect(button("Review changes").disabled).toBe(true);
	});

	it("refuses to add an ID the selected clients define differently, but still removes it", async () => {
		await mount([alpha, bravo, charlie]);
		expect(rowText(OUT, "fast")).toContain("Defined differently in 2 clients");
		expect(button("Add fast").disabled).toBe(true);
		expect(
			document
				.querySelector(`section[aria-label="${OUT}"]`)
				?.querySelector<HTMLInputElement>('input[aria-label="Check fast"]')
				?.disabled,
		).toBe(true);
		await check("Check all shown available models");
		await click("Add checked (3)");
		expect(rows(IN)).toEqual(["fast", "glm", "new", "shared"]);
		expect(rows(OUT)).toEqual(["fast"]);
		await click("Remove fast");
		expect(rowText(OUT, "fast")).toContain("Removing from 2 clients");
	});

	it("reviews every staged add and remove as one edit", async () => {
		await mount();
		expect(button("Review changes").disabled).toBe(true);
		await click("Add new");
		await click("Remove shared");
		expect(summary()).toContain("1 to add · 1 to remove");
		await click("Review changes");
		expect(posted.at(-1)).toEqual({
			path: "/api/clients/bulk/review",
			body: {
				clientIds: ["alpha", "bravo"],
				operation: {
					format: "openai",
					mode: "edit",
					add: [newModel],
					remove: ["shared"],
				},
			},
		});
	});

	it("narrows both columns to one provider so its models can be checked at once", async () => {
		await mount();
		await click("Show z.ai models, 1 model");
		expect(rows(OUT)).toEqual(["glm"]);
		expect(rows(IN)).toEqual([]);
		await check("Check all shown available models");
		await click("Add checked (1)");
		expect(rows(IN)).toEqual(["glm"]);
		await click("Clear filters");
		expect(rows(IN)).toEqual(["fast", "glm", "shared"]);
		expect(rows(OUT)).toEqual(["new"]);
	});

	it("keeps a staged change the filters hide in the reviewed edit", async () => {
		await mount();
		await click("Add new");
		await filterPane("selected", "shared");
		await click("Show z.ai models, 1 model");
		expect(rows(IN)).toEqual([]);
		expect(summary()).toContain("1 to add · 0 to remove");
		await click("Review changes");
		expect(posted.at(-1)?.body).toMatchObject({
			operation: { mode: "edit", add: [{ id: "new" }], remove: [] },
		});
	});

	it("drops a staged add the refreshed clients already all publish", async () => {
		await mount();
		await click("Add new");
		await rerender([
			client("alpha", [...alpha.catalogues.openai.models, newModel]),
			client("bravo", [...bravo.catalogues.openai.models, newModel]),
		]);
		expect(rowText(IN, "new")).not.toContain("Adding");
		expect(button("Review changes").disabled).toBe(true);
		expect(summary()).toContain("Move models between the columns");
		// A client losing it again must not revive the add nobody staged anew.
		await rerender([
			client("alpha", [...alpha.catalogues.openai.models, newModel]),
			bravo,
		]);
		expect(rowText(IN, "new")).not.toContain("Adding");
		expect(button("Review changes").disabled).toBe(true);
	});

	it("holds the format while changes are staged", async () => {
		await mount();
		await click("Add new");
		const tab = [...document.querySelectorAll('[role="tab"]')].find((t) =>
			t.textContent?.startsWith("Anthropic"),
		) as HTMLButtonElement | undefined;
		expect(tab?.disabled).toBe(true);
		expect(button("Replace catalogue for 2 clients").disabled).toBe(true);
		await click("Discard changes");
		expect(tab?.disabled).toBe(false);
	});

	it("previews every outcome and applies only when something changes", async () => {
		reviewResponse = previewWithEverything;
		await mount();
		await click("Remove shared");
		await click("Review changes");
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
		// Still open, with nothing left staged.
		expect(document.body.textContent).toContain("Applied to 1 client.");
		expect(rows(IN)).toEqual(["fast", "shared"]);
		expect(button("Review changes").disabled).toBe(true);
	});

	it("hands the committed clients to the caller", async () => {
		commitResponse = [client("alpha", [shared])];
		await mount();
		await click("Add new");
		await click("Review changes");
		await click("Apply to 2 clients");
		expect(appliedWith).toEqual(commitResponse);
	});

	it("disables apply when no client would change, and goes back with the changes intact", async () => {
		reviewResponse = {
			token: "bulk-token",
			operation: { format: "openai", mode: "edit", add: [], remove: [] },
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
		await click("Add new");
		await click("Review changes");
		expect(button("Apply to 0 clients").disabled).toBe(true);
		await click("Back");
		expect(rowText(IN, "new")).toContain("Adding to 2 clients");
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
	it("stages an alias no client publishes as an addition and posts it whole", async () => {
		await mount();
		await stageCustom({
			id: "shared[1m]",
			target: "shared",
			name: "Shared long context",
			destination: "Account A",
		});
		expect(rows(IN)).toEqual(["fast", "shared", "shared[1m]"]);
		expect(rowText(IN, "shared[1m]")).toContain("Custom");
		expect(rowText(IN, "shared[1m]")).toContain("In 0 of 2");
		expect(rowText(IN, "shared[1m]")).toContain("Adding to 2 clients");
		await click("Review changes");
		expect(posted.at(-1)).toEqual({
			path: "/api/clients/bulk/review",
			body: {
				clientIds: ["alpha", "bravo"],
				operation: {
					format: "openai",
					mode: "edit",
					add: [
						{
							id: "shared[1m]",
							displayName: "Shared long context",
							targetModel: "shared",
							accountIds: ["a"],
						},
					],
					remove: [],
				},
			},
		});
	});

	it("takes a staged entry back out of the list and the changes", async () => {
		await mount();
		await stageCustom({ id: "typo" });
		expect(rows(IN)).toContain("typo");
		await click("Discard typo");
		expect(rows(IN)).not.toContain("typo");
		expect(rows(OUT)).not.toContain("typo");
		expect(button("Review changes").disabled).toBe(true);
	});

	it("discards a staged entry moved back out of the catalogues column", async () => {
		await mount();
		await stageCustom({ id: "typo" });
		await click("Remove typo");
		expect(rows(IN)).not.toContain("typo");
		expect(rows(OUT)).not.toContain("typo");
		expect(button("Review changes").disabled).toBe(true);
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
		expect(rows(IN)).toEqual(["fast", "shared"]);
		expect(rows(OUT)).toEqual(["glm", "new"]);
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
		expect(rowText(IN, "late")).toContain("late-target");
		expect(rowText(IN, "late")).toContain("In 1 of 2");
		expect(rowText(IN, "late")).toContain("Defined differently in 1 client");
		expect(button("Review changes").disabled).toBe(true);
	});
});
