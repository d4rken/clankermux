import { describe, expect, it } from "bun:test";
import { type CumulativePoint, toCumulativeSeries } from "./cumulative";

function point(overrides: Partial<CumulativePoint> & { ts: number }): {
	ts: number;
	requests: number;
	tokens: number;
	cost: number;
	planCost: number;
	apiCost: number;
	time: string;
} {
	return {
		requests: 0,
		tokens: 0,
		cost: 0,
		planCost: 0,
		apiCost: 0,
		time: `t${overrides.ts}`,
		...overrides,
	};
}

describe("toCumulativeSeries", () => {
	it("accumulates running totals across buckets", () => {
		const result = toCumulativeSeries([
			point({
				ts: 1,
				requests: 2,
				tokens: 10,
				cost: 1,
				planCost: 1,
				apiCost: 0,
			}),
			point({
				ts: 2,
				requests: 3,
				tokens: 20,
				cost: 2,
				planCost: 1,
				apiCost: 1,
			}),
			point({
				ts: 3,
				requests: 5,
				tokens: 30,
				cost: 3,
				planCost: 2,
				apiCost: 1,
			}),
		]);
		expect(result.map((p) => p.requests)).toEqual([2, 5, 10]);
		expect(result.map((p) => p.tokens)).toEqual([10, 30, 60]);
		expect(result.map((p) => p.cost)).toEqual([1, 3, 6]);
		expect(result.map((p) => p.planCost)).toEqual([1, 2, 4]);
		expect(result.map((p) => p.apiCost)).toEqual([0, 1, 2]);
	});

	it("collapses multiple rows per timestamp (per-model breakdown) before accumulating", () => {
		const result = toCumulativeSeries([
			// ts=1 split across two models
			point({ ts: 1, requests: 1, tokens: 10, cost: 1 }),
			point({ ts: 1, requests: 4, tokens: 40, cost: 3 }),
			point({ ts: 2, requests: 5, tokens: 50, cost: 5 }),
		]);
		expect(result).toHaveLength(2);
		expect(result[0].requests).toBe(5); // 1 + 4 collapsed
		expect(result[0].tokens).toBe(50); // 10 + 40
		expect(result[1].requests).toBe(10); // 5 (collapsed) + 5
		expect(result[1].tokens).toBe(100); // 50 + 50
	});

	it("sorts by timestamp before accumulating", () => {
		const result = toCumulativeSeries([
			point({ ts: 3, requests: 3 }),
			point({ ts: 1, requests: 1 }),
			point({ ts: 2, requests: 2 }),
		]);
		expect(result.map((p) => p.ts)).toEqual([1, 2, 3]);
		expect(result.map((p) => p.requests)).toEqual([1, 3, 6]);
	});

	it("does not mutate the input rows", () => {
		const input = [point({ ts: 1, requests: 2, tokens: 10 })];
		toCumulativeSeries(input);
		expect(input[0].requests).toBe(2);
		expect(input[0].tokens).toBe(10);
	});

	it("returns an empty array for empty input", () => {
		expect(toCumulativeSeries([])).toEqual([]);
	});

	it("preserves passthrough fields from the first row of each timestamp", () => {
		const result = toCumulativeSeries([
			point({ ts: 1, requests: 1 }),
			point({ ts: 2, requests: 2 }),
		]);
		expect(result[0].time).toBe("t1");
		expect(result[1].time).toBe("t2");
	});
});
