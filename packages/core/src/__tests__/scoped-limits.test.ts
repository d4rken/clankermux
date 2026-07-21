import { describe, expect, it } from "bun:test";
import {
	FAMILY_WEEKLY_EXHAUSTED_THRESHOLD_PERCENT,
	getExhaustedFamilies,
	isFamilyWeeklyExhaustedWithHeadroom,
} from "@clankermux/core";
import type {
	AnthropicLimitEntry,
	AnthropicUsageData,
	CapacitySignal,
} from "@clankermux/types";

const NOW = 1_000_000_000_000; // fixed reference "now" (ms)
const FUTURE_ISO = new Date(NOW + 60 * 60 * 1000).toISOString(); // +1h
const PAST_ISO = new Date(NOW - 60 * 60 * 1000).toISOString(); // -1h

/** Build a weekly_scoped limit entry, overriding fields as needed. */
function scopedEntry(
	overrides: Partial<AnthropicLimitEntry> & {
		displayName?: string | null;
	} = {},
): AnthropicLimitEntry {
	const { displayName, ...rest } = overrides;
	const hasDisplay = "displayName" in overrides;
	return {
		kind: "weekly_scoped",
		group: "weekly",
		percent: 100,
		resets_at: FUTURE_ISO,
		scope: hasDisplay
			? {
					model: { id: "some-id", display_name: displayName ?? null },
				}
			: { model: { id: "claude-fable-5", display_name: "Fable" } },
		is_active: true,
		...rest,
	};
}

/** Anthropic-shaped usage data wrapping a set of limit entries. */
function usage(limits: AnthropicLimitEntry[]): AnthropicUsageData {
	return {
		five_hour: { utilization: 10, resets_at: FUTURE_ISO },
		seven_day: { utilization: 20, resets_at: FUTURE_ISO },
		limits,
	};
}

describe("getExhaustedFamilies", () => {
	it("returns a fully-exhausted future scoped Fable window", () => {
		const result = getExhaustedFamilies(
			usage([scopedEntry({ displayName: "Fable", percent: 100 })]),
			NOW,
		);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			family: "fable",
			percent: 100,
			resetsAtMs: Date.parse(FUTURE_ISO),
			isActive: true,
			displayName: "Fable",
		});
	});

	it("excludes entries just under the threshold (99%)", () => {
		const result = getExhaustedFamilies(
			usage([scopedEntry({ displayName: "Fable", percent: 99 })]),
			NOW,
		);
		expect(result).toEqual([]);
	});

	it("excludes a stale (past reset) exhausted window", () => {
		const result = getExhaustedFamilies(
			usage([
				scopedEntry({
					displayName: "Fable",
					percent: 100,
					resets_at: PAST_ISO,
				}),
			]),
			NOW,
		);
		expect(result).toEqual([]);
	});

	it("excludes entries with percent null", () => {
		const result = getExhaustedFamilies(
			usage([scopedEntry({ displayName: "Fable", percent: null })]),
			NOW,
		);
		expect(result).toEqual([]);
	});

	it("excludes non-finite percents (NaN must not qualify as exhausted)", () => {
		expect(
			getExhaustedFamilies(
				usage([scopedEntry({ displayName: "Fable", percent: Number.NaN })]),
				NOW,
			),
		).toEqual([]);
		expect(
			getExhaustedFamilies(
				usage([
					scopedEntry({
						displayName: "Fable",
						percent: Number.POSITIVE_INFINITY,
					}),
				]),
				NOW,
			),
		).toEqual([]);
	});

	it("excludes entries with resets_at null", () => {
		const result = getExhaustedFamilies(
			usage([scopedEntry({ displayName: "Fable", resets_at: null })]),
			NOW,
		);
		expect(result).toEqual([]);
	});

	it("excludes entries whose kind is not weekly_scoped", () => {
		const result = getExhaustedFamilies(
			usage([scopedEntry({ displayName: "Fable", kind: "weekly" })]),
			NOW,
		);
		expect(result).toEqual([]);
	});

	it("excludes display names that map to no family", () => {
		const result = getExhaustedFamilies(
			usage([scopedEntry({ displayName: "Something" })]),
			NOW,
		);
		expect(result).toEqual([]);
	});

	it("maps Opus and Sonnet display names to their families", () => {
		const result = getExhaustedFamilies(
			usage([
				scopedEntry({ displayName: "Opus" }),
				scopedEntry({ displayName: "Sonnet" }),
			]),
			NOW,
		);
		expect(result.map((r) => r.family).sort()).toEqual(["opus", "sonnet"]);
	});

	it("returns qualifying entries even when is_active is false (not gated)", () => {
		const result = getExhaustedFamilies(
			usage([
				scopedEntry({ displayName: "Fable", percent: 100, is_active: false }),
			]),
			NOW,
		);
		expect(result).toHaveLength(1);
		expect(result[0].family).toBe("fable");
		expect(result[0].isActive).toBe(false);
	});

	it("returns [] for null usage data", () => {
		expect(getExhaustedFamilies(null, NOW)).toEqual([]);
	});

	it("returns [] for undefined usage data", () => {
		expect(getExhaustedFamilies(undefined, NOW)).toEqual([]);
	});

	it("returns [] for a genuinely non-Anthropic (zai) shape with no limits[]", () => {
		const zai = {
			tokens_limit: { percentage: 100, resetAt: null },
			time_limit: null,
		} as unknown as AnthropicUsageData;
		expect(getExhaustedFamilies(zai, NOW)).toEqual([]);
	});

	it("detects an exhausted family from a limits[]-only payload (no flat keys)", () => {
		// Upstream limits[]-only shape: the flat five_hour/seven_day keys are gone.
		// The old both-flat-keys guard would have returned [] here — now detected.
		const limitsOnly = {
			limits: [
				scopedEntry({ displayName: "Fable", percent: 100 }),
				scopedEntry({ displayName: "Sonnet", percent: 40 }), // under threshold
			],
		} as unknown as AnthropicUsageData;
		const result = getExhaustedFamilies(limitsOnly, NOW);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			family: "fable",
			percent: 100,
			resetsAtMs: Date.parse(FUTURE_ISO),
			isActive: true,
			displayName: "Fable",
		});
	});

	it("returns all qualifying entries when several are exhausted", () => {
		const result = getExhaustedFamilies(
			usage([
				scopedEntry({ displayName: "Fable", percent: 100 }),
				scopedEntry({ displayName: "Opus", percent: 100 }),
				scopedEntry({ displayName: "Sonnet", percent: 99 }), // excluded
			]),
			NOW,
		);
		expect(result.map((r) => r.family).sort()).toEqual(["fable", "opus"]);
	});

	it("respects a custom threshold percent", () => {
		const result = getExhaustedFamilies(
			usage([scopedEntry({ displayName: "Fable", percent: 90 })]),
			NOW,
			90,
		);
		expect(result).toHaveLength(1);
		expect(result[0].family).toBe("fable");
	});

	it("uses 100 as the default threshold constant", () => {
		expect(FAMILY_WEEKLY_EXHAUSTED_THRESHOLD_PERCENT).toBe(100);
	});
});

