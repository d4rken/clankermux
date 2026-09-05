/**
 * The Quota tab's composition, not its panels' internals.
 *
 * What is asserted here is placement: the pool-sizing section renders, it sits
 * ABOVE the quota-change verdicts, and the tab still renders the rest of its
 * content when the pool-sizing read has nothing cached.
 */
import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { queryKeys } from "../../../lib/query-keys";
import { poolSizingFixture } from "../__fixtures__/pool-sizing";
import { QuotaTab } from "./QuotaTab";

function client(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnMount: false, retryOnMount: false },
		},
	});
}

function render(queryClient: QueryClient): string {
	return renderToStaticMarkup(
		<QueryClientProvider client={queryClient}>
			<QuotaTab />
		</QueryClientProvider>,
	);
}

describe("QuotaTab", () => {
	it("renders the pool sizing section above the quota verdicts", () => {
		const queryClient = client();
		queryClient.setQueryData(queryKeys.poolSizing(), poolSizingFixture());

		const html = render(queryClient);

		expect(html).toContain("Pool sizing");
		expect(html).toContain("Account-weeks consumed per completed weekly cycle");
		expect(html.indexOf("Pool sizing")).toBeLessThan(
			html.indexOf("Implied Window Cost"),
		);
		// The panel really got the payload, not just its heading.
		expect(html).toContain("4.79 of 5");
	});

	it("keeps the rest of the tab when pool sizing has nothing cached", () => {
		const html = render(client());
		expect(html).toContain("Pool sizing");
		expect(html).not.toContain("4.79 of 5");
	});
});
