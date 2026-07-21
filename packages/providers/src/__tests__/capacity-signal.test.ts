import { describe, expect, it } from "bun:test";
import type { AnyUsageData, UsageData } from "../usage-fetcher";
import { getAccountCapacitySignal, getFreshCapacity } from "../usage-fetcher";

// Fixed reference time so assertions don't depend on wall-clock time.
const NOW = 1_700_000_000_000;
const iso = (deltaMs: number) => new Date(NOW + deltaMs).toISOString();

describe("getAccountCapacitySignal", () => {
	it("computes headroom, soonest reset, and binding utilization for anthropic", () => {
		const data: UsageData = {
			five_hour: { utilization: 20, resets_at: iso(3_600_000) },
			seven_day: { utilization: 40, resets_at: iso(600_000_000) },
		};
		const signal = getAccountCapacitySignal(data, "anthropic", NOW);
		expect(signal).not.toBeNull();
		expect(signal?.minHeadroom).toBe(60);
		expect(signal?.soonestResetMs).toBe(NOW + 3_600_000);
		expect(signal?.bindingUtilization).toBe(40);
		// Weekly fields are driven by the seven_day window, not the sooner 5h.
		expect(signal?.weeklyResetMs).toBe(NOW + 600_000_000);
		expect(signal?.weeklyHeadroom).toBe(60);
	});

	it("picks the soonest reset and the min headroom across windows", () => {
		// five_hour resets sooner and has higher utilization (lower headroom).
		const data: UsageData = {
			five_hour: { utilization: 70, resets_at: iso(3_600_000) },
			seven_day: { utilization: 30, resets_at: iso(600_000_000) },
		};
		const signal = getAccountCapacitySignal(data, "anthropic", NOW);
		expect(signal?.minHeadroom).toBe(30); // 100 - 70 from the higher-util window
		expect(signal?.soonestResetMs).toBe(NOW + 3_600_000); // 5h sooner than 7d
		expect(signal?.bindingUtilization).toBe(70);
		// A SOONER five_hour reset does NOT change the weekly deadline.
		expect(signal?.weeklyResetMs).toBe(NOW + 600_000_000);
		expect(signal?.weeklyHeadroom).toBe(70); // 100 - 30 (seven_day util)
	});

	it("returns null when a present hard window is already past its reset (content-stale)", () => {
		const data: UsageData = {
			five_hour: { utilization: 20, resets_at: iso(-1) }, // already past
			seven_day: { utilization: 40, resets_at: iso(600_000_000) },
		};
		expect(getAccountCapacitySignal(data, "anthropic", NOW)).toBeNull();
	});

	it("returns null for null data and for unsupported providers", () => {
		expect(getAccountCapacitySignal(null, "anthropic", NOW)).toBeNull();
		const data: UsageData = {
			five_hour: { utilization: 20, resets_at: iso(3_600_000) },
			seven_day: { utilization: 40, resets_at: iso(600_000_000) },
		};
		expect(
			getAccountCapacitySignal(data as AnyUsageData, "zai", NOW),
		).toBeNull();
		expect(
			getAccountCapacitySignal(data as AnyUsageData, "kilo", NOW),
		).toBeNull();
		expect(
			getAccountCapacitySignal(
				data as AnyUsageData,
				"anthropic-compatible",
				NOW,
			),
		).toBeNull();
	});

	it("treats windows without resets_at as deadline-less; null soonestReset if none have one", () => {
		const data: UsageData = {
			five_hour: { utilization: 20, resets_at: null },
			seven_day: { utilization: 40, resets_at: null },
		};
		const signal = getAccountCapacitySignal(data, "anthropic", NOW);
		expect(signal).not.toBeNull();
		expect(signal?.minHeadroom).toBe(60);
		expect(signal?.soonestResetMs).toBeNull();
		expect(signal?.bindingUtilization).toBe(40);
		// seven_day present but no resets_at → weekly headroom set, weekly reset null.
		expect(signal?.weeklyResetMs).toBeNull();
		expect(signal?.weeklyHeadroom).toBe(60);
	});

	it("lets extra_usage raise bindingUtilization without affecting headroom or reset", () => {
		const data: UsageData = {
			five_hour: { utilization: 20, resets_at: iso(3_600_000) },
			seven_day: { utilization: 40, resets_at: iso(600_000_000) },
			extra_usage: {
				is_enabled: true,
				monthly_limit: 100,
				used_credits: 90,
				utilization: 90,
			},
		};
		const signal = getAccountCapacitySignal(data, "anthropic", NOW);
		expect(signal?.minHeadroom).toBe(60); // unchanged by extra_usage
		expect(signal?.soonestResetMs).toBe(NOW + 3_600_000); // unchanged
		expect(signal?.bindingUtilization).toBe(90); // raised by extra_usage
		// extra_usage is not a weekly window — weekly fields unaffected.
		expect(signal?.weeklyResetMs).toBe(NOW + 600_000_000);
		expect(signal?.weeklyHeadroom).toBe(60);
	});

	it("produces a signal for codex with the windowed UsageData shape", () => {
		const data: UsageData = {
			five_hour: { utilization: 50, resets_at: iso(3_600_000) },
			seven_day: { utilization: 10, resets_at: iso(600_000_000) },
		};
		const signal = getAccountCapacitySignal(data, "codex", NOW);
		expect(signal).not.toBeNull();
		expect(signal?.minHeadroom).toBe(50);
		expect(signal?.bindingUtilization).toBe(50);
		expect(signal?.soonestResetMs).toBe(NOW + 3_600_000);
		// Codex shares the windowed shape → weekly fields computed identically.
		expect(signal?.weeklyResetMs).toBe(NOW + 600_000_000);
		expect(signal?.weeklyHeadroom).toBe(90); // 100 - 10 (seven_day util)
	});

	it("returns null when no hard windows are present", () => {
		const data = {} as UsageData;
		expect(getAccountCapacitySignal(data, "anthropic", NOW)).toBeNull();
	});

	it("takes the min reset and min headroom across both weekly windows", () => {
		// seven_day_oauth_apps resets sooner and is more utilized (less headroom)
		// than seven_day → it drives both weekly fields.
		const data: UsageData = {
			five_hour: { utilization: 10, resets_at: iso(3_600_000) },
			seven_day: { utilization: 30, resets_at: iso(600_000_000) },
			seven_day_oauth_apps: { utilization: 55, resets_at: iso(400_000_000) },
		};
		const signal = getAccountCapacitySignal(data, "anthropic", NOW);
		expect(signal).not.toBeNull();
		expect(signal?.weeklyResetMs).toBe(NOW + 400_000_000); // min weekly reset
		expect(signal?.weeklyHeadroom).toBe(45); // min(70, 45) = 100 - 55
		// The MOST-CONSTRAINED weekly window is oauth_apps (util 55); its reset also
		// happens to be the earliest here, so binding == earliest.
		expect(signal?.bindingWeeklyResetMs).toBe(NOW + 400_000_000);
	});

	it("bindingWeeklyResetMs tracks the most-constrained window, not the earliest reset", () => {
		// The MORE-constrained weekly window (oauth_apps, util 60) resets LATER than
		// the healthier seven_day window (util 30). weeklyResetMs (FEFO) must be the
		// EARLIEST reset, but bindingWeeklyResetMs must follow the binding (util 60)
		// window — the reservation gate's harvest-yield tracks the constrained one.
		const data: UsageData = {
			five_hour: { utilization: 10, resets_at: iso(3_600_000) },
			seven_day: { utilization: 30, resets_at: iso(400_000_000) }, // healthier, sooner reset
			seven_day_oauth_apps: { utilization: 60, resets_at: iso(600_000_000) }, // binding, later reset
		};
		const signal = getAccountCapacitySignal(data, "anthropic", NOW);
		expect(signal).not.toBeNull();
		expect(signal?.weeklyHeadroom).toBe(40); // 100 - 60 (the binding window)
		expect(signal?.weeklyResetMs).toBe(NOW + 400_000_000); // EARLIEST across weekly
		expect(signal?.bindingWeeklyResetMs).toBe(NOW + 600_000_000); // the BINDING window
	});

	it("bindingWeeklyResetMs is null when the binding weekly window has no reset", () => {
		const data: UsageData = {
			five_hour: { utilization: 20, resets_at: iso(3_600_000) },
			seven_day: { utilization: 40, resets_at: null }, // only weekly window, no reset
		};
		const signal = getAccountCapacitySignal(data, "anthropic", NOW);
		expect(signal).not.toBeNull();
		expect(signal?.weeklyResetMs).toBeNull();
		expect(signal?.bindingWeeklyResetMs).toBeNull();
	});

	it("bindingWeeklyResetMs keeps the FARTHEST reset among windows tied at max util", () => {
		// Two weekly windows tied at the SAME (max) utilization but different resets:
		// the constraint persists until the LATER reset, so the binding reset must be
		// the farther one (5d), not the sooner (1h).
		const data: UsageData = {
			five_hour: { utilization: 10, resets_at: iso(3_600_000) },
			seven_day: { utilization: 60, resets_at: iso(3_600_000) }, // tied util, 1h reset
			seven_day_oauth_apps: {
				utilization: 60,
				resets_at: iso(5 * 86_400_000),
			}, // tied util, 5d reset
		};
		const signal = getAccountCapacitySignal(data, "anthropic", NOW);
		expect(signal).not.toBeNull();
		expect(signal?.weeklyHeadroom).toBe(40); // 100 - 60
		expect(signal?.weeklyResetMs).toBe(NOW + 3_600_000); // FEFO: earliest reset
		expect(signal?.bindingWeeklyResetMs).toBe(NOW + 5 * 86_400_000); // farthest of the tied
	});

	it("bindingWeeklyResetMs is null when any window tied at max util has an unknown reset", () => {
		// Two weekly windows tied at max util; one has a known reset, the other has
		// none → the binding reset is ambiguous, so it must be null (fail open).
		const data: UsageData = {
			five_hour: { utilization: 10, resets_at: iso(3_600_000) },
			seven_day: { utilization: 60, resets_at: null }, // tied util, unknown reset
			seven_day_oauth_apps: {
				utilization: 60,
				resets_at: iso(5 * 86_400_000),
			}, // tied util, known reset
		};
		const signal = getAccountCapacitySignal(data, "anthropic", NOW);
		expect(signal).not.toBeNull();
		expect(signal?.weeklyHeadroom).toBe(40); // 100 - 60
		expect(signal?.bindingWeeklyResetMs).toBeNull();
	});

	it("ignores a sooner five_hour reset when computing the weekly deadline", () => {
		const data: UsageData = {
			// five_hour resets in 1h — much sooner than the weekly window.
			five_hour: { utilization: 5, resets_at: iso(3_600_000) },
			seven_day: { utilization: 60, resets_at: iso(9 * 3_600_000) },
		};
		const signal = getAccountCapacitySignal(data, "anthropic", NOW);
		expect(signal?.soonestResetMs).toBe(NOW + 3_600_000); // 5h drives soonest
		expect(signal?.weeklyResetMs).toBe(NOW + 9 * 3_600_000); // weekly unaffected
		expect(signal?.weeklyHeadroom).toBe(40);
	});

	it("reports no weekly deadline and full weekly headroom when only five_hour is present", () => {
		const data: UsageData = {
			five_hour: { utilization: 20, resets_at: iso(3_600_000) },
		};
		const signal = getAccountCapacitySignal(data, "anthropic", NOW);
		expect(signal).not.toBeNull();
		expect(signal?.minHeadroom).toBe(80);
		expect(signal?.soonestResetMs).toBe(NOW + 3_600_000);
		// No weekly window → null deadline, 100 headroom (the default).
		expect(signal?.weeklyResetMs).toBeNull();
		expect(signal?.weeklyHeadroom).toBe(100);
	});

	// --- limits[]-only payloads (upstream is dropping the flat keys) ---

	it("derives a capacity signal from a limits[]-only payload (no flat windows)", () => {
		const data = {
			limits: [
				{
					kind: "session",
					group: "session",
					percent: 20,
					resets_at: iso(3_600_000),
					scope: null,
					is_active: true,
				},
				{
					kind: "weekly_all",
					group: "weekly",
					percent: 40,
					resets_at: iso(600_000_000),
					scope: null,
					is_active: true,
				},
			],
		} as unknown as UsageData;
		const signal = getAccountCapacitySignal(data, "anthropic", NOW);
		expect(signal).not.toBeNull();
		// Same numbers the equivalent flat payload produces (see first test).
		expect(signal?.minHeadroom).toBe(60);
		expect(signal?.soonestResetMs).toBe(NOW + 3_600_000);
		expect(signal?.bindingUtilization).toBe(40);
		expect(signal?.weeklyResetMs).toBe(NOW + 600_000_000);
		expect(signal?.weeklyHeadroom).toBe(60);
	});

	it("returns null for a content-stale limits[]-only session window (past reset)", () => {
		const data = {
			limits: [
				{
					kind: "session",
					group: "session",
					percent: 20,
					resets_at: iso(-1), // already past
					scope: null,
					is_active: true,
				},
			],
		} as unknown as UsageData;
		expect(getAccountCapacitySignal(data, "anthropic", NOW)).toBeNull();
	});

	it("returns null for an empty limits[] array (no evidence, never 0)", () => {
		const data = { limits: [] } as unknown as UsageData;
		expect(getAccountCapacitySignal(data, "anthropic", NOW)).toBeNull();
	});

	it("does NOT let a small flat oauth_apps window mask an exhausted limits[] session (mixed payload)", () => {
		// A flat seven_day_oauth_apps window exists (20%), but the REAL session is
		// spent (limits[] session 100%). The all-or-nothing fallback used to ignore
		// limits[] whenever any flat window was present → ranked ~20% healthy.
		const data = {
			seven_day_oauth_apps: { utilization: 20, resets_at: iso(400_000_000) },
			limits: [
				{
					kind: "session",
					group: "session",
					percent: 100,
					resets_at: iso(3_600_000),
					scope: null,
					is_active: true,
				},
				{
					kind: "weekly_all",
					group: "weekly",
					percent: 40,
					resets_at: iso(600_000_000),
					scope: null,
					is_active: true,
				},
			],
		} as unknown as UsageData;
		const signal = getAccountCapacitySignal(data, "anthropic", NOW);
		expect(signal).not.toBeNull();
		// session 100 → NEAR_LIMIT (no headroom), binding 100.
		expect(signal?.minHeadroom).toBe(0);
		expect(signal?.bindingUtilization).toBe(100);
		// weekly fields fold in weekly_all(40) and the flat oauth_apps(20).
		expect(signal?.weeklyHeadroom).toBe(60); // min(100-40, 100-20)
	});

	it("reports sessionHeadroom from the 5h session window (90% util → 10)", () => {
		const data: UsageData = {
			five_hour: { utilization: 90, resets_at: iso(3_600_000) },
			seven_day: { utilization: 10, resets_at: iso(600_000_000) },
		};
		const signal = getAccountCapacitySignal(data, "anthropic", NOW);
		expect(signal).not.toBeNull();
		// sessionHeadroom tracks the 5h window ALONE (100 - 90), not the min across
		// windows — the weekly window here is far healthier (headroom 90).
		expect(signal?.sessionHeadroom).toBe(10);
		expect(signal?.weeklyHeadroom).toBe(90);
	});

	it("reports sessionHeadroom 100 when no session window is present (weekly only)", () => {
		const data: UsageData = {
			// No five_hour / limits[] session window — only a weekly window.
			seven_day: { utilization: 40, resets_at: iso(600_000_000) },
		};
		const signal = getAccountCapacitySignal(data, "anthropic", NOW);
		expect(signal).not.toBeNull();
		expect(signal?.sessionHeadroom).toBe(100);
	});
});

