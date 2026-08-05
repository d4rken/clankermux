/**
 * The integrity banner must never present a CACHED verdict as the current one.
 *
 * React Query keeps the last successful payload when a later poll fails, so a
 * guard of `isError && data === undefined` misses the common case: /api/storage
 * answered once, the next poll failed, and an hours-old "healthy" verdict keeps
 * rendering as if it had just been confirmed.
 */
import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { StorageInfoResponse } from "../../api";
import { queryKeys } from "../../lib/query-keys";
import { StorageIntegrityBanner } from "./StorageIntegrity";

function storageInfo(
	overrides: Partial<StorageInfoResponse> = {},
): StorageInfoResponse {
	return {
		db_bytes: 1024,
		wal_bytes: 0,
		integrity_status: "ok",
		integrity_running_kind: null,
		last_integrity_check_at: null,
		last_integrity_error: null,
		last_quick_check_at: null,
		last_quick_result: "ok",
		last_quick_attempt_at: null,
		last_quick_skip_reason: null,
		last_full_check_at: null,
		last_full_result: "ok",
		last_full_attempt_at: null,
		last_full_skip_reason: null,
		orphan_pages: null,
		last_retention_sweep_at: null,
		null_account_rows_24h: 0,
		...overrides,
	};
}

/**
 * Renders the banner against a hand-built query state.
 *
 * `cached` seeds the last successful payload (optionally aged via
 * `updatedAgoMs`); `failed` then drives the query into the error state the way
 * a failed BACKGROUND refetch does — status flips to "error" while `data`
 * survives.
 */
function renderBanner(opts: {
	cached?: StorageInfoResponse;
	updatedAgoMs?: number;
	failed?: boolean;
}): string {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, refetchOnMount: false } },
	});
	const key = queryKeys.storage();
	if (opts.cached) {
		client.setQueryData(key, opts.cached, {
			updatedAt: Date.now() - (opts.updatedAgoMs ?? 0),
		});
	}
	if (opts.failed) {
		const query =
			client.getQueryCache().find({ queryKey: key }) ??
			client.getQueryCache().build(client, { queryKey: key });
		query.setState({
			status: "error",
			error: new Error("storage endpoint unreachable"),
			errorUpdatedAt: Date.now(),
			fetchStatus: "idle",
		});
	}

	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<StorageIntegrityBanner />
		</QueryClientProvider>,
	);
}

describe("StorageIntegrityBanner availability states", () => {
	it("renders nothing when a fresh read says the database is healthy", () => {
		expect(renderBanner({ cached: storageInfo() })).toBe("");
	});

	it("says the status is unavailable when the read failed with nothing cached", () => {
		const html = renderBanner({ failed: true });
		expect(html).toContain("Database integrity status unavailable");
	});

	it("flags a cached verdict whose latest refresh failed as stale", () => {
		const html = renderBanner({
			cached: storageInfo(),
			updatedAgoMs: 5 * 60_000,
			failed: true,
		});

		expect(html).toContain("Database integrity status stale");
		expect(html).toContain("5m ago");
		expect(html).toContain("the latest refresh failed");
	});

	it("keeps the corruption banner and APPENDS the stale note", () => {
		const html = renderBanner({
			cached: storageInfo({
				integrity_status: "corrupt",
				last_integrity_error: "page 42 is malformed",
			}),
			updatedAgoMs: 2 * 60_000,
			failed: true,
		});

		// A failed refresh must not downgrade a corruption report.
		expect(html).toContain("Database integrity check failed");
		expect(html).toContain("page 42 is malformed");
		expect(html).toContain("2m ago");
		expect(html).not.toContain("Database integrity status stale");
	});

	it("shows the corruption banner alone while the reads keep succeeding", () => {
		const html = renderBanner({
			cached: storageInfo({
				integrity_status: "corrupt",
				last_integrity_error: "page 42 is malformed",
			}),
		});

		expect(html).toContain("Database integrity check failed");
		expect(html).not.toContain("the latest refresh failed");
	});
});
