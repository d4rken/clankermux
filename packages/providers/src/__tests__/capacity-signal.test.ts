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
	});

	it("returns null when no hard windows are present", () => {
		const data = {} as UsageData;
		expect(getAccountCapacitySignal(data, "anthropic", NOW)).toBeNull();
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
	});
});
