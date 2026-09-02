import { describe, expect, it } from "bun:test";
import type { Account } from "@clankermux/types";
import {
	createUsageThrottledResponse,
	getUsageThrottleStatus,
	getUsageThrottleUntil,
} from "../usage-throttling";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "Codex Account",
		provider: "codex",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

describe("getUsageThrottleUntil", () => {
	it("returns a future resume time when Codex usage is ahead of the pacing line", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = new Date(now + 2 * 60 * 60 * 1000).toISOString();

		const throttleUntil = getUsageThrottleUntil(
			{
				five_hour: { utilization: 80, resets_at: resetAt },
				seven_day: { utilization: 10, resets_at: null },
			},
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
			"anthropic",
		);

		expect(throttleUntil).not.toBeNull();
		expect(throttleUntil).toBeGreaterThan(now);
	});

	it("does not throttle when usage is below the pacing line", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = new Date(now + 30 * 60 * 1000).toISOString();

		const throttleUntil = getUsageThrottleUntil(
			{
				five_hour: { utilization: 10, resets_at: resetAt },
				seven_day: { utilization: 5, resets_at: null },
			},
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
			"anthropic",
		);

		expect(throttleUntil).toBeNull();
	});

	it("does not double-count anthropic-like usage as Alibaba usage", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = now + 2 * 24 * 60 * 60 * 1000;

		const throttleUntil = getUsageThrottleUntil(
			{
				five_hour: {
					utilization: 10,
					resets_at: new Date(now + 30 * 60 * 1000).toISOString(),
				},
				seven_day: {
					utilization: 10,
					resets_at: new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString(),
				},
				weekly: { percentUsed: 95, resetAt },
				monthly: {
					percentUsed: 10,
					resetAt: now + 20 * 24 * 60 * 60 * 1000,
				},
			},
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
			"anthropic",
		);

		expect(throttleUntil).toBeNull();
	});

	it("reports the latest resume time when two windows throttle at once", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const HOUR_MS = 60 * 60 * 1000;
		const DAY_MS = 24 * HOUR_MS;
		const throttleStatus = getUsageThrottleStatus(
			{
				// 5h: 60% elapsed, 80% used → resumes at now + 1h
				five_hour: {
					utilization: 80,
					resets_at: new Date(now + 2 * HOUR_MS).toISOString(),
				},
				// 7d: ~71% elapsed, 90% used → resumes at now + 1.3d (the later one)
				seven_day: {
					utilization: 90,
					resets_at: new Date(now + 2 * DAY_MS).toISOString(),
				},
			},
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
			"anthropic",
		);

		expect(throttleStatus.throttledWindows.sort()).toEqual([
			"five_hour",
			"seven_day",
		]);
		expect(throttleStatus.throttleUntil).toBe(now + 1.3 * DAY_MS);
	});

	it("can throttle weekly usage independently from the 5-hour window", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const throttleStatus = getUsageThrottleStatus(
			{
				five_hour: {
					utilization: 10,
					resets_at: new Date(now + 30 * 60 * 1000).toISOString(),
				},
				seven_day: {
					utilization: 95,
					resets_at: new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString(),
				},
			},
			{ fiveHourEnabled: false, weeklyEnabled: true },
			now,
			"anthropic",
		);

		expect(throttleStatus.throttledWindows).toEqual(["seven_day"]);
		expect(throttleStatus.throttleUntil).not.toBeNull();
	});

	it("throttles a limits[]-only account ahead of its 5h pacing line", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = new Date(now + 2 * 60 * 60 * 1000).toISOString();

		const throttleUntil = getUsageThrottleUntil(
			{
				limits: [
					{
						kind: "session",
						group: "session",
						percent: 80,
						resets_at: resetAt,
						scope: null,
						is_active: true,
					},
					{
						kind: "weekly_all",
						group: "weekly",
						percent: 10,
						resets_at: null,
						scope: null,
						is_active: true,
					},
				],
			} as never,
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
			"anthropic",
		);

		expect(throttleUntil).not.toBeNull();
		expect(throttleUntil).toBeGreaterThan(now);
	});

	it("throttles a limits[]-only weekly window independently of the 5h window", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const status = getUsageThrottleStatus(
			{
				limits: [
					{
						kind: "session",
						group: "session",
						percent: 10,
						resets_at: new Date(now + 30 * 60 * 1000).toISOString(),
						scope: null,
						is_active: true,
					},
					{
						kind: "weekly_all",
						group: "weekly",
						percent: 95,
						resets_at: new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString(),
						scope: null,
						is_active: true,
					},
				],
			} as never,
			{ fiveHourEnabled: false, weeklyEnabled: true },
			now,
			"anthropic",
		);

		expect(status.throttledWindows).toEqual(["seven_day"]);
		expect(status.throttleUntil).not.toBeNull();
	});

	it("does not throttle a limits[]-only account that is below pace", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const throttleUntil = getUsageThrottleUntil(
			{
				limits: [
					{
						kind: "session",
						group: "session",
						percent: 5,
						resets_at: new Date(now + 30 * 60 * 1000).toISOString(),
						scope: null,
						is_active: true,
					},
				],
			} as never,
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
			"anthropic",
		);

		expect(throttleUntil).toBeNull();
	});

	it("caps throttleUntil at the window reset when utilization exceeds 100%", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = new Date(now + 60 * 60 * 1000).toISOString();

		const throttleUntil = getUsageThrottleUntil(
			{
				five_hour: { utilization: 120, resets_at: resetAt },
				seven_day: { utilization: 10, resets_at: null },
			},
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
			"anthropic",
		);

		expect(throttleUntil).toBe(new Date(resetAt).getTime());
	});
});

