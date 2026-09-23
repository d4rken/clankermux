import { afterEach, expect, it, mock, spyOn } from "bun:test";
import type { ClientView } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { queryKeys } from "../lib/query-keys";
import { ClientsTab } from "./ClientsTab";

/**
 * A row checkbox's accessible name, which NAMES THE HARNESS as well as the
 * client. The name alone would not do: the accessible name is read on its own
 * when tabbing, so it cannot lean on the harness spelled out in the row's
 * sub-line, and two clients from one machine differ only by that harness.
 */
const selectLabel = (name: string) => `Select ${name} (Generic / script)`;

function makeClient(name: string): ClientView {
	return {
		apiKeyId: name,
		application: "generic",
		revision: 1,
		aliasRules: [],
		notices: [],
		global: null,
		key: {
			id: name,
			name,
			application: null,
			prefixLast8: "12345678",
			createdAt: "2026-01-01",
			lastUsed: null,
			usageCount: 0,
			isActive: true,
			pinnedAccountId: null,
			pinnedProviders: null,
		},
		catalogues: {
			anthropic: { models: [], defaultModel: null },
			openai: { models: [], defaultModel: null },
			codex: { models: [], defaultModel: null },
		},
	};
}

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let query: QueryClient;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	query?.clear();
	mock.restore();
});

