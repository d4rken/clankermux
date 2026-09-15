import { describe, expect, it } from "bun:test";
import type { AnthropicUsageData, ZaiUsageData } from "@clankermux/types";
import {
	flatOauthAppsWindow,
	weeklyExhaustion,
	zaiAccountWideExhaustion,
} from "../weekly-exhaustion";

const NOW = 1_750_000_000_000;
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe("weeklyExhaustion", () => {
	it("flags a spent flat seven_day window with a future reset", () => {
		const usage: AnthropicUsageData = {
			five_hour: { utilization: 10, resets_at: iso(NOW + 30 * MIN) },
			seven_day: { utilization: 100, resets_at: iso(NOW + 20 * MIN) },
		};
		expect(weeklyExhaustion(usage, NOW)).toEqual({
			exhausted: true,
			resetMs: NOW + 20 * MIN,
		});
	});

	it("flags a spent limits[] weekly_all window when no flat window exists", () => {
		const usage: AnthropicUsageData = {
			limits: [
				{
					kind: "weekly_all",
					group: "weekly",
					percent: 100,
					resets_at: iso(NOW + 45 * MIN),
					scope: null,
					is_active: true,
				},
			],
		};
		expect(weeklyExhaustion(usage, NOW)).toEqual({
			exhausted: true,
			resetMs: NOW + 45 * MIN,
		});
	});

	it("prefers the FLAT seven_day window over a disagreeing limits[] weekly_all", () => {
		// Pins `normalizeAnthropicUsage`'s precedence (usage-normalizer.ts): the
		// flat window wins outright, so a limits[] entry claiming 100% is ignored
		// while the flat window still reports headroom. weeklyExhaustion relies on
		// that ordering, so it is asserted here rather than assumed.
		const usage: AnthropicUsageData = {
			five_hour: { utilization: 10, resets_at: iso(NOW + 30 * MIN) },
			seven_day: { utilization: 40, resets_at: iso(NOW + 20 * MIN) },
			limits: [
				{
					kind: "weekly_all",
					group: "weekly",
					percent: 100,
					resets_at: iso(NOW + 45 * MIN),
					scope: null,
					is_active: true,
				},
			],
		};
		expect(weeklyExhaustion(usage, NOW)).toEqual({
			exhausted: false,
			resetMs: null,
		});
	});

	it("flags a spent seven_day_oauth_apps window even when seven_day has room", () => {
		const usage: AnthropicUsageData = {
			five_hour: { utilization: 10, resets_at: iso(NOW + 30 * MIN) },
			seven_day: { utilization: 50, resets_at: iso(NOW + 20 * MIN) },
			seven_day_oauth_apps: {
				utilization: 100,
				resets_at: iso(NOW + 15 * MIN),
			},
		};
		expect(weeklyExhaustion(usage, NOW)).toEqual({
			exhausted: true,
			resetMs: NOW + 15 * MIN,
		});
	});

	it("reports the LATEST reset when several windows are spent", () => {
		const usage: AnthropicUsageData = {
			five_hour: { utilization: 100, resets_at: iso(NOW + 5 * MIN) },
			seven_day: { utilization: 100, resets_at: iso(NOW + 20 * MIN) },
			seven_day_oauth_apps: {
				utilization: 100,
				resets_at: iso(NOW + 90 * MIN),
			},
		};
		expect(weeklyExhaustion(usage, NOW).resetMs).toBe(NOW + 90 * MIN);
	});

	it("accepts a far-future reset verbatim (no ceiling is applied here)", () => {
		const farFuture = NOW + 400 * 24 * 60 * MIN;
		const usage: AnthropicUsageData = {
			seven_day: { utilization: 100, resets_at: iso(farFuture) },
		};
		expect(weeklyExhaustion(usage, NOW)).toEqual({
			exhausted: true,
			resetMs: farFuture,
		});
	});

	it("does NOT flag a spent window whose reset already passed (stale evidence)", () => {
		const usage: AnthropicUsageData = {
			seven_day: { utilization: 100, resets_at: iso(NOW - MIN) },
		};
		expect(weeklyExhaustion(usage, NOW)).toEqual({
			exhausted: false,
			resetMs: null,
		});
	});

	it("does NOT flag a spent window with no reset at all (unknown)", () => {
		const usage: AnthropicUsageData = {
			seven_day: { utilization: 100, resets_at: null },
		};
		expect(weeklyExhaustion(usage, NOW)).toEqual({
			exhausted: false,
			resetMs: null,
		});
	});

	it("does not flag an account below 100%", () => {
		const usage: AnthropicUsageData = {
			seven_day: { utilization: 99.9, resets_at: iso(NOW + 20 * MIN) },
		};
		expect(weeklyExhaustion(usage, NOW).exhausted).toBe(false);
	});

	it("ignores family-scoped weekly windows (per-model, detail only)", () => {
		const usage: AnthropicUsageData = {
			five_hour: { utilization: 10, resets_at: iso(NOW + 30 * MIN) },
			seven_day: { utilization: 40, resets_at: iso(NOW + 20 * MIN) },
			limits: [
				{
					kind: "weekly_scoped",
					group: "weekly",
					percent: 100,
					resets_at: iso(NOW + 45 * MIN),
					scope: { model: { id: "claude-fable-5", display_name: "Fable" } },
					is_active: true,
				},
			],
		};
		expect(weeklyExhaustion(usage, NOW).exhausted).toBe(false);
	});

	it("treats null / undefined usage as not exhausted", () => {
		expect(weeklyExhaustion(null, NOW).exhausted).toBe(false);
		expect(weeklyExhaustion(undefined, NOW).exhausted).toBe(false);
	});
});

