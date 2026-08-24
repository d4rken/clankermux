/**
 * Storage-size states of the retention card.
 *
 * The sizes come from `/api/storage/usage`, whose first read after a restart
 * runs a minutes-long cold scan — longer than the browser request's 60s
 * timeout. The card must say it is measuring during that window (pending OR
 * timed out awaiting a retry) instead of silently hiding the section, which
 * read as "the feature is broken" the first time it happened. A completed
 * measurement shows sizes; a server-side `available: false` still renders
 * nothing (unchanged behaviour — that state is a failed scan, not a pending
 * one, and must not claim to be measuring).
 */

import { describe, expect, it } from "bun:test";
import type { StorageUsageResponse } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { queryKeys } from "../../lib/query-keys";
import { DataRetentionCard } from "./DataRetentionCard";

function client(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnMount: false },
		},
	});
}

function render(queryClient: QueryClient): string {
	return renderToStaticMarkup(
		<QueryClientProvider client={queryClient}>
			<DataRetentionCard />
		</QueryClientProvider>,
	);
}

/** First fetch in flight with nothing cached (static render runs no effects). */
function seedPending(queryClient: QueryClient): void {
	queryClient
		.getQueryCache()
		.build(queryClient, {
			queryKey: queryKeys.storageUsage() as unknown as unknown[],
		})
		.setState({
			status: "pending",
			fetchStatus: "fetching",
			data: undefined,
			dataUpdatedAt: 0,
		});
}

/** Failed (e.g. the 60s client timeout during a cold scan), awaiting retry. */
function seedError(queryClient: QueryClient): void {
	queryClient
		.getQueryCache()
		.build(queryClient, {
			queryKey: queryKeys.storageUsage() as unknown as unknown[],
		})
		.setState({
			status: "error",
			error: new Error("timeout of 60000ms exceeded"),
			fetchStatus: "idle",
			data: undefined,
			dataUpdatedAt: 0,
			errorUpdatedAt: Date.now(),
		});
}

function usageResponse(
	over: Partial<StorageUsageResponse> = {},
): StorageUsageResponse {
	return {
		available: true,
		measuredAt: new Date().toISOString(),
		dbBytes: 4_000_000_000,
		walBytes: 30_000_000,
		types: [
			{
				key: "payloads",
				table: "request_payloads",
				rowCount: 1000,
				approxBytes: 3_500_000_000,
			},
		],
		...over,
	};
}

describe("DataRetentionCard storage sizes", () => {
	it("says it is measuring while the first scan is in flight", () => {
		const queryClient = client();
		seedPending(queryClient);

		const html = render(queryClient);

		expect(html).toContain("Measuring storage usage");
		expect(html).not.toContain("Database file is");
	});

	it("still says measuring after a client timeout, while retries continue", () => {
		const queryClient = client();
		seedError(queryClient);

		const html = render(queryClient);

		expect(html).toContain("Measuring storage usage");
	});

	it("shows the sizes once the measurement completes", () => {
		const queryClient = client();
		queryClient.setQueryData(queryKeys.storageUsage(), usageResponse());

		const html = render(queryClient);

		expect(html).toContain("Database file is");
		expect(html).not.toContain("Measuring storage usage");
	});

	it("shows neither for a failed measurement (available: false)", () => {
		const queryClient = client();
		queryClient.setQueryData(
			queryKeys.storageUsage(),
			usageResponse({ available: false }),
		);

		const html = render(queryClient);

		expect(html).not.toContain("Measuring storage usage");
		expect(html).not.toContain("Database file is");
	});
});
