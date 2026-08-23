import { describe, expect, it } from "bun:test";
import {
	extractFiveHour,
	extractSevenDay,
	isAlibabaShape,
	isAnthropicStyleShape,
	isZaiShape,
	normalizeResetMs,
} from "./usage-window-extract";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

describe("normalizeResetMs", () => {
	it("returns null for null/undefined", () => {
		expect(normalizeResetMs(null)).toBeNull();
		expect(normalizeResetMs(undefined)).toBeNull();
	});

	it("returns finite numbers as-is", () => {
		expect(normalizeResetMs(1_700_000_000_000)).toBe(1_700_000_000_000);
	});

	it("returns null for non-finite numbers", () => {
		expect(normalizeResetMs(Number.NaN)).toBeNull();
		expect(normalizeResetMs(Number.POSITIVE_INFINITY)).toBeNull();
	});

	it("parses ISO strings", () => {
		const iso = "2024-01-01T00:00:00.000Z";
		expect(normalizeResetMs(iso)).toBe(Date.parse(iso));
	});

	it("returns null for unparseable strings", () => {
		expect(normalizeResetMs("not-a-date")).toBeNull();
	});
});

describe("shape detectors", () => {
	it("isAlibabaShape true for Alibaba data", () => {
		expect(
			isAlibabaShape({
				five_hour: { percentUsed: 0, resetAt: 0 },
				weekly: { percentUsed: 0, resetAt: 0 },
			} as never),
		).toBe(true);
	});

	it("isZaiShape true when tokens_limit present", () => {
		expect(
			isZaiShape({
				tokens_limit: { percentage: 0, resetAt: 0 },
			} as never),
		).toBe(true);
	});

	it("isAnthropicStyleShape excludes alibaba/zai", () => {
		expect(
			isAnthropicStyleShape({
				five_hour: { utilization: 0, resets_at: null },
				seven_day: { utilization: 0, resets_at: null },
			} as never),
		).toBe(true);
		expect(
			isAnthropicStyleShape({
				five_hour: { percentUsed: 0, resetAt: 0 },
				weekly: { percentUsed: 0, resetAt: 0 },
			} as never),
		).toBe(false);
	});

	it("isAnthropicStyleShape is true for a limits[]-only payload", () => {
		expect(
			isAnthropicStyleShape({
				limits: [
					{
						kind: "session",
						group: "session",
						percent: 0,
						resets_at: null,
						scope: null,
						is_active: true,
					},
				],
			} as never),
		).toBe(true);
	});
});

describe("extractFiveHour", () => {
	it("reads the flat Anthropic session window", () => {
		expect(
			extractFiveHour({
				five_hour: {
					utilization: 42,
					resets_at: new Date(NOW + HOUR).toISOString(),
				},
				seven_day: { utilization: 7, resets_at: null },
			} as never),
		).toEqual({ pct: 42, resetMs: NOW + HOUR });
	});

	it("reads a limits[]-only Anthropic payload through the normalizer", () => {
		expect(
			extractFiveHour({
				limits: [
					{
						kind: "session",
						group: "session",
						percent: 61,
						resets_at: new Date(NOW + HOUR).toISOString(),
						scope: null,
						is_active: true,
					},
				],
			} as never),
		).toEqual({ pct: 61, resetMs: NOW + HOUR });
	});

	it("reads Alibaba percentUsed / resetAt", () => {
		expect(
			extractFiveHour({
				five_hour: { percentUsed: 30, resetAt: NOW + HOUR },
				weekly: { percentUsed: 10, resetAt: NOW + 7 * 24 * HOUR },
			} as never),
		).toEqual({ pct: 30, resetMs: NOW + HOUR });
	});

	it("reads the Zai token window", () => {
		expect(
			extractFiveHour({
				tokens_limit: { percentage: 88, resetAt: NOW + HOUR },
			} as never),
		).toEqual({ pct: 88, resetMs: NOW + HOUR });
	});

	it("reports a recognised Zai payload with no token window as no reading", () => {
		// `{pct: null}` — the shape was understood, the value is absent. That is a
		// different answer from `null`, which means the shape was not recognised.
		expect(
			extractFiveHour({
				time_limit: { percentage: 10, resetAt: NOW },
				tokens_limit: null,
			} as never),
		).toEqual({ pct: null, resetMs: null });
	});

	it("returns null for a payload it does not recognise", () => {
		expect(extractFiveHour({ something_else: 1 } as never)).toBeNull();
	});
});

describe("extractSevenDay", () => {
	it("reads the flat Anthropic account-wide weekly window", () => {
		expect(
			extractSevenDay({
				five_hour: { utilization: 42, resets_at: null },
				seven_day: {
					utilization: 12,
					resets_at: new Date(NOW + 3 * 24 * HOUR).toISOString(),
				},
			} as never),
		).toEqual({ pct: 12, resetMs: NOW + 3 * 24 * HOUR });
	});

	it("reads Alibaba weekly percentUsed / resetAt", () => {
		expect(
			extractSevenDay({
				five_hour: { percentUsed: 30, resetAt: NOW + HOUR },
				weekly: { percentUsed: 55, resetAt: NOW + 7 * 24 * HOUR },
			} as never),
		).toEqual({ pct: 55, resetMs: NOW + 7 * 24 * HOUR });
	});

	it("has no weekly window for Zai at all", () => {
		// Zai reports a token window but no weekly one, so this is `null` (the
		// provider has no such window) rather than an unread value.
		expect(
			extractSevenDay({
				tokens_limit: { percentage: 88, resetAt: NOW + HOUR },
			} as never),
		).toBeNull();
	});

	it("returns null for a payload it does not recognise", () => {
		expect(extractSevenDay({ something_else: 1 } as never)).toBeNull();
	});
});
