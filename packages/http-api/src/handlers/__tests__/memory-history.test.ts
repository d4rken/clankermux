import { describe, expect, it } from "bun:test";
import type {
	MemoryHistoryPoint,
	MemoryHistoryResponse,
} from "@clankermux/types";
import {
	createMemoryHistoryHandlerFromSources,
	type MemoryHistorySources,
} from "../memory-history-direct";

const HOUR = 60 * 60 * 1000;

/**
 * Mock MemoryHistorySources (the seam the direct handler reads through; in
 * production this is a repository on the dashboard worker's read-only
 * connection). `captureOpts` lets a test assert the {sinceMs, bucketMs} the
 * handler derived from the range.
 */
function createSources(opts: {
	points: MemoryHistoryPoint[];
	captureOpts?: (o: { sinceMs: number; bucketMs: number }) => void;
}): MemoryHistorySources {
	return {
		getMemorySnapshots: async (o: { sinceMs: number; bucketMs: number }) => {
			opts.captureOpts?.(o);
			return opts.points;
		},
	};
}

async function callHandler(
	sources: MemoryHistorySources,
	range?: string,
): Promise<{ status: number; body: MemoryHistoryResponse }> {
	const handler = createMemoryHistoryHandlerFromSources(sources);
	const params = new URLSearchParams();
	if (range !== undefined) params.set("range", range);
	const res = await handler(params);
	return {
		status: res.status,
		body: (await res.json()) as MemoryHistoryResponse,
	};
}

describe("memory-history handler", () => {
	describe("range → bucket mapping", () => {
		it("maps 6h → bucketMs 300000", async () => {
			let captured: { sinceMs: number; bucketMs: number } | null = null;
			const sources = createSources({
				points: [],
				captureOpts: (o) => {
					captured = o;
				},
			});
			const { body } = await callHandler(sources, "6h");
			expect(captured?.bucketMs).toBe(300_000);
			expect(body.bucketMs).toBe(300_000);
			expect(body.range).toBe("6h");
		});

		it("maps 1h → bucketMs 60000", async () => {
			let captured: { sinceMs: number; bucketMs: number } | null = null;
			const sources = createSources({
				points: [],
				captureOpts: (o) => {
					captured = o;
				},
			});
			const { body } = await callHandler(sources, "1h");
			expect(captured?.bucketMs).toBe(60_000);
			expect(body.bucketMs).toBe(60_000);
		});

		it("defaults to 7d (bucketMs 3600000) when range omitted", async () => {
			let captured: { sinceMs: number; bucketMs: number } | null = null;
			const sources = createSources({
				points: [],
				captureOpts: (o) => {
					captured = o;
				},
			});
			const { body } = await callHandler(sources);
			expect(body.range).toBe("7d");
			expect(captured?.bucketMs).toBe(3_600_000);
		});

		it("falls back to the 7d default for an invalid range", async () => {
			let captured: { sinceMs: number; bucketMs: number } | null = null;
			const sources = createSources({
				points: [],
				captureOpts: (o) => {
					captured = o;
				},
			});
			const { body } = await callHandler(sources, "bogus");
			expect(body.range).toBe("7d");
			expect(captured?.bucketMs).toBe(3_600_000);
		});

		it("maps all → sinceMs 0 with daily buckets (retention-capped)", async () => {
			let captured: { sinceMs: number; bucketMs: number } | null = null;
			const sources = createSources({
				points: [],
				captureOpts: (o) => {
					captured = o;
				},
			});
			const { body } = await callHandler(sources, "all");
			expect(body.range).toBe("all");
			expect(captured?.sinceMs).toBe(0);
			expect(captured?.bucketMs).toBe(24 * HOUR);
			expect(body.bucketMs).toBe(24 * HOUR);
		});

		it("computes sinceMs as now - windowMs for the range", async () => {
			let captured: { sinceMs: number; bucketMs: number } | null = null;
			const sources = createSources({
				points: [],
				captureOpts: (o) => {
					captured = o;
				},
			});
			const before = Date.now();
			await callHandler(sources, "24h");
			const after = Date.now();
			const day = 24 * HOUR;
			expect(captured?.sinceMs).toBeGreaterThanOrEqual(before - day);
			expect(captured?.sinceMs).toBeLessThanOrEqual(after - day);
		});
	});

	describe("response shaping", () => {
		it("returns the bucketed points from the repository unchanged", async () => {
			const t1 = 1_700_000_000_000;
			const points: MemoryHistoryPoint[] = [
				{
					ts: t1,
					rssBytes: 500_000_000,
					heapUsedBytes: 120_000_000,
					heapTotalBytes: 180_000_000,
					eventLoopMaxLagMs: 412,
				},
				{
					ts: t1 + HOUR,
					rssBytes: 520_000_000,
					heapUsedBytes: 118_000_000,
					heapTotalBytes: null,
					eventLoopMaxLagMs: null,
				},
			];
			const sources = createSources({ points });
			const { body } = await callHandler(sources, "24h");
			expect(body.points).toHaveLength(2);
			expect(body.points[0].rssBytes).toBe(500_000_000);
			expect(body.points[0].heapUsedBytes).toBe(120_000_000);
			expect(body.points[0].heapTotalBytes).toBe(180_000_000);
			expect(body.points[0].eventLoopMaxLagMs).toBe(412);
			expect(body.points[1].rssBytes).toBe(520_000_000);
			expect(body.points[1].heapTotalBytes).toBeNull();
			expect(body.points[1].eventLoopMaxLagMs).toBeNull();
		});

		it("returns an empty points array when there is no history", async () => {
			const sources = createSources({ points: [] });
			const { body } = await callHandler(sources, "7d");
			expect(body.points).toEqual([]);
		});
	});
});
