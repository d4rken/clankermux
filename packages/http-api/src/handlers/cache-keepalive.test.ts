import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { bridgeStats, sessionCacheStore } from "@clankermux/proxy";
import type { APIContext } from "./../types";
import { createCacheKeepaliveHandler } from "./cache-keepalive";

/**
 * Minimal context: the live handler only reads context.config (the gauges come
 * from the proxy singletons directly). A tiny config stub avoids spinning up a
 * real Config/DB.
 */
function makeContext(opts: {
	mode?: "off" | "static" | "dynamic";
	minTokens?: number;
}): APIContext {
	return {
		config: {
			getCacheWarmingMode: () => opts.mode ?? "off",
			getCacheWarmingMinTokens: () => opts.minTokens ?? 100_000,
		},
	} as unknown as APIContext;
}

beforeEach(() => {
	bridgeStats.reset();
	sessionCacheStore.clear();
});

afterEach(() => {
	bridgeStats.reset();
	sessionCacheStore.clear();
});

describe("cache-keepalive live handler", () => {
	it("returns the configured mode/minTokens plus live gauges and counters", async () => {
		bridgeStats.recordResult(true, 0.02); // hit
		bridgeStats.recordResult(false, 0.05); // miss
		bridgeStats.recordFailure();
		bridgeStats.recordWarmResume(0.5);

		const handler = createCacheKeepaliveHandler(
			makeContext({ mode: "dynamic", minTokens: 25_000 }),
		);
		const res = handler();
		const body = (await res.json()) as Record<string, number | string>;

		expect(res.status).toBe(200);
		expect(body.mode).toBe("dynamic");
		expect(body.minTokens).toBe(25_000);

		// Cumulative-since-reset counters from bridgeStats.snapshot().
		expect(body.keepalivesSent).toBe(2);
		expect(body.hits).toBe(1);
		expect(body.misses).toBe(1);
		expect(body.failures).toBe(1);
		expect(body.warmResumes).toBe(1);
		expect(body.hitRate).toBeCloseTo(0.5);
		expect(body.savedUsd).toBeCloseTo(0.5);

		// Live gauges from the session cache store (empty store ⇒ zeros).
		expect(body.warmSessions).toBe(sessionCacheStore.getSize());
		expect(body.promotedSessions).toBe(sessionCacheStore.getPromotedSessions());
		expect(body.totalBytes).toBe(sessionCacheStore.getTotalBytes());
	});

	it("reports the off mode when warming is disabled", async () => {
		const handler = createCacheKeepaliveHandler(makeContext({ mode: "off" }));
		const body = (await handler().json()) as Record<string, unknown>;
		expect(body.mode).toBe("off");
		expect(body.keepalivesSent).toBe(0);
		expect(body.hitRate).toBe(0);
	});
});