describe("getFreshCapacity", () => {
	const makeCache = (
		age: number | null,
		data: AnyUsageData | null,
	): {
		get: (id: string) => AnyUsageData | null;
		getAge: (id: string) => number | null;
	} => ({
		get: () => data,
		getAge: () => age,
	});

	const freshData: UsageData = {
		five_hour: { utilization: 20, resets_at: iso(3_600_000) },
		seven_day: { utilization: 40, resets_at: iso(600_000_000) },
	};

	it("returns null when getAge is null (no cached datum)", () => {
		const cache = makeCache(null, freshData);
		expect(
			getFreshCapacity(cache, "acct", "anthropic", NOW, 60_000),
		).toBeNull();
	});

	it("returns null when the cached datum is older than maxAgeMs", () => {
		const cache = makeCache(120_000, freshData); // 120s old
		expect(
			getFreshCapacity(cache, "acct", "anthropic", NOW, 60_000),
		).toBeNull();
	});

	it("returns the capacity signal when the cached datum is fresh", () => {
		const cache = makeCache(30_000, freshData); // 30s old, within 60s budget
		const signal = getFreshCapacity(cache, "acct", "anthropic", NOW, 60_000);
		expect(signal).not.toBeNull();
		expect(signal?.minHeadroom).toBe(60);
		expect(signal?.soonestResetMs).toBe(NOW + 3_600_000);
		expect(signal?.bindingUtilization).toBe(40);
		expect(signal?.weeklyResetMs).toBe(NOW + 600_000_000);
		expect(signal?.weeklyHeadroom).toBe(60);
	});
});
