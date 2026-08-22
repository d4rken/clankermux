import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { queryKeys } from "../../lib/query-keys";
import { LimitsTab } from "./LimitsTab";

describe("LimitsTab usage-history ranges", () => {
	it("starts the 5-hour graph at 24h and the weekly graph at 7d", () => {
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false, refetchOnMount: false },
			},
		});

		renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<LimitsTab />
			</QueryClientProvider>,
		);

		expect(
			queryClient.getQueryCache().find({
				queryKey: queryKeys.usageHistory("24h"),
				exact: true,
			}),
		).toBeDefined();
		expect(
			queryClient.getQueryCache().find({
				queryKey: queryKeys.usageHistory("7d"),
				exact: true,
			}),
		).toBeDefined();
	});
});
