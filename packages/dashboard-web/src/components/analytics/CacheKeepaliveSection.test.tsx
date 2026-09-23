/**
 * The live keep-alive counters are seeded from the newest stored snapshot at
 * boot, and the history is stored, so the section must not tell the operator
 * either one restarts from zero.
 */

import { describe, expect, it } from "bun:test";
import type { CacheKeepaliveHistoryResponse } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { queryKeys } from "../../lib/query-keys";
import { CacheKeepaliveSection } from "./CacheKeepaliveSection";

function render(): string {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, refetchOnMount: false } },
	});
	queryClient.setQueryData(queryKeys.cacheKeepaliveHistory("7d"), {
		range: "7d",
		bucketMs: 3_600_000,
		points: [],
	} satisfies CacheKeepaliveHistoryResponse);
	return renderToStaticMarkup(
		<QueryClientProvider client={queryClient}>
			<CacheKeepaliveSection range="7d" />
		</QueryClientProvider>,
	);
}

describe("CacheKeepaliveSection copy", () => {
	it("describes the live counters as carrying across restarts", () => {
		const html = render();
		expect(html).toContain("carry across restarts");
		expect(html).not.toContain("since the last restart");
	});

	it("explains an empty chart without blaming a restart", () => {
		const html = render();
		expect(html).toContain("No keep-alive activity recorded in this range");
		expect(html).not.toContain("after a restart");
	});
});
