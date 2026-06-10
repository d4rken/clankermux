import { describe, expect, it } from "bun:test";
import { NO_PROJECT_LABEL, toProjectDonutData } from "./project-donut";

describe("toProjectDonutData", () => {
	it("maps project rows to name/value pairs sorted by tokens desc", () => {
		const result = toProjectDonutData([
			{ project: "alpha", totalTokens: 5_000 },
			{ project: "beta", totalTokens: 42_000 },
			{ project: "gamma", totalTokens: 17_000 },
		]);
		expect(result).toEqual([
			{ name: "beta", value: 42_000 },
			{ name: "gamma", value: 17_000 },
			{ name: "alpha", value: 5_000 },
		]);
	});

	it("labels the null bucket as (no project)", () => {
		const result = toProjectDonutData([
			{ project: null, totalTokens: 3_000 },
			{ project: "alpha", totalTokens: 1_000 },
		]);
		expect(result[0]).toEqual({ name: NO_PROJECT_LABEL, value: 3_000 });
	});

	it("drops rows with zero tokens", () => {
		const result = toProjectDonutData([
			{ project: "alpha", totalTokens: 0 },
			{ project: "beta", totalTokens: 2_000 },
		]);
		expect(result).toEqual([{ name: "beta", value: 2_000 }]);
	});

	it("returns empty array for empty input", () => {
		expect(toProjectDonutData([])).toEqual([]);
	});
});
