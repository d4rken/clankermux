import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ThemeProvider } from "../contexts/theme-context";
import { Navigation } from "./navigation";

function renderNavigation(): string {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});

	return renderToStaticMarkup(
		<QueryClientProvider client={queryClient}>
			<ThemeProvider>
				<MemoryRouter>
					<Navigation />
				</MemoryRouter>
			</ThemeProvider>
		</QueryClientProvider>,
	);
}

describe("Navigation brand links", () => {
	it("links both mobile and sidebar ClankerMux banners to the Overview route", () => {
		const html = renderNavigation();
		const brandLinks =
			html.match(
				/<a (?=[^>]*aria-label="ClankerMux overview")[^>]*href="\/"[^>]*>/g,
			) ?? [];

		expect(brandLinks).toHaveLength(2);
	});
});
