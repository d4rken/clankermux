import { describe, expect, it } from "bun:test";
import type { UsageData } from "../usage-fetcher";
import {
	getRepresentativeUtilization,
	getRepresentativeUtilizationForProvider,
	getRepresentativeWindow,
} from "../usage-fetcher";

/**
 * The capacity-restored path clears an account's `rate_limited_until` when
 * `getRepresentativeUtilization(...) !== null && utilization < 100`. The old
 * reader returned 0 (not null) for a payload with no readable flat windows, so a
 * `limits[]`-only account FALSELY cleared its cooldown. These tests lock the
 * `null`-not-`0` contract that fixes it.
 */
describe("getRepresentativeUtilization — null-not-0 contract (false-clear fix)", () => {
	it("returns null (never 0) for a payload with no account-level evidence", () => {
		expect(getRepresentativeUtilization({} as UsageData)).toBeNull();
		expect(getRepresentativeUtilization(null)).toBeNull();
		// A limits[]-only payload with only scoped (per-family) windows is NOT
		// account-level evidence → null (won't clear the cooldown).
		const scopedOnly = {
			limits: [
				{
					kind: "weekly_scoped",
					group: "weekly",
					percent: 100,
					resets_at: new Date(Date.now() + 3_600_000).toISOString(),
					scope: { model: { id: "claude-fable-5", display_name: "Fable" } },
					is_active: true,
				},
			],
		} as unknown as UsageData;
		expect(getRepresentativeUtilization(scopedOnly)).toBeNull();
	});

	it("returns 100 for a limits[]-only account at 100% weekly (cooldown must NOT clear)", () => {
		const data = {
			limits: [
				{
					kind: "weekly_all",
					group: "weekly",
					percent: 100,
					resets_at: new Date(Date.now() + 3_600_000).toISOString(),
					scope: null,
					is_active: true,
				},
			],
		} as unknown as UsageData;
		const util = getRepresentativeUtilization(data);
		expect(util).toBe(100);
		// The clear condition `util !== null && util < 100` is false → holds.
		expect(util !== null && util < 100).toBe(false);
	});

	it("reads flat five_hour/seven_day as the account-wide max", () => {
		const data: UsageData = {
			five_hour: { utilization: 30, resets_at: null },
			seven_day: { utilization: 70, resets_at: null },
		};
		expect(getRepresentativeUtilization(data)).toBe(70);
	});

	it("folds in seven_day_oauth_apps (Claude Code weekly quota is the binding window)", () => {
		// five_hour/seven_day both below 100 but the OAuth-apps weekly window is
		// spent → representative MUST be 100 so the cooldown-clear guard
		// (util < 100 && wasRateLimited) does NOT fire.
		const data: UsageData = {
			five_hour: { utilization: 40, resets_at: null },
			seven_day: { utilization: 50, resets_at: null },
			seven_day_oauth_apps: { utilization: 100, resets_at: null },
		};
		const util = getRepresentativeUtilization(data);
		expect(util).toBe(100);
		expect(util !== null && util < 100).toBe(false);
	});

	it("still excludes weekly_scoped and extra_usage from the account-wide max", () => {
		const data = {
			five_hour: { utilization: 10, resets_at: null },
			seven_day: { utilization: 20, resets_at: null },
			extra_usage: {
				is_enabled: true,
				monthly_limit: 100,
				used_credits: 90,
				utilization: 90,
			},
			limits: [
				{
					kind: "weekly_scoped",
					group: "weekly",
					percent: 100,
					resets_at: new Date(Date.now() + 3_600_000).toISOString(),
					scope: { model: { id: "claude-fable-5", display_name: "Fable" } },
					is_active: true,
				},
			],
		} as unknown as UsageData;
		// Only session(10) + weeklyAll(20) + oauth_apps(absent) count → 20.
		expect(getRepresentativeUtilization(data)).toBe(20);
	});

	it("returns a real sub-100 utilization when genuine headroom exists (clear allowed)", () => {
		const data = {
			limits: [
				{
					kind: "session",
					group: "session",
					percent: 42,
					resets_at: null,
					scope: null,
					is_active: true,
				},
			],
		} as unknown as UsageData;
		const util = getRepresentativeUtilization(data);
		expect(util).toBe(42);
		expect(util !== null && util < 100).toBe(true);
	});
});

describe("getRepresentativeUtilizationForProvider — limits[]-only", () => {
	it("falls back to the normalizer for a limits[]-only anthropic payload", () => {
		const data = {
			limits: [
				{
					kind: "weekly_all",
					group: "weekly",
					percent: 88,
					resets_at: null,
					scope: null,
					is_active: true,
				},
			],
		} as unknown as UsageData;
		expect(getRepresentativeUtilizationForProvider(data, "anthropic")).toBe(88);
	});

	it("preserves flat behavior including seven_day_oauth_apps (max across flat windows)", () => {
		const data: UsageData = {
			five_hour: { utilization: 10, resets_at: null },
			seven_day: { utilization: 20, resets_at: null },
			seven_day_oauth_apps: { utilization: 77, resets_at: null },
		};
		expect(getRepresentativeUtilizationForProvider(data, "anthropic")).toBe(77);
	});

	it("returns null when there is no evidence at all", () => {
		expect(
			getRepresentativeUtilizationForProvider({} as UsageData, "anthropic"),
		).toBeNull();
	});

	it("does NOT let a small flat window mask an exhausted limits[] session (mixed payload)", () => {
		// oauth_apps 20% flat + limits[] session 100% → representative MUST be 100,
		// not 20 (the old all-or-nothing fallback ignored limits[] here).
		const data = {
			seven_day_oauth_apps: { utilization: 20, resets_at: null },
			limits: [
				{
					kind: "session",
					group: "session",
					percent: 100,
					resets_at: null,
					scope: null,
					is_active: true,
				},
				{
					kind: "weekly_all",
					group: "weekly",
					percent: 40,
					resets_at: null,
					scope: null,
					is_active: true,
				},
			],
		} as unknown as UsageData;
		expect(getRepresentativeUtilizationForProvider(data, "anthropic")).toBe(
			100,
		);
	});
});

describe("getRepresentativeWindow — limits[]-only", () => {
	it("names the binding window (seven_day) for a limits[]-only payload", () => {
		const data = {
			limits: [
				{
					kind: "session",
					group: "session",
					percent: 40,
					resets_at: null,
					scope: null,
					is_active: true,
				},
				{
					kind: "weekly_all",
					group: "weekly",
					percent: 60,
					resets_at: null,
					scope: null,
					is_active: true,
				},
			],
		} as unknown as UsageData;
		expect(getRepresentativeWindow(data)).toBe("seven_day");
	});

	it("preserves flat behavior (returns the highest flat window name)", () => {
		const data: UsageData = {
			five_hour: { utilization: 10, resets_at: null },
			seven_day: { utilization: 20, resets_at: null },
			seven_day_oauth_apps: { utilization: 77, resets_at: null },
		};
		expect(getRepresentativeWindow(data)).toBe("seven_day_oauth_apps");
	});

	it("returns null when there is no evidence", () => {
		expect(getRepresentativeWindow({} as UsageData)).toBeNull();
	});
});
