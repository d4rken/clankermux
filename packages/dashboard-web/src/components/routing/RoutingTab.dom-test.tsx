import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ApiKeyResponse, RoutingRule } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../../api";
import { queryKeys } from "../../lib/query-keys";
import { RoutingTab } from "./RoutingTab";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient;

const RULE: RoutingRule = {
	id: "rule-1",
	name: "Fable to Opus",
	enabled: true,
	position: 0,
	match_api_key_id: "key-1",
	match_model_kind: "any",
	match_model_value: null,
	pool_kind: "inherit",
	pool_provider: null,
	pool_account_ids: null,
	target_kind: "requested",
	target_model: null,
};

function makeKey(overrides: Partial<ApiKeyResponse> = {}): ApiKeyResponse {
	return {
		id: "key-1",
		name: "Workstation key",
		prefixLast8: "abcd1234",
		createdAt: "2026-01-01T00:00:00.000Z",
		lastUsed: null,
		usageCount: 0,
		isActive: true,
		pinnedAccountId: null,
		pinnedProviders: null,
		...overrides,
	};
}

/** How many times the component asked for `/api/api-keys`. */
let keyFetches = 0;

async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
}

async function mount(keys: ApiKeyResponse[] = [makeKey()]) {
	keyFetches = 0;
	spyOn(api, "get").mockImplementation(async (path: string) => {
		if (path === "/api/api-keys") {
			keyFetches++;
			return { data: keys } as never;
		}
		if (path === "/api/routing-rules") return { data: [RULE] } as never;
		throw new Error(`Unexpected GET ${path}`);
	});
	spyOn(api, "getAccounts").mockResolvedValue([]);
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
				<RoutingTab />
			</QueryClientProvider>,
		);
	});
	await settle();
}

async function click(text: string) {
	const button = Array.from(document.querySelectorAll("button")).find(
		(el) => el.textContent === text,
	);
	if (!button) throw new Error(`Missing ${text}`);
	await act(async () => button.click());
	await settle();
}

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	client?.clear();
	root = null;
	mock.restore();
});

describe("RoutingTab api keys", () => {
	it("names the matched API key in the rule list", async () => {
		await mount();

		expect(document.body.textContent).toContain("Workstation key");
		expect(document.body.textContent).not.toContain("Missing key");
	});

	it("offers every API key in the rule editor's dropdown", async () => {
		await mount([
			makeKey(),
			makeKey({ id: "key-2", name: "Laptop key", prefixLast8: "ef567890" }),
		]);

		await click("Add rule");

		const options = Array.from(document.querySelectorAll("select option")).map(
			(option) => option.textContent,
		);
		expect(options).toContain("Workstation key");
		expect(options).toContain("Laptop key");
	});

	it("refetches when the shared api-keys query is invalidated", async () => {
		await mount();
		expect(keyFetches).toBe(1);

		await act(async () => {
			await client.invalidateQueries({ queryKey: queryKeys.apiKeys() });
		});
		await settle();

		expect(keyFetches).toBe(2);
	});
});
