import { describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import type {
	MemoryHistoryPoint,
	MemoryHistoryResponse,
} from "@clankermux/types";
import { createMemoryHistoryHandler } from "../memory-history";

const HOUR = 60 * 60 * 1000;

/**
 * Mock DatabaseOperations exposing only getMemorySnapshots. `captureOpts` lets a
 * test assert the {sinceMs, bucketMs} the handler derived from the range.
 */
function createDbOps(opts: {
	points: MemoryHistoryPoint[];
	captureOpts?: (o: { sinceMs: number; bucketMs: number }) => void;
}): DatabaseOperations {
	return {
		getMemorySnapshots: async (o: { sinceMs: number; bucketMs: number }) => {
			opts.captureOpts?.(o);
			return opts.points;
		},
	} as unknown as DatabaseOperations;
}

async function callHandler(
	dbOps: DatabaseOperations,
	range?: string,
): Promise<{ status: number; body: MemoryHistoryResponse }> {
	const handler = createMemoryHistoryHandler(dbOps);
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
			const dbOps = createDbOps({
				points: [],
				captureOpts: (o) => {
					captured = o;
				},
			});
			const { body } = await callHandler(dbOps, "6h");
			expect(captured?.bucketMs).toBe(300_000);
			expect(body.bucketMs).toBe(300_000);
			expect(body.range).toBe("6h");
		});

		it("maps 1h → bucketMs 60000", async () => {
			let captured: { sinceMs: number; bucketMs: number } | null = null;
			const dbOps = createDbOps({
				points: [],
				captureOpts: (o) => {
					captured = o;
				},
			});
			const { body } = await callHandler(dbOps, "1h");
			expect(captured?.bucketMs).toBe(60_000);
			expect(body.bucketMs).toBe(60_000);
		});

		it("defaults to 7d (bucketMs 3600000) when range omitted", async () => {
			let captured: { sinceMs: number; bucketMs: number } | null = null;
			const dbOps = createDbOps({
				points: [],
				captureOpts: (o) => {
					captured = o;
				},
			});
			const { body } = await callHandler(dbOps);
			expect(body.range).toBe("7d");
			expect(captured?.bucketMs).toBe(3_600_000);
		});

		it("falls back to the 7d default for an invalid range", async () => {
			let captured: { sinceMs: number; bucketMs: number } | null = null;
			const dbOps = createDbOps({
				points: [],
				captureOpts: (o) => {
					captured = o;
				},
			});
			const { body } = await callHandler(dbOps, "bogus");
			expect(body.range).toBe("7d");
			expect(captured?.bucketMs).toBe(3_600_000);
		});

		it("computes sinceMs as now - windowMs for the range", async () => {
			let captured: { sinceMs: number; bucketMs: number } | null = null;
			const dbOps = createDbOps({
				points: [],
				captureOpts: (o) => {
					captured = o;
				},
			});
			const before = Date.now();
			await callHandler(dbOps, "24h");
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
				},
				{
					ts: t1 + HOUR,
					rssBytes: 520_000_000,
					heapUsedBytes: 118_000_000,
					heapTotalBytes: null,
				},
			];
			const dbOps = createDbOps({ points });
			const { body } = await callHandler(dbOps, "24h");
			expect(body.points).toHaveLength(2);
			expect(body.points[0].rssBytes).toBe(500_000_000);
			expect(body.points[0].heapUsedBytes).toBe(120_000_000);
			expect(body.points[0].heapTotalBytes).toBe(180_000_000);
			expect(body.points[1].rssBytes).toBe(520_000_000);
			expect(body.points[1].heapTotalBytes).toBeNull();
		});

		it("returns an empty points array when there is no history", async () => {
			const dbOps = createDbOps({ points: [] });
			const { body } = await callHandler(dbOps, "7d");
			expect(body.points).toEqual([]);
		});
	});
});