it("sorts each client header in both directions and retains sorting after refresh", async () => {
	const client = (
		name: string,
		provider: string | null,
		days: number | null,
		count: number,
	): ClientView => ({
		apiKeyId: name,
		application: "generic",
		revision: 1,
		aliasRules: [],
		notices: [],
		global: null,
		key: {
			id: name,
			name,
			application: null,
			prefixLast8: "12345678",
			createdAt: "2026-01-01",
			lastUsed:
				days === null
					? null
					: new Date(Date.now() - days * 86400000).toISOString(),
			usageCount: 0,
			isActive: true,
			pinnedAccountId: null,
			pinnedProviders: provider ? [provider] : null,
		},
		catalogues: {
			anthropic: {
				models: Array.from({ length: count }, (_, i) => ({
					id: `model-${i}`,
					displayName: `Model ${i}`,
					targetModel: `model-${i}`,
					accountIds: null,
				})),
				defaultModel: null,
			},
			openai: { models: [], defaultModel: null },
			codex: { models: [], defaultModel: null },
		},
	});
	const clients = [
		client("Zulu", null, null, 1),
		client("Alpha 10", "codex", 1, 3),
		client("Alpha 2", "anthropic", 5, 2),
	];
	const zulu = clients[0];
	if (!zulu) throw new Error("Missing fixture");
	zulu.key.pinnedAccountId = "pinned";
	const alpha10 = clients[1];
	if (!alpha10) throw new Error("Missing fixture");
	alpha10.catalogues.openai.models = alpha10.catalogues.anthropic.models.splice(
		1,
		1,
	);
	alpha10.catalogues.codex.models = alpha10.catalogues.anthropic.models.splice(
		1,
		1,
	);
	query = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false } },
	});
	query.setQueryData(["clients"], clients);
	query.setQueryData(queryKeys.accounts(), [
		{ id: "pinned", name: "Account 1" },
	]);
	const container = document.createElement("div");
	host = container;
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={query}>
				<MemoryRouter>
					<ClientsTab />
				</MemoryRouter>
			</QueryClientProvider>,
		),
	);
	const names = () =>
		[...container.querySelectorAll('ul[aria-label="Clients"] h2')].map(
			(n) => n.textContent,
		);
	const click = async (label: string) => {
		const button = [...container.querySelectorAll("button")].find(
			(b) => b.textContent?.trim() === label,
		);
		if (!button) throw new Error(`Missing sort button ${label}`);
		await act(async () => button.click());
		expect(button.getAttribute("aria-pressed")).toBe("true");
	};
	expect(names()).toEqual(["Alpha 2", "Alpha 10", "Zulu"]);
	await click("Client");
	expect(names()).toEqual(["Zulu", "Alpha 10", "Alpha 2"]);
	await click("Client");
	expect(names()).toEqual(["Alpha 2", "Alpha 10", "Zulu"]);
	await click("Client");
	await click("Destinations");
	expect(
		container
			.querySelector('button[aria-label^="Sort by Client"]')
			?.getAttribute("aria-pressed"),
	).toBe("false");
	expect(names()).toEqual(["Zulu", "Alpha 2", "Alpha 10"]);
	await click("Destinations");
	expect(names()).toEqual(["Alpha 10", "Alpha 2", "Zulu"]);
	await click("Destinations");
	await click("Catalogue models");
	expect(names()).toEqual(["Alpha 10", "Alpha 2", "Zulu"]);
	await click("Catalogue models");
	expect(names()).toEqual(["Zulu", "Alpha 2", "Alpha 10"]);
	await click("Last request");
	expect(names()).toEqual(["Alpha 10", "Alpha 2", "Zulu"]);
	await click("Last request");
	expect(names()).toEqual(["Alpha 2", "Alpha 10", "Zulu"]);
	expect(
		container
			.querySelector('button[aria-pressed="true"]')
			?.getAttribute("aria-label"),
	).toContain("Last request, sorted oldest first");
	expect(container.querySelector('[role="status"]')?.textContent).toContain(
		"oldest first",
	);
	await act(async () => {
		query.setQueryData(
			["clients"],
			[...clients, client("Beta", "anthropic", 10, 4)],
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(names()).toEqual(["Beta", "Alpha 2", "Alpha 10", "Zulu"]);
	expect(clients.map((c) => c.key.name)).toEqual([
		"Zulu",
		"Alpha 10",
		"Alpha 2",
	]);
});

it("selects clients, opens the bulk editor, and forgets clients that disappear", async () => {
	spyOn(globalThis, "fetch").mockImplementation((async (input: unknown) => {
		if (String(input).endsWith("/suggestions"))
			return Response.json({ data: { models: [], accounts: [] } });
		throw new Error(`Unexpected request ${String(input)}`);
	}) as unknown as typeof fetch);
	query = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false } },
	});
	query.setQueryData(
		["clients"],
		[makeClient("One"), makeClient("Two"), makeClient("Three")],
	);
	query.setQueryData(queryKeys.accounts(), []);
	const container = document.createElement("div");
	host = container;
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={query}>
				<MemoryRouter>
					<ClientsTab />
				</MemoryRouter>
			</QueryClientProvider>,
		),
	);
	const box = (label: string) => {
		const found = container.querySelector<HTMLInputElement>(
			`input[type="checkbox"][aria-label="${label}"]`,
		);
		if (!found) throw new Error(`Missing checkbox ${label}`);
		return found;
	};
	const clickBox = async (label: string) => {
		const target = box(label);
		await act(async () => target.click());
	};
	const clickButton = async (label: string) => {
		const target = [...container.querySelectorAll("button")].find(
			(b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === label,
		);
		if (!target) throw new Error(`Missing button ${label}`);
		await act(async () => target.click());
	};
	await clickBox(selectLabel("One"));
	await clickBox(selectLabel("Two"));
	expect(container.textContent).toContain("2 selected");
	// React has no `indeterminate` prop, so this is set through a ref; a header
	// box that never leaves "unchecked" misreports a partial selection.
	expect(box("Select all clients").indeterminate).toBe(true);
	await clickBox("Select all clients");
	expect(box("Clear client selection").checked).toBe(true);
	expect(container.textContent).toContain("3 selected");

	await clickBox("Clear client selection");
	await clickBox(selectLabel("One"));
	await clickBox(selectLabel("Two"));
	await act(async () => {
		query.setQueryData(["clients"], [makeClient("One"), makeClient("Three")]);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(container.textContent).toContain("1 selected");

	await clickButton("Edit catalogues");
	expect(container.querySelector('ul[aria-label="Clients"]')).toBeNull();
	expect(container.textContent).toContain("Edit catalogues · 1 client");
});

it("keeps the bulk panel open on the committed catalogues, then closes with the selection intact", async () => {
	const publishing = (name: string, ids: string[]): ClientView => {
		const view = makeClient(name);
		view.catalogues.openai.models = ids.map((id) => ({
			id,
			displayName: id,
			targetModel: id,
			accountIds: null,
		}));
		return view;
	};
	let listRequests = 0;
	spyOn(globalThis, "fetch").mockImplementation((async (
		input: unknown,
		init?: { body?: unknown },
	) => {
		const path = String(input);
		if (path.endsWith("/suggestions"))
			return Response.json({ data: { models: [], accounts: [] } });
		if (path.endsWith("/bulk/review"))
			return Response.json({
				data: {
					token: "bulk-token",
					operation: JSON.parse(String(init?.body)).operation,
					clients: [
						{
							apiKeyId: "One",
							name: "One",
							status: "changed",
							reason: null,
							added: ["added-model"],
							removed: [],
							modified: [],
							defaultModelChange: null,
							notices: [],
						},
					],
				},
			});
		if (path.endsWith("/bulk/commit"))
			return Response.json({
				data: { clients: [publishing("One", ["kept-model", "added-model"])] },
			});
		if (path.endsWith("/api/clients")) {
			// The list refetch the apply invalidates, held open: what the panel
			// renders afterwards has to come from the seeded cache.
			listRequests += 1;
			return new Promise(() => {});
		}
		throw new Error(`Unexpected request ${path}`);
	}) as unknown as typeof fetch);
	query = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false } },
	});
	query.setQueryData(
		["clients"],
		[publishing("One", ["kept-model"]), makeClient("Two")],
	);
	query.setQueryData(queryKeys.accounts(), []);
	const container = document.createElement("div");
	host = container;
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={query}>
				<MemoryRouter>
					<ClientsTab />
				</MemoryRouter>
			</QueryClientProvider>,
		),
	);
	const clickLabelled = async (selector: string, label: string) => {
		const target = [...container.querySelectorAll(selector)].find(
			(n) => (n.getAttribute("aria-label") ?? n.textContent?.trim()) === label,
		);
		if (!(target instanceof HTMLElement))
			throw new Error(`Missing ${selector} ${label}`);
		await act(async () => target.click());
	};
	await clickLabelled("input", selectLabel("One"));
	await clickLabelled("button", "Edit catalogues");
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await clickLabelled("button", "Remove kept-model");
	await clickLabelled("button", "Review changes");
	await clickLabelled("button", "Apply to 1 client");
	expect(container.textContent).toContain("Applied to 1 client.");
	expect(
		[
			...container.querySelectorAll(
				'section[aria-label="In catalogues"] [data-model-id]',
			),
		].map((n) => n.getAttribute("data-model-id")),
	).toEqual(["added-model", "kept-model"]);
	expect(listRequests).toBe(1);
	await clickLabelled("button", "Close");
	expect(container.querySelector('ul[aria-label="Clients"]')).not.toBeNull();
	expect(container.textContent).toContain("1 selected");
});