describe("per-family weekly windows are NOT account-wide throttle evidence", () => {
	const DAY_MS = 24 * 60 * 60 * 1000;

	it("emits no window for a limits[] scoped entry that is ahead of pace", () => {
		// Throttling a whole account because ONE family is ahead of its weekly
		// pace delays every other family on it. That decision belongs to the
		// family-weekly gate, which knows the requested family.
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const weeklyReset = new Date(now + 5 * DAY_MS).toISOString();
		const status = getUsageThrottleStatus(
			{
				limits: [
					{
						kind: "session",
						group: "session",
						percent: 5,
						resets_at: new Date(now + 4 * 60 * 60 * 1000).toISOString(),
						scope: null,
						is_active: true,
					},
					{
						kind: "weekly_all",
						group: "weekly",
						percent: 10,
						resets_at: weeklyReset,
						scope: null,
						is_active: true,
					},
					{
						// 90% two days into a 7-day window: far ahead of the ~28.6%
						// an even burn would be at.
						kind: "weekly_scoped",
						group: "weekly",
						percent: 90,
						resets_at: weeklyReset,
						scope: { model: { id: "opus", display_name: "Opus" } },
						is_active: true,
					},
				],
			} as never,
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
			"anthropic",
		);

		expect(status.throttledWindows).toEqual([]);
		expect(status.throttleUntil).toBeNull();
	});

	it("still throttles the ACCOUNT-WIDE weekly window in the same payload", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const weeklyReset = new Date(now + 5 * DAY_MS).toISOString();
		const status = getUsageThrottleStatus(
			{
				limits: [
					{
						kind: "weekly_all",
						group: "weekly",
						percent: 90,
						resets_at: weeklyReset,
						scope: null,
						is_active: true,
					},
					{
						kind: "weekly_scoped",
						group: "weekly",
						percent: 90,
						resets_at: weeklyReset,
						scope: { model: { id: "opus", display_name: "Opus" } },
						is_active: true,
					},
				],
			} as never,
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
			"anthropic",
		);

		expect(status.throttledWindows).toEqual(["seven_day"]);
	});

	it("ignores the legacy flat seven_day_opus/seven_day_sonnet keys", () => {
		// Null upstream since the scoped windows moved into limits[]; a stale
		// payload that still carries them must not resurrect account-wide pacing.
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const status = getUsageThrottleStatus(
			{
				five_hour: {
					utilization: 5,
					resets_at: new Date(now + 4 * 60 * 60 * 1000).toISOString(),
				},
				seven_day: {
					utilization: 10,
					resets_at: new Date(now + 5 * DAY_MS).toISOString(),
				},
				seven_day_opus: {
					utilization: 90,
					resets_at: new Date(now + 5 * DAY_MS).toISOString(),
				},
				seven_day_sonnet: {
					utilization: 95,
					resets_at: new Date(now + 5 * DAY_MS).toISOString(),
				},
			} as never,
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
			"anthropic",
		);

		expect(status.throttledWindows).toEqual([]);
		expect(status.throttleUntil).toBeNull();
	});
});

