import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mockFetch } from "@clankermux/test-support";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { api } from "../api";
import { ThemeProvider } from "../contexts/theme-context";
import { Navigation } from "./navigation";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const restores: Array<() => void> = [];

async function mount(): Promise<void> {
	const systemSpy = spyOn(api, "getSystemStatus").mockImplementation(() => {
		throw new Error("not under test");
	});
	restores.push(() => systemSpy.mockRestore());

	const realFetch = globalThis.fetch;
	globalThis.fetch = mockFetch(
		async () =>
			new Response(JSON.stringify({ status: "unknown" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	);
	restores.push(() => {
		globalThis.fetch = realFetch;
	});

	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, refetchInterval: false } },
	});
	await act(async () => {
		root?.render(
			<QueryClientProvider client={queryClient}>
				<ThemeProvider>
					<MemoryRouter initialEntries={["/analytics"]}>
						<Navigation />
					</MemoryRouter>
				</ThemeProvider>
			</QueryClientProvider>,
		);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = null;
	host = null;
	while (restores.length > 0) restores.pop()?.();
});

describe("mobile navigation brand", () => {
	it("closes the open drawer when the ClankerMux banner is clicked", async () => {
		await mount();
		const buttons = host?.querySelectorAll("button") ?? [];
		const menuButton = buttons[1];
		if (!menuButton) throw new Error("Missing mobile menu button");

		await act(async () => menuButton.click());
		expect(host?.querySelector('[aria-label="Close menu"]')).not.toBeNull();

		const banner = host?.querySelector('a[aria-label="ClankerMux overview"]');
		if (!banner) throw new Error("Missing ClankerMux banner link");
		await act(async () => (banner as HTMLElement).click());

		expect(host?.querySelector('[aria-label="Close menu"]')).toBeNull();
	});
});
