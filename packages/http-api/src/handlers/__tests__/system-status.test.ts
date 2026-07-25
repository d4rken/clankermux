/**
 * Tests for GET /api/system/status — specifically the eventLoop lag block fed
 * by the optional getEventLoopLag getter (the event-loop monitor lives in the
 * server process; the handler only surfaces its stats), and the pricing-gap
 * list fed by the optional getPricingGaps getter.
 */
import { describe, expect, it } from "bun:test";
import { __pricingTestHooks } from "@clankermux/core";
import { usageCache } from "@clankermux/providers";
import type {
	AnthropicUsageData,
	PricingGap,
	SystemStatusResponse,
} from "@clankermux/types";
import { createSystemStatusHandler } from "../system";

function makeDbOps() {
	return {
		getAllAccounts: async () => [
			{ name: "acc1", paused: false, rate_limited_until: null },
		],
	} as unknown as import("@clankermux/database").DatabaseOperations;
}

function makeConfig() {
	return {
		getStrategy: () => "session",
	} as unknown as import("@clankermux/config").Config;
}

describe("system status handler — eventLoop", () => {
	it("surfaces the injected event-loop lag stats", async () => {
		const handler = createSystemStatusHandler(
			makeDbOps(),
			makeConfig(),
			() => ({ healthy: true }),
			undefined,
			() => ({ lastLagMs: 12, maxLagMs: 3400, maxRecentLagMs: 250 }),
		);

		const response = await handler();
		const body = (await response.json()) as SystemStatusResponse;

		expect(response.status).toBe(200);
		expect(body.eventLoop).toEqual({
			lastLagMs: 12,
			maxLagMs: 3400,
			maxRecentLagMs: 250,
		});
	});

	it("defaults eventLoop to zeros when no getter is wired", async () => {
		const handler = createSystemStatusHandler(makeDbOps(), makeConfig());

		const response = await handler();
		const body = (await response.json()) as SystemStatusResponse;

		expect(response.status).toBe(200);
		expect(body.eventLoop).toEqual({
			lastLagMs: 0,
			maxLagMs: 0,
			maxRecentLagMs: 0,
		});
	});
});

describe("system status handler — pricing gaps", () => {
	const gap: PricingGap = {
		key: "9".repeat(64),
		fingerprint: "9".repeat(16),
		modelId: "claude-not-yet-priced-9",
		provider: "anthropic",
		reason: "model_missing",
		occurrences: 42,
		firstSeenAt: 1_700_000_000_000,
		lastSeenAt: 1_700_000_060_000,
	};

	it("surfaces the injected pricing gaps on the runtime block", async () => {
		const handler = createSystemStatusHandler(
			makeDbOps(),
			makeConfig(),
			() => ({ healthy: true }),
			undefined,
			undefined,
			() => [gap],
		);

		const response = await handler();
		const body = (await response.json()) as SystemStatusResponse;

		expect(response.status).toBe(200);
		expect(body.runtime.pricingGaps).toEqual([gap]);
	});

	it("does NOT flip the top-level status when a gap is present", async () => {
		// `/health` answers 503 for a non-ok status and is consumed by container
		// health checks. A model missing from the pricing catalogue degrades
		// costing, not serving — it must never take the proxy out of rotation.
		const handler = createSystemStatusHandler(
			makeDbOps(),
			makeConfig(),
			() => ({ healthy: true }),
			undefined,
			undefined,
			() => [gap],
		);

		const body = (await (await handler()).json()) as SystemStatusResponse;

		expect(body.status).toBe("ok");
	});

	it("reports an empty list when no getter is wired and nothing has missed", async () => {
		// Falls through to the process-wide accessor. `bun test` shares one
		// process across files, so clear anything an earlier suite recorded.
		__pricingTestHooks.reset();
		const handler = createSystemStatusHandler(makeDbOps(), makeConfig());

		const body = (await (await handler()).json()) as SystemStatusResponse;

		expect(body.runtime.pricingGaps).toEqual([]);
	});
});

describe("system status handler — usage-exhaustion consistency with /health", () => {
	it("counts a 100%-weekly account as usage_exhausted / not routable (same resolver as /health)", async () => {
		const id = "system-exh-acct-1";
		const futureIso = new Date(Date.now() + 3_600_000).toISOString();
		usageCache.set(id, {
			limits: [
				{
					kind: "weekly_all",
					group: "weekly",
					percent: 100,
					resets_at: futureIso,
					scope: null,
					is_active: true,
				},
			],
		} as AnthropicUsageData);
		try {
			const dbOps = {
				getAllAccounts: async () => [
					{
						id,
						name: "exhausted",
						provider: "anthropic",
						paused: false,
						rate_limited_until: null,
					},
				],
			} as unknown as import("@clankermux/database").DatabaseOperations;

			const handler = createSystemStatusHandler(dbOps, makeConfig(), () => ({
				healthy: true,
			}));
			const response = await handler();
			const body = (await response.json()) as SystemStatusResponse;

			expect(body.pool?.usage_exhausted).toBe(1);
			expect(body.pool?.routable).toBe(0);
		} finally {
			usageCache.delete(id);
		}
	});
});
