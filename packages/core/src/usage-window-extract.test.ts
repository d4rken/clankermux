import { describe, expect, it } from "bun:test";
import {
	extractDaily,
	extractFiveHour,
	extractSevenDay,
	isAlibabaShape,
	isAnthropicStyleShape,
	isDevinShape,
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

	it("preserves single-window Zai plans without a weekly quota", () => {
		expect(
			extractSevenDay({
				tokens_limit: { percentage: 88, resetAt: NOW + HOUR },
			} as never),
		).toBeNull();
	});
	it("reads Zai weekly quota independently of the five-hour reset", () => {
		expect(
			extractSevenDay({
				tokens_limit: { percentage: 20, resetAt: NOW + HOUR },
				tokens_limit_weekly: { percentage: 90, resetAt: NOW + 1000 },
			} as never),
		).toEqual({ pct: 90, resetMs: NOW + 1000 });
	});

	it("returns null for a payload it does not recognise", () => {
		expect(extractSevenDay({ something_else: 1 } as never)).toBeNull();
	});
});

/**
 * Devin reports calendar daily and weekly windows and no 5-hour one. A payload
 * shaped like this used to reach none of the extractors, which is why a Devin
 * account had no Overview quota tile.
 */
const DEVIN_USAGE = {
	kind: "devin",
	quotaBased: true,
	daily: { utilization: 40, resetAt: NOW + 6 * HOUR },
	weekly: { utilization: 65, resetAt: NOW + 3 * 24 * HOUR },
	planName: "Team",
	email: null,
	accountId: null,
} as const;

describe("devin windows", () => {
	it("isDevinShape keys off the discriminant, not the window names", () => {
		expect(isDevinShape(DEVIN_USAGE as never)).toBe(true);
		expect(isDevinShape({ daily: null, weekly: null } as never)).toBe(false);
		expect(isDevinShape(null)).toBe(false);
	});

	it("is not mistaken for an Anthropic-style payload", () => {
		expect(isAnthropicStyleShape(DEVIN_USAGE as never)).toBe(false);
		expect(isAlibabaShape(DEVIN_USAGE as never)).toBe(false);
		expect(isZaiShape(DEVIN_USAGE as never)).toBe(false);
	});

	it("extractDaily reads the daily window", () => {
		expect(extractDaily(DEVIN_USAGE as never)).toEqual({
			pct: 40,
			resetMs: NOW + 6 * HOUR,
		});
	});

	it("extractSevenDay reads the weekly window", () => {
		expect(extractSevenDay(DEVIN_USAGE as never)).toEqual({
			pct: 65,
			resetMs: NOW + 3 * 24 * HOUR,
		});
	});

	it("reports no 5-hour window rather than inventing one from daily", () => {
		expect(extractFiveHour(DEVIN_USAGE as never)).toBeNull();
	});

	it("reports a nulled window as unread, not as absent", () => {
		// Devin nulls a window for a hidden allowance, a credit-billed plan, an
		// unreadable percentage AND a response with no plan status, without
		// saying which. Absence and failure are indistinguishable here, so the
		// answer is `{ pct: null }` — standing unknown — rather than the `null`
		// that would announce an account quota never constrains.
		const noWindows = {
			...DEVIN_USAGE,
			quotaBased: false,
			daily: null,
			weekly: null,
		};
		expect(extractDaily(noWindows as never)).toEqual({
			pct: null,
			resetMs: null,
		});
		expect(extractSevenDay(noWindows as never)).toEqual({
			pct: null,
			resetMs: null,
		});
		// A shape nobody recognises is still a different answer from that.
		expect(extractDaily({ something_else: 1 } as never)).toBeNull();
	});
});
