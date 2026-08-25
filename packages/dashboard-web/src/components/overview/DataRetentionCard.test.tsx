/**
 * Storage-size states of the retention card.
 *
 * The sizes come from `/api/storage/usage`, whose first read after a restart
 * runs a minutes-long cold scan — longer than the browser request's 60s
 * timeout. The card must say it is measuring during that window (pending OR
 * timed out awaiting the next poll) instead of silently hiding the section,
 * which read as "the feature is broken" the first time it happened.
 *
 * The three states are mutually exclusive and each must be distinguishable:
 * measuring, failed (`available: false`), and complete. A failed scan used to
 * render nothing at all, which is indistinguishable from a broken card — it now
 * says so.
 */

import { describe, expect, it } from "bun:test";
import type { StorageUsageResponse } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import {
	STORAGE_USAGE_POLL_MS,
	storageUsageRefetchInterval,
} from "../../hooks/queries";
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

/** Failed (e.g. the 60s client timeout during a cold scan), awaiting the next poll. */
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
		expect(html).not.toContain("Database file");
	});

	it("still says measuring after a client timeout, while polling continues", () => {
		const queryClient = client();
		seedError(queryClient);

		const html = render(queryClient);

		expect(html).toContain("Measuring storage usage");
		expect(html).not.toContain("unavailable");
	});

	it("shows the sizes once the measurement completes", () => {
		const queryClient = client();
		queryClient.setQueryData(queryKeys.storageUsage(), usageResponse());

		const html = render(queryClient);

		expect(html).toContain("Database file");
		expect(html).not.toContain("Measuring storage usage");
		// The per-setting figure for the one table the fixture reports.
		expect(html).toContain("1,000 rows");
	});

	it("names the failure for a failed measurement (available: false)", () => {
		const queryClient = client();
		queryClient.setQueryData(
			queryKeys.storageUsage(),
			usageResponse({ available: false }),
		);

		const html = render(queryClient);

		// Must not claim progress that isn't happening...
		expect(html).not.toContain("Measuring storage usage");
		// ...and must not silently render nothing, which reads as a broken card.
		expect(html).toContain("Storage measurement unavailable");
		expect(html).not.toContain("Database file");
	});
});

describe("storage usage polling", () => {
	it("keeps polling while the first measurement is still pending", () => {
		expect(storageUsageRefetchInterval("pending")).toBe(STORAGE_USAGE_POLL_MS);
	});

	// The case a `data != null` check gets wrong: TanStack keeps the previous
	// value after a failed refetch, so a rescan that times out (what "Clean up
	// now" provokes) sits in `error` WITH stale data. Keyed on data alone the
	// poll stops here and the card strands on sizes that no longer match the DB.
	it("keeps polling after a failed refetch, even though stale data remains", () => {
		expect(storageUsageRefetchInterval("error")).toBe(STORAGE_USAGE_POLL_MS);
	});

	it("stops polling on success, so no full-table scan runs on a timer", () => {
		expect(storageUsageRefetchInterval("success")).toBe(false);
	});
});
