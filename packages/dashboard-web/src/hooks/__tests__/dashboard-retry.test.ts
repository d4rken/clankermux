/**
 * Retry policy for the worker-backed dashboard reads.
 *
 * The default 3 retries turned one slow analytics query into four: every
 * retried 503 soft timeout re-queued a full query behind the same slow read
 * that caused the timeout in the first place.
 */
import { describe, expect, it } from "bun:test";
import { HttpError } from "@clankermux/http-common";
import { shouldRetryDashboardQuery } from "../queries";

describe("shouldRetryDashboardQuery", () => {
	it("does not retry when the server answered", () => {
		// A 503 soft timeout is a DECISION, not a lost request. Retrying it queues
		// another full query behind the slow read that produced it.
		const timeout = new HttpError(503, "Analytics request timed out");
		expect(shouldRetryDashboardQuery(0, timeout)).toBe(false);
		expect(shouldRetryDashboardQuery(2, timeout)).toBe(false);
	});

	it("does not retry any other server response either", () => {
		for (const status of [400, 404, 500]) {
			expect(shouldRetryDashboardQuery(0, new HttpError(status, "nope"))).toBe(
				false,
			);
		}
	});

	it("retries a genuine network failure at most once", () => {
		const offline = new TypeError("Failed to fetch");
		expect(shouldRetryDashboardQuery(0, offline)).toBe(true);
		expect(shouldRetryDashboardQuery(1, offline)).toBe(false);
		expect(shouldRetryDashboardQuery(2, offline)).toBe(false);
	});
});
