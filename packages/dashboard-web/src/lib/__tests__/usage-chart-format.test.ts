import { describe, expect, it } from "bun:test";
import { pickTimePattern } from "../usage-chart-format";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("pickTimePattern", () => {
	it("uses time-only labels for spans up to 24h", () => {
		expect(pickTimePattern(60_000, HOUR_MS)).toBe("HH:mm"); // 1h
		expect(pickTimePattern(5 * 60_000, 6 * HOUR_MS)).toBe("HH:mm"); // 6h
		expect(pickTimePattern(HOUR_MS, 24 * HOUR_MS)).toBe("HH:mm"); // 24h
	});

	it("adds the day for multi-day spans with sub-daily buckets (7d)", () => {
		expect(pickTimePattern(HOUR_MS, 7 * DAY_MS)).toBe("MMM d HH:mm");
	});

	it("uses date-only labels when buckets are daily (30d)", () => {
		expect(pickTimePattern(DAY_MS, 30 * DAY_MS)).toBe("MMM d");
	});

	it("treats exactly 24h as the time-only boundary, just over it as multi-day", () => {
		expect(pickTimePattern(HOUR_MS, DAY_MS)).toBe("HH:mm");
		expect(pickTimePattern(HOUR_MS, DAY_MS + 1)).toBe("MMM d HH:mm");
	});

	it("prefers date-only whenever buckets are daily, regardless of span", () => {
		// A daily bucket always floors to midnight, so a time component would be
		// redundant ("00:00") even if the span itself is short.
		expect(pickTimePattern(DAY_MS, DAY_MS)).toBe("MMM d");
	});
});
