import { describe, expect, it } from "bun:test";
import type { PoolStatus, SystemStatusResponse } from "@clankermux/types";
import { statusSummary } from "../system-status-utils";

const RECOVERS_AT = "2026-07-26T15:40:00.000Z";

function makeStatus(
	status: SystemStatusResponse["status"],
	pool: Partial<PoolStatus>,
): SystemStatusResponse {
	return {
		status,
		uptime_s: 1234,
		memory: { rss_bytes: 0, rss_mb: 0 },
		pool: {
			configured: 1,
			routable: 0,
			paused: 0,
			rate_limited: 0,
			next_available_at: RECOVERS_AT,
			...pool,
		},
		runtime: {
			asyncWriterHealthy: true,
			integrityStatus: "ok",
			pricingGaps: [],
		},
		eventLoop: {
			lastLagMs: 0,
			maxRecentLagMs: 0,
		} as SystemStatusResponse["eventLoop"],
		strategy: "session",
		timestamp: new Date(RECOVERS_AT).toISOString(),
	};
}

/**
 * A degraded pool used to be described as "All accounts rate-limited"
 * unconditionally, which is simply wrong when the accounts are sitting out a
 * spent usage window instead — the two states call for different operator
 * reactions (wait for a reset vs. investigate a throttle).
 */
describe("statusSummary — degraded wording is quota-aware", () => {
	it("keeps the rate-limited wording when only locks are involved", () => {
		const { description } = statusSummary(
			makeStatus("degraded", { rate_limited: 2, usage_exhausted: 0 }),
		);
		expect(description).toContain("All accounts rate-limited");
	});

	it("keeps the rate-limited wording when the pool omits usage_exhausted", () => {
		const { description } = statusSummary(
			makeStatus("degraded", { rate_limited: 2 }),
		);
		expect(description).toContain("All accounts rate-limited");
	});

	it("says usage-exhausted when that is the only reason", () => {
		const { description } = statusSummary(
			makeStatus("degraded", { rate_limited: 0, usage_exhausted: 2 }),
		);
		expect(description).toContain("All accounts usage-exhausted");
		expect(description).not.toContain("rate-limited");
	});

	it("uses neutral wording when both reasons are present", () => {
		const { description } = statusSummary(
			makeStatus("degraded", { rate_limited: 1, usage_exhausted: 1 }),
		);
		expect(description).toContain("No accounts available");
	});

	it("still appends the recovery time, and drops it when unknown", () => {
		expect(
			statusSummary(makeStatus("degraded", { usage_exhausted: 1 })).description,
		).toContain("next recovers at");
		expect(
			statusSummary(
				makeStatus("degraded", { usage_exhausted: 1, next_available_at: null }),
			).description,
		).toContain("recovering");
	});

	it("leaves the healthy and unhealthy summaries untouched", () => {
		expect(statusSummary(makeStatus("ok", { routable: 1 })).label).toBe(
			"All Systems Operational",
		);
		expect(
			statusSummary(makeStatus("unhealthy", { configured: 0 })).description,
		).toBe("No accounts configured");
	});
});