describe("getUsageThrottleUntil — MiniMax", () => {
	const HOUR_MS = 60 * 60 * 1000;

	function minimaxData(
		fiveHour: {
			utilization: number;
			resetAt: number | null;
			intervalMs: number | null;
		} | null,
		sevenDay: {
			utilization: number;
			resetAt: number | null;
			intervalMs: number | null;
		} | null = null,
	) {
		const wrap = (
			w: {
				utilization: number;
				resetAt: number | null;
				intervalMs: number | null;
			} | null,
		) =>
			w
				? {
						utilization: w.utilization,
						remainingPercent: 100 - w.utilization,
						resetAt: w.resetAt,
						intervalMs: w.intervalMs,
					}
				: null;
		return {
			five_hour: wrap(fiveHour),
			seven_day: wrap(sevenDay),
		} as never;
	}

	it("throttles a five_hour window that is ahead of pace", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		// 5h window, 1h left → 80% elapsed, 90% used → ahead of pace.
		const status = getUsageThrottleStatus(
			minimaxData({
				utilization: 90,
				resetAt: now + HOUR_MS,
				intervalMs: 5 * HOUR_MS,
			}),
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
			"minimax",
		);

		expect(status.throttledWindows).toEqual(["five_hour"]);
		// startMs = reset - 5h = now - 4h; resume = start + 90% * 5h = now + 0.5h.
		expect(status.throttleUntil).toBe(now + 0.5 * HOUR_MS);
	});

	it("follows the data-derived interval rather than a fixed 5h duration", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		// Same reading, but the API reports a 2h window: startMs = now - 1h,
		// resume = start + 90% * 2h = now + 0.8h.
		const status = getUsageThrottleStatus(
			minimaxData({
				utilization: 90,
				resetAt: now + HOUR_MS,
				intervalMs: 2 * HOUR_MS,
			}),
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
			"minimax",
		);

		expect(status.throttledWindows).toEqual(["five_hour"]);
		expect(status.throttleUntil).toBe(now + 0.8 * HOUR_MS);
	});

	it("does not throttle a window that is behind pace", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const throttleUntil = getUsageThrottleUntil(
			minimaxData({
				utilization: 10,
				resetAt: now + HOUR_MS,
				intervalMs: 5 * HOUR_MS,
			}),
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
			"minimax",
		);

		expect(throttleUntil).toBeNull();
	});

	it("throttles the seven_day window and tolerates a null five_hour", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const DAY_MS = 24 * HOUR_MS;
		const status = getUsageThrottleStatus(
			minimaxData(null, {
				utilization: 90,
				resetAt: now + 2 * DAY_MS,
				intervalMs: 7 * DAY_MS,
			}),
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
			"minimax",
		);

		expect(status.throttledWindows).toEqual(["seven_day"]);
		expect(status.throttleUntil).toBe(now + 1.3 * DAY_MS);
	});

	it("emits no window when intervalMs is missing or unusable (fail open)", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		for (const intervalMs of [null, 0, -HOUR_MS, Number.NaN]) {
			const status = getUsageThrottleStatus(
				minimaxData({
					utilization: 90,
					resetAt: now + HOUR_MS,
					intervalMs,
				}),
				{ fiveHourEnabled: true, weeklyEnabled: true },
				now,
				"minimax",
			);
			expect(status.throttledWindows).toEqual([]);
			expect(status.throttleUntil).toBeNull();
		}
	});

	it("does not read a MiniMax payload as an Anthropic one", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		// The MiniMax shape has top-level five_hour/seven_day keys, so the generic
		// Anthropic branch matches it structurally and reads `resets_at`, which
		// MiniMax never carries. Passing "anthropic" here proves the provider
		// argument (not the shape) is what selects the MiniMax reader.
		const status = getUsageThrottleStatus(
			minimaxData({
				utilization: 90,
				resetAt: now + HOUR_MS,
				intervalMs: 5 * HOUR_MS,
			}),
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
			"anthropic",
		);

		expect(status.throttledWindows).toEqual([]);
		expect(status.throttleUntil).toBeNull();
	});
});

describe("createUsageThrottledResponse", () => {
	it("returns HTTP 529 with Retry-After and an Anthropic-style overload body", async () => {
		const response = createUsageThrottledResponse([
			makeAccount({ name: "Codex A" }),
			makeAccount({ id: "acc-2", name: "Codex B" }),
		]);

		expect(response.status).toBe(529);
		expect(response.headers.get("Retry-After")).toBe("60");

		const body = (await response.json()) as {
			type: string;
			error: { type: string; message: string };
		};
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("overloaded_error");
		expect(body.error.message).toContain("Codex A");
		expect(body.error.message).toContain("Codex B");
	});
});
