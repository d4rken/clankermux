import { describe, expect, it, mock } from "bun:test";
import type { AnyUsageData, UsageData } from "../usage-fetcher";
import { extractWindowResetTime, usageCache } from "../usage-fetcher";
import type { ZaiUsageData } from "../zai-usage-fetcher";

// ── extractWindowResetTime ────────────────────────────────────────────────────

describe("extractWindowResetTime", () => {
	it("returns tokens_limit.resetAt for zai provider", () => {
		const data: ZaiUsageData = {
			time_limit: null,
			tokens_limit: {
				used: 10,
				remaining: 90,
				percentage: 10,
				resetAt: 9999000,
				type: "tokens_limit",
			},
		};
		expect(extractWindowResetTime(data, "zai")).toBe(9999000);
	});

	it("returns null for zai provider when tokens_limit is null", () => {
		const data: ZaiUsageData = { time_limit: null, tokens_limit: null };
		expect(extractWindowResetTime(data, "zai")).toBeNull();
	});

	it("returns parsed resets_at ms for anthropic provider", () => {
		const resetIso = "2030-01-01T12:00:00Z";
		const data: UsageData = {
			five_hour: { utilization: 50, resets_at: resetIso },
			seven_day: { utilization: 10, resets_at: null },
		};
		expect(extractWindowResetTime(data, "anthropic")).toBe(
			new Date(resetIso).getTime(),
		);
	});

	it("returns null for anthropic when resets_at is null", () => {
		const data: UsageData = {
			five_hour: { utilization: 50, resets_at: null },
			seven_day: { utilization: 10, resets_at: null },
		};
		expect(extractWindowResetTime(data, "anthropic")).toBeNull();
	});

	it("returns the limits[] session reset for a limits[]-only anthropic payload", () => {
		const resetIso = "2030-02-01T08:00:00Z";
		const data = {
			limits: [
				{
					kind: "session",
					group: "session",
					percent: 20,
					resets_at: resetIso,
					scope: null,
					is_active: true,
				},
			],
		} as unknown as AnyUsageData;
		expect(extractWindowResetTime(data, "anthropic")).toBe(
			new Date(resetIso).getTime(),
		);
		// Works for codex too (shares the windowed shape).
		expect(extractWindowResetTime(data, "codex")).toBe(
			new Date(resetIso).getTime(),
		);
	});

	it("does not let an EMPTY flat five_hour shadow a valid limits[] session reset", () => {
		const flatReset = "2030-03-01T00:00:00Z"; // present but on an empty window
		const limitsReset = "2030-04-01T00:00:00Z";
		const data = {
			// Present-but-empty flat five_hour (utilization null) must not shadow the
			// real session window carried in limits[].
			five_hour: { utilization: null, resets_at: flatReset },
			limits: [
				{
					kind: "session",
					group: "session",
					percent: 20,
					resets_at: limitsReset,
					scope: null,
					is_active: true,
				},
			],
		} as unknown as AnyUsageData;
		expect(extractWindowResetTime(data, "anthropic")).toBe(
			new Date(limitsReset).getTime(),
		);
	});

	it("ignores a null-percent limits[] session entry (no window evidence)", () => {
		const data = {
			limits: [
				{
					kind: "session",
					group: "session",
					percent: null,
					resets_at: "2030-05-01T00:00:00Z",
					scope: null,
					is_active: true,
				},
			],
		} as unknown as AnyUsageData;
		// No finite-percent session and no flat window → no reset.
		expect(extractWindowResetTime(data, "anthropic")).toBeNull();
	});

	it("returns null for unknown/unsupported provider", () => {
		expect(
			extractWindowResetTime({} as unknown as AnyUsageData, "unknown-provider"),
		).toBeNull();
	});
});

// ── onWindowReset callback via usageCache.set ─────────────────────────────────

