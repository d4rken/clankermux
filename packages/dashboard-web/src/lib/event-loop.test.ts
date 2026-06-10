import { describe, expect, it } from "bun:test";
import {
	EVENT_LOOP_ERROR_MS,
	EVENT_LOOP_WARN_MS,
	eventLoopTone,
	formatLagMs,
} from "./event-loop";

describe("formatLagMs", () => {
	it("returns an em dash for missing values", () => {
		expect(formatLagMs(null)).toBe("—");
		expect(formatLagMs(undefined)).toBe("—");
		expect(formatLagMs(Number.NaN)).toBe("—");
		expect(formatLagMs(-5)).toBe("—");
	});

	it("collapses sub-millisecond lag to '<1 ms'", () => {
		expect(formatLagMs(0)).toBe("<1 ms");
		expect(formatLagMs(0.4)).toBe("<1 ms");
		expect(formatLagMs(0.99)).toBe("<1 ms");
	});

	it("rounds whole-millisecond lag", () => {
		expect(formatLagMs(1)).toBe("1 ms");
		expect(formatLagMs(12.4)).toBe("12 ms");
		expect(formatLagMs(249.6)).toBe("250 ms");
	});

	it("locale-groups large values", () => {
		expect(formatLagMs(2345.2)).toBe(`${(2345).toLocaleString()} ms`);
	});
});

describe("eventLoopTone", () => {
	it("is ok below the warn threshold", () => {
		expect(eventLoopTone(0)).toBe("ok");
		expect(eventLoopTone(EVENT_LOOP_WARN_MS - 1)).toBe("ok");
	});

	it("degrades at the warn threshold (250 ms)", () => {
		expect(eventLoopTone(EVENT_LOOP_WARN_MS)).toBe("degraded");
		expect(eventLoopTone(1999)).toBe("degraded");
	});

	it("is unhealthy at the error threshold (2000 ms)", () => {
		expect(eventLoopTone(EVENT_LOOP_ERROR_MS)).toBe("unhealthy");
		expect(eventLoopTone(60_000)).toBe("unhealthy");
	});

	it("treats missing stats as ok (monitor not running)", () => {
		expect(eventLoopTone(undefined)).toBe("ok");
		expect(eventLoopTone(Number.NaN)).toBe("ok");
	});
});
