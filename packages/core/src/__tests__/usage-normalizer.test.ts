import { describe, expect, it } from "bun:test";
import type {
	AnthropicLimitEntry,
	AnthropicUsageData,
} from "@clankermux/types";
import {
	getRepresentativeUtilization,
	isAnthropicUsageShape,
	normalizeAnthropicUsage,
} from "../usage-normalizer";

const NOW = 1_000_000_000_000; // fixed reference "now" (ms)
const FUTURE_ISO = new Date(NOW + 60 * 60 * 1000).toISOString(); // +1h
const PAST_ISO = new Date(NOW - 60 * 60 * 1000).toISOString(); // -1h
const FUTURE_MS = Date.parse(FUTURE_ISO);

/** Build a limits[] entry, overriding fields as needed. */
function entry(
	overrides: Partial<AnthropicLimitEntry> = {},
): AnthropicLimitEntry {
	return {
		kind: "session",
		group: "session",
		percent: 0,
		resets_at: FUTURE_ISO,
		scope: null,
		is_active: true,
		...overrides,
	};
}

/** Build a weekly_scoped entry for a given display name. */
function scoped(
	displayName: string | null,
	overrides: Partial<AnthropicLimitEntry> = {},
): AnthropicLimitEntry {
	return entry({
		kind: "weekly_scoped",
		group: "weekly",
		percent: 50,
		scope: { model: { id: "some-id", display_name: displayName } },
		...overrides,
	});
}

describe("normalizeAnthropicUsage — flat-only payloads", () => {
	it("reads session from flat five_hour and weeklyAll from flat seven_day", () => {
		const data: AnthropicUsageData = {
			five_hour: { utilization: 20, resets_at: FUTURE_ISO },
			seven_day: { utilization: 40, resets_at: PAST_ISO },
		};
		const n = normalizeAnthropicUsage(data, NOW);
		expect(n.session).toEqual({ utilization: 20, resetMs: FUTURE_MS });
		expect(n.weeklyAll).toEqual({
			utilization: 40,
			resetMs: Date.parse(PAST_ISO),
		});
		expect(n.weeklyScoped).toEqual([]);
	});

	it("treats a flat window with null utilization as absent (null, never 0)", () => {
		const data: AnthropicUsageData = {
			five_hour: { utilization: null, resets_at: FUTURE_ISO },
			seven_day: { utilization: null, resets_at: FUTURE_ISO },
		};
		const n = normalizeAnthropicUsage(data, NOW);
		expect(n.session).toBeNull();
		expect(n.weeklyAll).toBeNull();
	});

	it("maps null / unparseable resets_at to resetMs null", () => {
		const data: AnthropicUsageData = {
			five_hour: { utilization: 20, resets_at: null },
			seven_day: {
				utilization: 40,
				resets_at: "not-a-real-date",
			} as unknown as AnthropicUsageData["seven_day"],
		};
		const n = normalizeAnthropicUsage(data, NOW);
		expect(n.session).toEqual({ utilization: 20, resetMs: null });
		expect(n.weeklyAll).toEqual({ utilization: 40, resetMs: null });
	});
});

describe("normalizeAnthropicUsage — limits[]-only payloads (no flat keys)", () => {
	it("reads session/weeklyAll/weeklyScoped from limits[]", () => {
		const data: AnthropicUsageData = {
			limits: [
				entry({ kind: "session", group: "session", percent: 15 }),
				entry({ kind: "weekly_all", group: "weekly", percent: 42 }),
				scoped("Fable", { percent: 100 }),
			],
		};
		const n = normalizeAnthropicUsage(data, NOW);
		expect(n.session).toEqual({ utilization: 15, resetMs: FUTURE_MS });
		expect(n.weeklyAll).toEqual({ utilization: 42, resetMs: FUTURE_MS });
		expect(n.weeklyScoped).toEqual([
			{
				family: "fable",
				percent: 100,
				resetsAtMs: FUTURE_MS,
				isActive: true,
				displayName: "Fable",
			},
		]);
	});

	it("returns ALL present scoped families regardless of percent (no threshold)", () => {
		const data: AnthropicUsageData = {
			limits: [
				scoped("Opus", { percent: 100 }),
				scoped("Sonnet", { percent: 5 }),
			],
		};
		const n = normalizeAnthropicUsage(data, NOW);
		expect(n.weeklyScoped.map((s) => s.family).sort()).toEqual([
			"opus",
			"sonnet",
		]);
	});

	it("drops scoped entries that are non-numeric, unresolvable, or stale (past/absent reset)", () => {
		const data: AnthropicUsageData = {
			limits: [
				scoped("Fable", { percent: null }), // non-numeric
				scoped("Fable", { percent: Number.NaN }), // non-finite
				scoped("Nonsense"), // unresolvable family
				scoped("Fable", { resets_at: PAST_ISO }), // stale reset
				scoped("Fable", { resets_at: null }), // no reset
			],
		};
		expect(normalizeAnthropicUsage(data, NOW).weeklyScoped).toEqual([]);
	});
});