describe("usageCache window-reset callback", () => {
	it("fires onWindowReset when zai resetAt advances to a later value", () => {
		const accountId = "zai-window-reset-test";
		const callback = mock(() => {});

		const oldData: ZaiUsageData = {
			time_limit: null,
			tokens_limit: {
				used: 80,
				remaining: 20,
				percentage: 80,
				resetAt: 1000000,
				type: "tokens_limit",
			},
		};
		const newData: ZaiUsageData = {
			time_limit: null,
			tokens_limit: {
				used: 2,
				remaining: 98,
				percentage: 2,
				resetAt: 2000000,
				type: "tokens_limit",
			},
		};

		// Seed the cache with old data, then simulate a poll delivering new data
		usageCache.set(accountId, oldData);
		usageCache.notifyWindowReset(accountId, newData, "zai", callback);

		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith(accountId);

		usageCache.delete(accountId);
	});

	it("does not fire onWindowReset when resetAt stays the same", () => {
		const accountId = "zai-no-reset-test";
		const callback = mock(() => {});

		const data: ZaiUsageData = {
			time_limit: null,
			tokens_limit: {
				used: 50,
				remaining: 50,
				percentage: 50,
				resetAt: 1000000,
				type: "tokens_limit",
			},
		};

		usageCache.set(accountId, data);
		usageCache.notifyWindowReset(accountId, data, "zai", callback);

		expect(callback).not.toHaveBeenCalled();

		usageCache.delete(accountId);
	});

	it("does not fire onWindowReset on the first poll (no previous data)", () => {
		const accountId = "zai-first-poll-test";
		const callback = mock(() => {});

		const data: ZaiUsageData = {
			time_limit: null,
			tokens_limit: {
				used: 5,
				remaining: 95,
				percentage: 5,
				resetAt: 3000000,
				type: "tokens_limit",
			},
		};

		// No prior set() — first time seeing this account
		usageCache.notifyWindowReset(accountId, data, "zai", callback);

		expect(callback).not.toHaveBeenCalled();
	});

	it("does NOT fire on sub-second drift of a still-future reset (anthropic)", () => {
		// Regression: the provider returns a resets_at that drifts forward by a
		// few hundred ms on every poll while the SAME (future) window is active.
		// That must not be mistaken for a window roll (which was bumping
		// session_start ~every poll and flapping the dashboard Primary badge).
		const accountId = "anthropic-drift-test";
		const callback = mock(() => {});
		const now = 1_000_000_000_000; // fixed reference
		const futureReset = now + 4 * 60 * 60 * 1000; // 4h in the future

		const oldData: UsageData = {
			five_hour: {
				utilization: 2,
				resets_at: new Date(futureReset).toISOString(),
			},
			seven_day: { utilization: 50, resets_at: null },
		};
		const newData: UsageData = {
			five_hour: {
				utilization: 2,
				resets_at: new Date(futureReset + 215).toISOString(), // +215ms drift
			},
			seven_day: { utilization: 50, resets_at: null },
		};

		usageCache.set(accountId, oldData);
		usageCache.notifyWindowReset(
			accountId,
			newData,
			"anthropic",
			callback,
			now,
		);

		expect(callback).not.toHaveBeenCalled();
		usageCache.delete(accountId);
	});

	it("fires on a genuine roll once the previous reset time has passed (anthropic)", () => {
		const accountId = "anthropic-real-reset-test";
		const callback = mock(() => {});
		const now = 1_000_000_000_000;
		const passedReset = now - 1_000; // previous window's reset just arrived
		const nextReset = now + 5 * 60 * 60 * 1000; // next 5h window

		const oldData: UsageData = {
			five_hour: {
				utilization: 95,
				resets_at: new Date(passedReset).toISOString(),
			},
			seven_day: { utilization: 50, resets_at: null },
		};
		const newData: UsageData = {
			five_hour: {
				utilization: 0,
				resets_at: new Date(nextReset).toISOString(),
			},
			seven_day: { utilization: 50, resets_at: null },
		};

		usageCache.set(accountId, oldData);
		usageCache.notifyWindowReset(
			accountId,
			newData,
			"anthropic",
			callback,
			now,
		);

		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith(accountId);
		usageCache.delete(accountId);
	});
});