describe("flatOauthAppsWindow", () => {
	it("returns null when the window is absent or non-numeric", () => {
		expect(flatOauthAppsWindow(null)).toBeNull();
		expect(
			flatOauthAppsWindow({
				seven_day_oauth_apps: {
					utilization: null,
					resets_at: iso(NOW + MIN),
				},
			} as AnthropicUsageData),
		).toBeNull();
	});

	it("parses utilization and reset ms", () => {
		expect(
			flatOauthAppsWindow({
				seven_day_oauth_apps: { utilization: 73, resets_at: iso(NOW + MIN) },
			} as AnthropicUsageData),
		).toEqual({ utilization: 73, resetMs: NOW + MIN });
	});

	it("returns a null resetMs for an unparseable reset", () => {
		expect(
			flatOauthAppsWindow({
				seven_day_oauth_apps: { utilization: 73, resets_at: "not-a-date" },
			} as AnthropicUsageData),
		).toEqual({ utilization: 73, resetMs: null });
	});
});

/**
 * The Zai sibling answers the same question about the same two classes. Without
 * it a Zai account sitting at 100% keeps reporting `rateLimitStatus: "OK"`
 * until a real 429 writes a cooldown, and `/health` never counts it.
 */
describe("zaiAccountWideExhaustion", () => {
	const DAY = 24 * 60 * MIN;
	function zaiUsage(
		fiveHour: { pct: number; resetMs: number | null } | null,
		weekly: { pct: number; resetMs: number | null } | null,
	): ZaiUsageData {
		const window = (
			w: { pct: number; resetMs: number | null },
			type: string,
		) => ({
			used: w.pct,
			remaining: 100 - w.pct,
			percentage: w.pct,
			resetAt: w.resetMs,
			type,
		});
		return {
			time_limit: null,
			tokens_limit: fiveHour ? window(fiveHour, "tokens_limit") : null,
			tokens_limit_weekly: weekly
				? window(weekly, "tokens_limit_weekly")
				: null,
		};
	}

	it("binds weekly when the weekly window is spent with a future reset", () => {
		expect(
			zaiAccountWideExhaustion(
				zaiUsage(
					{ pct: 100, resetMs: NOW + 30 * MIN },
					{ pct: 100, resetMs: NOW + 3 * DAY },
				),
				NOW,
			),
		).toEqual({ exhausted: true, binding: "weekly", resetMs: NOW + 3 * DAY });
	});

	it("binds session when only the five-hour window is spent", () => {
		expect(
			zaiAccountWideExhaustion(
				zaiUsage(
					{ pct: 100, resetMs: NOW + 30 * MIN },
					{ pct: 20, resetMs: NOW + 3 * DAY },
				),
				NOW,
			),
		).toEqual({ exhausted: true, binding: "session", resetMs: NOW + 30 * MIN });
	});

	it("reports no exhaustion below 100%", () => {
		expect(
			zaiAccountWideExhaustion(
				zaiUsage(
					{ pct: 99, resetMs: NOW + 30 * MIN },
					{ pct: 99, resetMs: NOW + 3 * DAY },
				),
				NOW,
			),
		).toEqual({ exhausted: false, binding: null, resetMs: null });
	});

	it("treats an elapsed or absent reset as stale rather than as exhaustion", () => {
		// Ambiguous evidence must never sideline an account: a spent window whose
		// reset has already passed is a reading that predates a window roll.
		for (const resetMs of [NOW - MIN, null]) {
			expect(
				zaiAccountWideExhaustion(
					zaiUsage({ pct: 100, resetMs }, { pct: 100, resetMs }),
					NOW,
				),
			).toEqual({ exhausted: false, binding: null, resetMs: null });
		}
	});

	it("reads the fast-moving session window from the narrower view when given one", () => {
		// Same split `/api/accounts` uses: the weekly classes render from a
		// display horizon too generous to assert a five-hour window with.
		expect(
			zaiAccountWideExhaustion(
				zaiUsage({ pct: 100, resetMs: NOW + 30 * MIN }, null),
				NOW,
				zaiUsage({ pct: 10, resetMs: NOW + 30 * MIN }, null),
			),
		).toEqual({ exhausted: false, binding: null, resetMs: null });
	});

	it("reports nothing for an absent reading", () => {
		expect(zaiAccountWideExhaustion(null, NOW)).toEqual({
			exhausted: false,
			binding: null,
			resetMs: null,
		});
	});
});