describe("isFamilyWeeklyExhaustedWithHeadroom", () => {
	const capacity = (minHeadroom: number): CapacitySignal => ({
		minHeadroom,
		sessionHeadroom: 100,
		soonestResetMs: null,
		bindingUtilization: 100 - minHeadroom,
		weeklyResetMs: null,
		bindingWeeklyResetMs: null,
		weeklyHeadroom: 100,
	});

	it("is true when the family is exhausted and unified headroom remains", () => {
		expect(
			isFamilyWeeklyExhaustedWithHeadroom(
				usage([scopedEntry({ displayName: "Fable", percent: 100 })]),
				capacity(50),
				"fable",
				NOW,
			),
		).toBe(true);
	});

	it("is false (fail-open) when capacity is null even if family exhausted", () => {
		expect(
			isFamilyWeeklyExhaustedWithHeadroom(
				usage([scopedEntry({ displayName: "Fable", percent: 100 })]),
				null,
				"fable",
				NOW,
			),
		).toBe(false);
	});

	it("is false when unified headroom is also zero", () => {
		expect(
			isFamilyWeeklyExhaustedWithHeadroom(
				usage([scopedEntry({ displayName: "Fable", percent: 100 })]),
				capacity(0),
				"fable",
				NOW,
			),
		).toBe(false);
	});

	it("is false (fail-open) when minHeadroom is non-finite", () => {
		expect(
			isFamilyWeeklyExhaustedWithHeadroom(
				usage([scopedEntry({ displayName: "Fable", percent: 100 })]),
				capacity(Number.NaN),
				"fable",
				NOW,
			),
		).toBe(false);
	});

	it("is false when the family is not in the exhausted set", () => {
		expect(
			isFamilyWeeklyExhaustedWithHeadroom(
				usage([scopedEntry({ displayName: "Fable", percent: 100 })]),
				capacity(50),
				"opus",
				NOW,
			),
		).toBe(false);
	});

	it("is false when usage data is null", () => {
		expect(
			isFamilyWeeklyExhaustedWithHeadroom(null, capacity(50), "fable", NOW),
		).toBe(false);
	});
});
