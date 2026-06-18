import { describe, expect, it } from "bun:test";
import type { CacheKeepaliveHistoryPoint } from "@clankermux/database";
import {
	type CacheKeepaliveHistoryResponse,
	type CacheKeepaliveHistorySources,
	createCacheKeepaliveHistoryHandlerFromSources,
} from "./cache-keepalive-history-direct";

const HOUR = 60 * 60 * 1000;

function row(
	ts: number,
	overrides: Partial<CacheKeepaliveHistoryPoint> = {},
): CacheKeepaliveHistoryPoint {
	return {
		ts,
		warmSessions: 0,
		promotedSessions: 0,
		totalBytes: 0,
		keepalivesSent: 0,
		hits: 0,
		misses: 0,
		failures: 0,
		spentUsd: 0,
		savedUsd: 0,
		...overrides,
	};
}

function createSources(opts: {
	rows: CacheKeepaliveHistoryPoint[];
	captureOpts?: (o: { sinceMs: number; bucketMs: number }) => void;
}): CacheKeepaliveHistorySources {
	return {
		getSnapshots: async (o) => {
			opts.captureOpts?.(o);
			return opts.rows;
		},
	};
}

async function callHandler(
	sources: CacheKeepaliveHistorySources,
	range?: string,
): Promise<{ status: number; body: CacheKeepaliveHistoryResponse }> {
	const handler = createCacheKeepaliveHistoryHandlerFromSources(sources);
	const params = new URLSearchParams();
	if (range !== undefined) params.set("range", range);
	const res = await handler(params);
	return {
		status: res.status,
		body: (await res.json()) as CacheKeepaliveHistoryResponse,
	};
}

describe("cache-keepalive-history direct handler", () => {
	describe("range → bucket mapping", () => {
		it("maps 6h → bucketMs 300000 and surfaces it in the response", async () => {
			let captured: { sinceMs: number; bucketMs: number } | null = null;
			const sources = createSources({
				rows: [],
				captureOpts: (o) => {
					captured = o;
				},
			});
			const { body } = await callHandler(sources, "6h");
			expect(captured?.bucketMs).toBe(300_000);
			expect(body.bucketMs).toBe(300_000);
			expect(body.range).toBe("6h");
		});

		it("maps all → sinceMs 0 with daily buckets", async () => {
			let captured: { sinceMs: number; bucketMs: number } | null = null;
			const sources = createSources({
				rows: [],
				captureOpts: (o) => {
					captured = o;
				},
			});
			const { body } = await callHandler(sources, "all");
			expect(captured?.sinceMs).toBe(0);
			expect(captured?.bucketMs).toBe(24 * HOUR);
			expect(body.range).toBe("all");
		});

		it("defaults to 7d when range omitted", async () => {
			const sources = createSources({ rows: [] });
			const { body } = await callHandler(sources);
			expect(body.range).toBe("7d");
			expect(body.bucketMs).toBe(HOUR);
		});
	});

	describe("delta / reset shaping", () => {
		it("emits 0 counter deltas for the first bucket and per-bucket deltas after", async () => {
			const t = 1_700_000_000_000;
			const rows = [
				// Bucket 0: cumulative baseline (includes pre-window activity).
				row(t, {
					warmSessions: 5,
					promotedSessions: 2,
					totalBytes: 1_000,
					keepalivesSent: 10,
					hits: 8,
					misses: 2,
					failures: 1,
					spentUsd: 0.5,
					savedUsd: 4,
				}),
				// Bucket 1: cumulative grew (counters monotonic within a run).
				row(t + HOUR, {
					warmSessions: 7,
					promotedSessions: 3,
					totalBytes: 1_500,
					keepalivesSent: 16,
					hits: 12,
					misses: 3,
					failures: 1,
					spentUsd: 0.9,
					savedUsd: 7,
				}),
			];
			const { body } = await callHandler(createSources({ rows }), "24h");

			expect(body.points).toHaveLength(2);

			const first = body.points[0];
			// First-bucket counter deltas are 0 (avoid a pre-window baseline spike).
			expect(first.keepalivesSent).toBe(0);
			expect(first.hits).toBe(0);
			expect(first.misses).toBe(0);
			expect(first.failures).toBe(0);
			expect(first.spentUsd).toBe(0);
			expect(first.savedUsd).toBe(0);
			expect(first.hitRate).toBe(0);
			// Gauges pass through as-is even for the first bucket.
			expect(first.warmSessions).toBe(5);
			expect(first.promotedSessions).toBe(2);
			expect(first.totalBytes).toBe(1_000);

			const second = body.points[1];
			expect(second.keepalivesSent).toBe(6); // 16 - 10
			expect(second.hits).toBe(4); // 12 - 8
			expect(second.misses).toBe(1); // 3 - 2
			expect(second.failures).toBe(0); // 1 - 1
			expect(second.spentUsd).toBeCloseTo(0.4); // 0.9 - 0.5
			expect(second.savedUsd).toBe(3); // 7 - 4
			expect(second.hitRate).toBeCloseTo(4 / 5); // hitsDelta / (hits+miss delta)
			// Gauges pass through.
			expect(second.warmSessions).toBe(7);
			expect(second.totalBytes).toBe(1_500);
		});

		it("clamps a counter reset (process restart) to the bucket's own value", async () => {
			const t = 1_700_000_000_000;
			const rows = [
				row(t, { keepalivesSent: 100, hits: 90, misses: 10, savedUsd: 50 }),
				row(t + HOUR, {
					keepalivesSent: 120,
					hits: 110,
					misses: 10,
					savedUsd: 60,
				}),
				// Bucket 2: counters dropped (restart) — delta clamps to cur, not cur-prev.
				row(t + 2 * HOUR, {
					keepalivesSent: 5,
					hits: 4,
					misses: 1,
					savedUsd: 2,
				}),
			];
			const { body } = await callHandler(createSources({ rows }), "24h");

			expect(body.points).toHaveLength(3);
			const reset = body.points[2];
			expect(reset.keepalivesSent).toBe(5); // clamped to cur
			expect(reset.hits).toBe(4);
			expect(reset.misses).toBe(1);
			expect(reset.savedUsd).toBe(2);
			expect(reset.hitRate).toBeCloseTo(4 / 5);
		});

		it("returns an empty points array when there is no history", async () => {
			const { body } = await callHandler(createSources({ rows: [] }), "7d");
			expect(body.points).toEqual([]);
		});
	});
});
