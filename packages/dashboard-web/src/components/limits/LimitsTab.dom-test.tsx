import { afterEach, describe, expect, it } from "bun:test";
import type { AccountResponse } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { queryKeys } from "../../lib/query-keys";
import { LimitsTab } from "./LimitsTab";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let client: QueryClient | null = null;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	client?.clear();
	root = null;
	host = null;
});
function Location() {
	return <output>{useLocation().search}</output>;
}
async function mount() {
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnMount: false, staleTime: Infinity },
		},
	});
	const now = Date.now();
	const a = {
		id: "a",
		name: "Claud1",
		provider: "anthropic",
		rateLimitCause: "ok",
		usageData: {
			seven_day: {
				utilization: 25,
				resets_at: new Date(now + 86400000).toISOString(),
			},
			limits: [
				{
					kind: "weekly_scoped",
					percent: 40,
					resets_at: new Date(now + 86400000).toISOString(),
					scope: { model: { id: "fable", display_name: "Fable" } },
				},
			],
		},
	} as AccountResponse;
	client.setQueryData(queryKeys.accounts(), [
		a,
		{
			...a,
			id: "c",
			name: "Codex1",
			provider: "codex",
			usageData: {
				seven_day: {
					utilization: 10,
					resets_at: new Date(now + 86400000).toISOString(),
				},
			},
		},
	]);
	for (const range of ["7d", "30d"]) {
		client.setQueryData(queryKeys.usageScopedHistory(range), {
			range,
			bucketMs: 60000,
			families: [],
		});
		client.setQueryData(queryKeys.usageHistory(range), {
			range,
			bucketMs: 60000,
			series: [],
			pool: [],
		});
	}
	client.setQueryData(queryKeys.runway(), { keys: [], accounts: [] });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root?.render(
			<MemoryRouter initialEntries={["/limits?provider=anthropic&model=fable"]}>
				<QueryClientProvider client={required(client)}>
					<Location />
					<LimitsTab />
				</QueryClientProvider>
			</MemoryRouter>,
		),
	);
}
describe("Usage selection", () => {
	it("selects the linked model, changes provider in the URL, and clears the old model", async () => {
		await mount();
		const model = required(
			host?.querySelector<HTMLSelectElement>('select[aria-label="Model"]'),
		);
		expect(model.value).toBe("fable");
		expect(
			host?.querySelector<HTMLSelectElement>(
				'select[aria-label="Quota window"]',
			)?.disabled,
		).toBe(true);
		const provider = required(
			host?.querySelector<HTMLSelectElement>('select[aria-label="Provider"]'),
		);
		await act(async () => {
			provider.value = "codex";
			provider.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(host?.querySelector("output")?.textContent).toBe("?provider=codex");
		expect(model.value).toBe("");
		expect(host?.textContent).toContain("Codex1");
	});
	it("leaves forecasts off until requested", async () => {
		await mount();
		const checkbox = required(
			host?.querySelector<HTMLInputElement>('input[type="checkbox"]'),
		);
		expect(checkbox.checked).toBe(false);
		await act(async () => checkbox.click());
		expect(checkbox.checked).toBe(true);
		expect(host?.textContent).toContain(
			"Dashed lines assume the current pace continues",
		);
	});
});

function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("Expected rendered element");
	return value;
}
