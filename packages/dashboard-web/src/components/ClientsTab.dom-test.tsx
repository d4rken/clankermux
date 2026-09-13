import { afterEach, expect, it } from "bun:test";
import type { ClientView } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { queryKeys } from "../lib/query-keys";
import { ClientsTab } from "./ClientsTab";

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
		key: {
			id: name,
			name,
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
