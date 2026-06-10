import { describe, expect, it } from "bun:test";
import { NO_PROJECT_LABEL, toProjectDonutData } from "./project-donut";

describe("toProjectDonutData", () => {
	it("maps project rows to name/value pairs sorted by requests desc", () => {
		const result = toProjectDonutData([
			{ project: "alpha", requests: 5 },
			{ project: "beta", requests: 42 },
			{ project: "gamma", requests: 17 },
		]);
		expect(result).toEqual([
			{ name: "beta", value: 42 },
			{ name: "gamma", value: 17 },
			{ name: "alpha", value: 5 },
		]);
	});

	it("labels the null bucket as (no project)", () => {
		const result = toProjectDonutData([
			{ project: null, requests: 3 },
			{ project: "alpha", requests: 1 },
		]);
		expect(result[0]).toEqual({ name: NO_PROJECT_LABEL, value: 3 });
	});

	it("drops rows with zero requests", () => {
		const result = toProjectDonutData([
			{ project: "alpha", requests: 0 },
			{ project: "beta", requests: 2 },
		]);
		expect(result).toEqual([{ name: "beta", value: 2 }]);
	});

	it("returns empty array for empty input", () => {
		expect(toProjectDonutData([])).toEqual([]);
	});
});
