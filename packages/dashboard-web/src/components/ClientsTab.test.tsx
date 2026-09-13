import { expect, it } from "bun:test";
import type { ClientView } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ClientsTab } from "./ClientsTab";

it("lists clients by name and highlights requests from the last 24 hours", () => {
	const client = (name: string, hours: number | null): ClientView => ({
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
				hours === null
					? null
					: new Date(Date.now() - hours * 3600000).toISOString(),
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
	});
	const query = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false } },
	});
	const clients = [
		client("Zulu", null),
		client("alpha 10", 25),
		client("Alpha 2", 5),
	];
	query.setQueryData(["clients"], clients);
	const html = renderToStaticMarkup(
		<QueryClientProvider client={query}>
			<MemoryRouter>
				<ClientsTab />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	expect(html.indexOf("Alpha 2")).toBeLessThan(html.indexOf("alpha 10"));
	expect(html.indexOf("alpha 10")).toBeLessThan(html.indexOf("Zulu"));
	expect(html.match(/text-green-600/g)).toHaveLength(1);
	expect(html.match(/xl:sr-only/g)).toHaveLength(9);
	expect(clients.map((c) => c.key.name)).toEqual([
		"Zulu",
		"alpha 10",
		"Alpha 2",
	]);
	query.clear();
});