describe("normalizeAnthropicUsage — mixed & precedence", () => {
	it("prefers flat five_hour/seven_day over limits session/weekly_all", () => {
		const data: AnthropicUsageData = {
			five_hour: { utilization: 20, resets_at: FUTURE_ISO },
			seven_day: { utilization: 40, resets_at: FUTURE_ISO },
			limits: [
				entry({ kind: "session", percent: 99 }),
				entry({ kind: "weekly_all", group: "weekly", percent: 99 }),
				scoped("Opus", { percent: 100 }),
			],
		};
		const n = normalizeAnthropicUsage(data, NOW);
		expect(n.session?.utilization).toBe(20);
		expect(n.weeklyAll?.utilization).toBe(40);
		expect(n.weeklyScoped.map((s) => s.family)).toEqual(["opus"]);
	});

	it("falls back to limits session when flat five_hour has null utilization", () => {
		const data: AnthropicUsageData = {
			five_hour: { utilization: null, resets_at: FUTURE_ISO },
			limits: [entry({ kind: "session", percent: 7 })],
		};
		expect(normalizeAnthropicUsage(data, NOW).session).toEqual({
			utilization: 7,
			resetMs: FUTURE_MS,
		});
	});
});

describe("normalizeAnthropicUsage — empty / absent", () => {
	it("returns all null + [] for null, undefined, and empty object", () => {
		for (const d of [null, undefined, {} as AnthropicUsageData]) {
			const n = normalizeAnthropicUsage(d, NOW);
			expect(n.session).toBeNull();
			expect(n.weeklyAll).toBeNull();
			expect(n.weeklyScoped).toEqual([]);
		}
	});

	it("returns all null + [] for a non-Anthropic (zai) shape", () => {
		const zai = {
			tokens_limit: { percentage: 50, resetAt: null },
			time_limit: null,
		} as unknown as AnthropicUsageData;
		const n = normalizeAnthropicUsage(zai, NOW);
		expect(n.session).toBeNull();
		expect(n.weeklyAll).toBeNull();
		expect(n.weeklyScoped).toEqual([]);
	});
});

describe("getRepresentativeUtilization helper", () => {
	it("returns null when there is no account-level evidence (never 0)", () => {
		expect(
			getRepresentativeUtilization(normalizeAnthropicUsage({}, NOW)),
		).toBeNull();
		expect(
			getRepresentativeUtilization(normalizeAnthropicUsage(null, NOW)),
		).toBeNull();
	});

	it("returns the max of session and weeklyAll when present", () => {
		const data: AnthropicUsageData = {
			five_hour: { utilization: 30, resets_at: null },
			seven_day: { utilization: 80, resets_at: null },
		};
		expect(
			getRepresentativeUtilization(normalizeAnthropicUsage(data, NOW)),
		).toBe(80);
	});

	it("returns 100 for a limits-only account at 100% weekly (fix for false cooldown clear)", () => {
		const data: AnthropicUsageData = {
			limits: [entry({ kind: "weekly_all", group: "weekly", percent: 100 })],
		};
		expect(
			getRepresentativeUtilization(normalizeAnthropicUsage(data, NOW)),
		).toBe(100);
	});

	it("does NOT fold weeklyScoped into account-wide utilization", () => {
		const data: AnthropicUsageData = {
			five_hour: { utilization: 10, resets_at: null },
			seven_day: { utilization: 20, resets_at: null },
			limits: [scoped("Fable", { percent: 100 })],
		};
		// Only session(10) + weeklyAll(20) count; the 100% scoped family is ignored.
		expect(
			getRepresentativeUtilization(normalizeAnthropicUsage(data, NOW)),
		).toBe(20);
	});
});

describe("isAnthropicUsageShape", () => {
	it("is true for a flat five_hour or seven_day payload", () => {
		expect(
			isAnthropicUsageShape({ five_hour: { utilization: 0, resets_at: null } }),
		).toBe(true);
		expect(
			isAnthropicUsageShape({ seven_day: { utilization: 0, resets_at: null } }),
		).toBe(true);
	});

	it("is true for a non-empty limits[]-only payload", () => {
		expect(isAnthropicUsageShape({ limits: [entry()] })).toBe(true);
	});

	it("is false for empty limits[], null, undefined, and non-Anthropic shapes", () => {
		expect(isAnthropicUsageShape({ limits: [] })).toBe(false);
		expect(isAnthropicUsageShape(null)).toBe(false);
		expect(isAnthropicUsageShape(undefined)).toBe(false);
		expect(
			isAnthropicUsageShape({
				tokens_limit: { percentage: 0, resetAt: null },
			} as unknown as AnthropicUsageData),
		).toBe(false);
	});
});
