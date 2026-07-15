/**
 * Tests for GET /api/system/status — specifically the eventLoop lag block fed
 * by the optional getEventLoopLag getter (the event-loop monitor lives in the
 * server process; the handler only surfaces its stats).
 */
import { describe, expect, it } from "bun:test";
import { usageCache } from "@clankermux/providers";
import type {
	AnthropicUsageData,
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
