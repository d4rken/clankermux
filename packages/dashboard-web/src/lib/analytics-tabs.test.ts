import { describe, expect, it } from "bun:test";
import { TIME_RANGES } from "../constants";
import {
	type AnalyticsTabId,
	DEFAULT_RANGES,
	DEFAULT_TAB,
	sanitizeTab,
	TAB_IDS,
} from "./analytics-tabs";

const VALID_RANGES = new Set(Object.keys(TIME_RANGES));

describe("sanitizeTab", () => {
	it("returns the same id for each valid TAB_ID", () => {
		for (const id of TAB_IDS) {
			expect(sanitizeTab(id)).toBe(id);
		}
	});

	it("falls back to DEFAULT_TAB for null", () => {
		expect(sanitizeTab(null)).toBe(DEFAULT_TAB);
	});

	it("falls back to DEFAULT_TAB for undefined", () => {
		expect(sanitizeTab(undefined)).toBe(DEFAULT_TAB);
	});

	it("falls back to DEFAULT_TAB for an empty string", () => {
		expect(sanitizeTab("")).toBe(DEFAULT_TAB);
	});

	it("falls back to DEFAULT_TAB for an unknown string", () => {
		expect(sanitizeTab("bogus")).toBe(DEFAULT_TAB);
	});
});

describe("DEFAULT_RANGES", () => {
	it("has exactly one entry per TAB_ID", () => {
		const keys = Object.keys(DEFAULT_RANGES);
		expect(keys.length).toBe(TAB_IDS.length);
		for (const id of TAB_IDS) {
			expect(DEFAULT_RANGES).toHaveProperty(id);
		}
	});

	it("maps every tab to a valid TimeRange string", () => {
		for (const id of TAB_IDS) {
			const range = DEFAULT_RANGES[id as AnalyticsTabId];
			expect(VALID_RANGES.has(range)).toBe(true);
		}
	});
});
