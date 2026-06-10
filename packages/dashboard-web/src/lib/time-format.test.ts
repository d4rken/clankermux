import { describe, expect, it } from "bun:test";
import {
	formatAxisTime,
	formatTooltipTime,
	makeTimeTooltipLabelFormatter,
} from "./time-format";

// Build timestamps from local-time components so assertions are independent of
// the machine's timezone: date-fns formats in local time, so the components we
// pass in are exactly what comes back out. 2026-06-02 is a Tuesday.
const ts = new Date(2026, 5, 2, 14, 30).getTime(); // Jun 2 2026, 14:30 local

describe("formatAxisTime", () => {
	it("shows time-of-day for ranges of 24h or less", () => {
		expect(formatAxisTime(ts, "1h")).toBe("14:30");
		expect(formatAxisTime(ts, "6h")).toBe("14:30");
		expect(formatAxisTime(ts, "24h")).toBe("14:30");
	});

	it("shows the calendar date for multi-day ranges", () => {
		expect(formatAxisTime(ts, "7d")).toBe("Jun 2");
		expect(formatAxisTime(ts, "30d")).toBe("Jun 2");
		expect(formatAxisTime(ts, "all")).toBe("Jun 2");
	});
});

describe("formatTooltipTime", () => {
	it("shows time-of-day for ranges of 24h or less", () => {
		expect(formatTooltipTime(ts, "1h")).toBe("14:30");
		expect(formatTooltipTime(ts, "6h")).toBe("14:30");
		expect(formatTooltipTime(ts, "24h")).toBe("14:30");
	});

	it("includes weekday, date and time for the hourly 7d range", () => {
		expect(formatTooltipTime(ts, "7d")).toBe("Tue, Jun 2 · 14:30");
	});

	it("includes weekday and date but no time for the daily 30d range", () => {
		expect(formatTooltipTime(ts, "30d")).toBe("Tue, Jun 2");
	});

	it("adds the year for the all-time range (spans can cross years)", () => {
		expect(formatTooltipTime(ts, "all")).toBe("Tue, Jun 2, 2026");
	});
});

describe("makeTimeTooltipLabelFormatter", () => {
	it("renders the rich tooltip time from the payload's ts", () => {
		const fmt = makeTimeTooltipLabelFormatter("7d");
		// biome-ignore lint/suspicious/noExplicitAny: minimal recharts payload stub
		const result = fmt("Jun 2", [{ payload: { ts } }] as any);
		expect(result).toBe("Tue, Jun 2 · 14:30");
	});

	it("falls back to the axis label string when no ts is present", () => {
		const fmt = makeTimeTooltipLabelFormatter("7d");
		// biome-ignore lint/suspicious/noExplicitAny: minimal recharts payload stub
		expect(fmt("Jun 2", [] as any)).toBe("Jun 2");
		// biome-ignore lint/suspicious/noExplicitAny: minimal recharts payload stub
		expect(fmt("Jun 2", undefined as any)).toBe("Jun 2");
	});
});
