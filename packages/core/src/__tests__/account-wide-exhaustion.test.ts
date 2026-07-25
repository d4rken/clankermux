import { describe, expect, it } from "bun:test";
import type { AnthropicUsageData } from "@clankermux/types";
import { accountWideExhaustion, weeklyExhaustion } from "../weekly-exhaustion";

const NOW = Date.UTC(2026, 6, 25, 12, 0, 0);
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * `accountWideExhaustion` widens `weeklyExhaustion` to EVERY window that
 * sidelines the whole account (the 5h session as well as the two weekly forms).
 * Weekly outranks session WHOLESALE — the binding reset must be the one
 * `weeklyExhaustion` reports, never a max across classes.
 */
describe("accountWideExhaustion", () => {
	it("classifies a session-only exhaustion as binding: session", () => {
		const usage = {
			five_hour: { utilization: 100, resets_at: iso(NOW + 30 * MIN) },
			seven_day: { utilization: 40, resets_at: iso(NOW + 3 * 24 * 60 * MIN) },
		} as AnthropicUsageData;
		expect(accountWideExhaustion(usage, NOW)).toEqual({
			exhausted: true,
			binding: "session",
			resetMs: NOW + 30 * MIN,
		});
	});

	it("classifies a weekly-only exhaustion as binding: weekly", () => {
		const usage = {
			five_hour: { utilization: 12, resets_at: iso(NOW + 30 * MIN) },
			seven_day: { utilization: 100, resets_at: iso(NOW + 2 * 24 * 60 * MIN) },
		} as AnthropicUsageData;
		expect(accountWideExhaustion(usage, NOW)).toEqual({
			exhausted: true,
			binding: "weekly",
			resetMs: NOW + 2 * 24 * 60 * MIN,
		});
	});

	it("prefers weekly WHOLESALE when both are spent — even when the session resets LATER", () => {
		// The session window resets after the weekly one. A "latest reset across
		// all spent windows" rule would return the session reset while reporting
		// binding: "weekly" — a session-derived deadline under a weekly label.
		const usage = {
			five_hour: { utilization: 100, resets_at: iso(NOW + 5 * 24 * 60 * MIN) },
			seven_day: { utilization: 100, resets_at: iso(NOW + 2 * 24 * 60 * MIN) },
		} as AnthropicUsageData;
		const result = accountWideExhaustion(usage, NOW);
		expect(result.binding).toBe("weekly");
		expect(result.resetMs).toBe(weeklyExhaustion(usage, NOW).resetMs);
		expect(result.resetMs).toBe(NOW + 2 * 24 * 60 * MIN);
	});

	it("lets the session bind when weekly is 100% with a MISSING reset", () => {
		const usage = {
			five_hour: { utilization: 100, resets_at: iso(NOW + 45 * MIN) },
			seven_day: { utilization: 100, resets_at: null },
		} as unknown as AnthropicUsageData;
		expect(accountWideExhaustion(usage, NOW)).toEqual({
			exhausted: true,
			binding: "session",
			resetMs: NOW + 45 * MIN,
		});
	});

	it("lets the session bind when weekly is 100% with a PAST reset", () => {
		const usage = {
			five_hour: { utilization: 100, resets_at: iso(NOW + 45 * MIN) },
			seven_day: { utilization: 100, resets_at: iso(NOW - MIN) },
		} as AnthropicUsageData;
		expect(accountWideExhaustion(usage, NOW)).toEqual({
			exhausted: true,
			binding: "session",
			resetMs: NOW + 45 * MIN,
		});
	});

	it("counts the flat seven_day_oauth_apps window (weekly class)", () => {
		const usage = {
			five_hour: { utilization: 10, resets_at: iso(NOW + 30 * MIN) },
			seven_day_oauth_apps: {
				utilization: 100,
				resets_at: iso(NOW + 4 * 60 * MIN),
			},
		} as AnthropicUsageData;
		expect(accountWideExhaustion(usage, NOW)).toEqual({
			exhausted: true,
			binding: "weekly",
			resetMs: NOW + 4 * 60 * MIN,
		});
	});

	it("ignores family-scoped weekly windows (a spent family is not the account)", () => {
		const usage = {
			limits: [
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: iso(NOW + 24 * 60 * MIN),
					scope: { model: { display_name: "Claude Opus 4.8" } },
				},
			],
		} as unknown as AnthropicUsageData;
		expect(accountWideExhaustion(usage, NOW)).toEqual({
			exhausted: false,
			binding: null,
			resetMs: null,
		});
	});

	it("ignores extra_usage (overage is the out_of_credits floor's business)", () => {
		const usage = {
			five_hour: { utilization: 20, resets_at: iso(NOW + 30 * MIN) },
			extra_usage: { utilization: 100, resets_at: iso(NOW + 24 * 60 * MIN) },
		} as unknown as AnthropicUsageData;
		expect(accountWideExhaustion(usage, NOW).exhausted).toBe(false);
	});

	it("treats >= 100 as spent and 99.9 as not spent", () => {
		const at = (utilization: number) =>
			accountWideExhaustion(
				{
					five_hour: { utilization, resets_at: iso(NOW + 30 * MIN) },
				} as AnthropicUsageData,
				NOW,
			);
		expect(at(100).exhausted).toBe(true);
		expect(at(140).exhausted).toBe(true);
		expect(at(99.9).exhausted).toBe(false);
	});

	it("fails open on non-finite utilization", () => {
		for (const utilization of [Number.NaN, Number.POSITIVE_INFINITY]) {
			const usage = {
				five_hour: { utilization, resets_at: iso(NOW + 30 * MIN) },
			} as AnthropicUsageData;
			expect(accountWideExhaustion(usage, NOW).exhausted).toBe(false);
		}
	});

	it("is not exhausted when the session reset is absent or already past", () => {
		const missing = {
			five_hour: { utilization: 100, resets_at: null },
		} as unknown as AnthropicUsageData;
		const past = {
			five_hour: { utilization: 100, resets_at: iso(NOW - 1) },
		} as AnthropicUsageData;
		expect(accountWideExhaustion(missing, NOW).exhausted).toBe(false);
		expect(accountWideExhaustion(past, NOW).exhausted).toBe(false);
	});

	it("reads a limits[]-only session window", () => {
		const usage = {
			limits: [
				{
					kind: "session",
					percent: 100,
					resets_at: iso(NOW + 20 * MIN),
				},
			],
		} as unknown as AnthropicUsageData;
		expect(accountWideExhaustion(usage, NOW)).toEqual({
			exhausted: true,
			binding: "session",
			resetMs: NOW + 20 * MIN,
		});
	});

	it("pins the normalizer's flat-first precedence for the session window (both directions)", () => {
		// flat says spent, limits[] says healthy → flat wins → exhausted.
		const flatSpent = {
			five_hour: { utilization: 100, resets_at: iso(NOW + 20 * MIN) },
			limits: [{ kind: "session", percent: 5, resets_at: iso(NOW + 20 * MIN) }],
		} as unknown as AnthropicUsageData;
		expect(accountWideExhaustion(flatSpent, NOW)).toEqual({
			exhausted: true,
			binding: "session",
			resetMs: NOW + 20 * MIN,
		});

		// flat says healthy, limits[] says spent → flat still wins → NOT exhausted.
		const flatHealthy = {
			five_hour: { utilization: 5, resets_at: iso(NOW + 20 * MIN) },
			limits: [
				{ kind: "session", percent: 100, resets_at: iso(NOW + 20 * MIN) },
			],
		} as unknown as AnthropicUsageData;
		expect(accountWideExhaustion(flatHealthy, NOW).exhausted).toBe(false);
	});

	it("is not exhausted for absent / empty payloads", () => {
		expect(accountWideExhaustion(null, NOW)).toEqual({
			exhausted: false,
			binding: null,
			resetMs: null,
		});
		expect(accountWideExhaustion(undefined, NOW).exhausted).toBe(false);
		expect(
			accountWideExhaustion({} as AnthropicUsageData, NOW).exhausted,
		).toBe(false);
	});
});
