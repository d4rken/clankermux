import { describe, expect, it } from "bun:test";
import type { ExtractedClaimReading } from "@clankermux/core";
import type { UsageData } from "../usage-fetcher";
import {
	buildUsageView,
	type HeaderWindowReading,
	type HeaderWindows,
	headerWindowFromClaim,
	headerWindowsFromClaims,
	isUsageViewFresh,
	mergeHeaderWindows,
	reportsPollOnlyAxis,
} from "../usage-header-view";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function claim(
	overrides: Partial<ExtractedClaimReading> = {},
): ExtractedClaimReading {
	return {
		claim: "5h",
		status: "allowed",
		utilization: 0.42,
		resetMs: NOW + 2 * HOUR,
		surpassedThreshold: null,
		...overrides,
	};
}

function header(
	overrides: Partial<HeaderWindowReading> = {},
): HeaderWindowReading {
	return {
		utilization: 50,
		resetMs: NOW + 2 * HOUR,
		status: "allowed",
		observedAtMs: NOW - 10_000,
		...overrides,
	};
}

function poll(data: UsageData, ageMs = 60_000) {
	return { data, writtenAtMs: NOW - ageMs, observedAtMs: NOW - ageMs };
}

const FIVE_RESET = NOW + 2 * HOUR;
const WEEK_RESET = NOW + 90 * HOUR;

function pollData(fivePct = 40, weekPct = 30): UsageData {
	return {
		five_hour: {
			utilization: fivePct,
			// The poll's reset carries a sub-second fraction the header's does not.
			resets_at: iso(FIVE_RESET + 219),
		},
		seven_day: { utilization: weekPct, resets_at: iso(WEEK_RESET + 431) },
	};
}

describe("headerWindowFromClaim", () => {
	it("converts a 0..1 fraction to percent and keeps reset, status and time", () => {
		expect(headerWindowFromClaim(claim({ utilization: 0.29 }), NOW)).toEqual({
			utilization: 29,
			resetMs: NOW + 2 * HOUR,
			status: "allowed",
			observedAtMs: NOW,
		});
	});

	it("accepts allowed_warning and both range ends", () => {
		expect(
			headerWindowFromClaim(
				claim({ status: "allowed_warning", utilization: 0.99 }),
				NOW,
			)?.utilization,
		).toBe(99);
		expect(
			headerWindowFromClaim(claim({ utilization: 0 }), NOW)?.utilization,
		).toBe(0);
		expect(
			headerWindowFromClaim(claim({ utilization: 1 }), NOW)?.utilization,
		).toBe(100);
	});

	it.each([
		["rejected status", { status: "rejected" }],
		["unknown status", { status: "queueing_soft" }],
		["empty status", { status: "" }],
		["null utilization", { utilization: null }],
		["utilization above 1", { utilization: 1.01 }],
		["negative utilization", { utilization: -0.1 }],
		["NaN utilization", { utilization: Number.NaN }],
		["infinite utilization", { utilization: Number.POSITIVE_INFINITY }],
		["null reset", { resetMs: null }],
		["reset at the observation", { resetMs: NOW }],
		["reset before the observation", { resetMs: NOW - 1 }],
		["infinite reset", { resetMs: Number.POSITIVE_INFINITY }],
		["reset past the Date range", { resetMs: 8.64e15 + 1_000 }],
	] as const)("ignores a claim with %s", (_label, overrides) => {
		expect(
			headerWindowFromClaim(
				claim(overrides as Partial<ExtractedClaimReading>),
				NOW,
			),
		).toBeNull();
	});
});

describe("headerWindowsFromClaims", () => {
	it("keeps only the account-wide 5h and 7d claims", () => {
		const windows = headerWindowsFromClaims(
			[
				claim({ claim: "5h", utilization: 0.1 }),
				claim({ claim: "7d", utilization: 0.2, resetMs: WEEK_RESET }),
				claim({ claim: "7d_oi", utilization: 0.9 }),
			],
			NOW,
		);
		expect(windows.fiveHour?.utilization).toBe(10);
		expect(windows.sevenDay?.utilization).toBe(20);
	});

	it("reports an invalid claim as absent", () => {
		const windows = headerWindowsFromClaims(
			[claim({ claim: "5h", status: "rejected" })],
			NOW,
		);
		expect(windows).toEqual({ fiveHour: null, sevenDay: null });
	});
});

describe("mergeHeaderWindows", () => {
	it("never replaces a reading with an older-observed one", () => {
		const newer = header({ utilization: 60, observedAtMs: NOW });
		const older = header({ utilization: 55, observedAtMs: NOW - 5_000 });
		const merged = mergeHeaderWindows(
			{ fiveHour: newer, sevenDay: null },
			{ fiveHour: older, sevenDay: header({ resetMs: WEEK_RESET }) },
		);
		expect(merged.fiveHour).toBe(newer);
		expect(merged.sevenDay?.resetMs).toBe(WEEK_RESET);
	});

	it("keeps the stored axis when the incoming one is absent", () => {
		const stored = header();
		const merged = mergeHeaderWindows(
			{ fiveHour: stored, sevenDay: null },
			{ fiveHour: null, sevenDay: null },
		);
		expect(merged.fiveHour).toBe(stored);
	});

	it("takes a newer-observed reading", () => {
		const merged = mergeHeaderWindows(
			{ fiveHour: header({ observedAtMs: NOW - 5_000 }), sevenDay: null },
			{
				fiveHour: header({ utilization: 70, observedAtMs: NOW }),
				sevenDay: null,
			},
		);
		expect(merged.fiveHour?.utilization).toBe(70);
	});
});

describe("buildUsageView", () => {
	it("is the poll reading, unchanged, when there are no header windows", () => {
		const data = pollData();
		const view = buildUsageView(poll(data), null, NOW);
		expect(view.data).toBe(data);
		expect(view.fiveHour).toEqual({
			source: "poll",
			observedAtMs: NOW - 60_000,
			freshAtMs: NOW - 60_000,
		});
		expect(view.sevenDay.source).toBe("poll");
	});

	it("same window: keeps the higher utilization and the newer time", () => {
		const windows: HeaderWindows = {
			fiveHour: header({ utilization: 55, resetMs: FIVE_RESET }),
			sevenDay: header({ utilization: 20, resetMs: WEEK_RESET }),
		};
		const view = buildUsageView(poll(pollData(40, 30)), windows, NOW);
		const data = view.data as UsageData;
		expect(data.five_hour?.utilization).toBe(55);
		// The poll's reset instant is kept for the same window.
		expect(data.five_hour?.resets_at).toBe(iso(FIVE_RESET + 219));
		// The poll's 30 beats the header's 20 on the weekly axis.
		expect(data.seven_day.utilization).toBe(30);
		expect(view.fiveHour).toEqual({
			source: "merged",
			observedAtMs: NOW - 10_000,
			freshAtMs: NOW - 10_000,
		});
	});

	it("a saturated 0.99 header never lowers a poll reading of 100", () => {
		const view = buildUsageView(
			poll(pollData(100, 30)),
			{
				fiveHour: header({
					utilization: 99,
					status: "allowed_warning",
					resetMs: FIVE_RESET,
				}),
				sevenDay: null,
			},
			NOW,
		);
		expect((view.data as UsageData).five_hour?.utilization).toBe(100);
	});

	it("a header window with a later reset replaces the poll's axis", () => {
		const nextReset = FIVE_RESET + 5 * HOUR;
		const view = buildUsageView(
			poll(pollData(100, 30)),
			{
				fiveHour: header({ utilization: 3, resetMs: nextReset }),
				sevenDay: null,
			},
			NOW,
		);
		const data = view.data as UsageData;
		expect(data.five_hour).toEqual({
			utilization: 3,
			resets_at: iso(nextReset),
		});
		expect(view.fiveHour.source).toBe("header");
	});

	it("ignores a header window with an earlier reset than the poll's", () => {
		const view = buildUsageView(
			poll(pollData(40, 30)),
			{
				fiveHour: header({ utilization: 90, resetMs: FIVE_RESET - HOUR }),
				sevenDay: null,
			},
			NOW,
		);
		expect((view.data as UsageData).five_hour?.utilization).toBe(40);
		expect(view.fiveHour.source).toBe("poll");
	});

	it("ignores a header window whose reset has passed", () => {
		const view = buildUsageView(
			poll(pollData(40, 30)),
			{
				fiveHour: header({ utilization: 90, resetMs: NOW }),
				sevenDay: null,
			},
			NOW,
		);
		expect(view.fiveHour.source).toBe("poll");
	});

	it("a header fills an axis the poll reports without a reset", () => {
		const view = buildUsageView(
			poll({
				five_hour: { utilization: 0, resets_at: null },
				seven_day: { utilization: 30, resets_at: iso(WEEK_RESET) },
			}),
			{ fiveHour: header({ utilization: 2 }), sevenDay: null },
			NOW,
		);
		expect((view.data as UsageData).five_hour?.utilization).toBe(2);
		expect(view.fiveHour.source).toBe("header");
	});

	it("updates a limits[]-only payload in place", () => {
		const data = {
			limits: [
				{
					kind: "session",
					group: "g",
					percent: 40,
					resets_at: iso(FIVE_RESET),
					scope: null,
					is_active: true,
				},
				{
					kind: "weekly_all",
					group: "g",
					percent: 30,
					resets_at: iso(WEEK_RESET),
					scope: null,
					is_active: true,
				},
			],
		} as unknown as UsageData;
		const view = buildUsageView(
			poll(data),
			{ fiveHour: header({ utilization: 60 }), sevenDay: null },
			NOW,
		);
		const out = view.data as UsageData;
		expect(out.five_hour).toBeUndefined();
		expect(out.limits?.[0].percent).toBe(60);
		// The poll payload itself is never mutated.
		expect(data.limits?.[0].percent).toBe(40);
	});
});

describe("isUsageViewFresh / reportsPollOnlyAxis", () => {
	const fresh = (ageMs: number) => header({ observedAtMs: NOW - ageMs });

	it("poll-only view: fresh exactly when the poll is within the bound", () => {
		expect(
			isUsageViewFresh(
				buildUsageView(poll(pollData(), 100_000), null, NOW),
				NOW,
				180_000,
			),
		).toBe(true);
		expect(
			isUsageViewFresh(
				buildUsageView(poll(pollData(), 200_000), null, NOW),
				NOW,
				180_000,
			),
		).toBe(false);
	});

	it("fresh header 5h and 7d carry an old poll", () => {
		const view = buildUsageView(
			poll(pollData(), 500_000),
			{
				fiveHour: { ...fresh(5_000), resetMs: FIVE_RESET },
				sevenDay: { ...fresh(5_000), resetMs: WEEK_RESET },
			},
			NOW,
		);
		expect(isUsageViewFresh(view, NOW, 180_000)).toBe(true);
	});

	it("one axis still on the old poll keeps the view stale", () => {
		const view = buildUsageView(
			poll(pollData(), 500_000),
			{ fiveHour: { ...fresh(5_000), resetMs: FIVE_RESET }, sevenDay: null },
			NOW,
		);
		expect(isUsageViewFresh(view, NOW, 180_000)).toBe(false);
	});

	it("a reported poll-only axis older than the bound makes the view stale", () => {
		const windows: HeaderWindows = {
			fiveHour: { ...fresh(5_000), resetMs: FIVE_RESET },
			sevenDay: { ...fresh(5_000), resetMs: WEEK_RESET },
		};
		const withOauth: UsageData = {
			...pollData(),
			seven_day_oauth_apps: { utilization: 12, resets_at: iso(WEEK_RESET) },
		};
		expect(
			isUsageViewFresh(
				buildUsageView(poll(withOauth, 500_000), windows, NOW),
				NOW,
				180_000,
			),
		).toBe(false);
		expect(
			isUsageViewFresh(
				buildUsageView(poll(withOauth, 100_000), windows, NOW),
				NOW,
				180_000,
			),
		).toBe(true);
	});

	it("counts a poll-only axis as reported only with a finite, enabled reading", () => {
		const base = pollData();
		expect(reportsPollOnlyAxis(base)).toBe(false);
		expect(
			reportsPollOnlyAxis({
				...base,
				seven_day_oauth_apps: null as never,
			}),
		).toBe(false);
		expect(
			reportsPollOnlyAxis({
				...base,
				seven_day_oauth_apps: { utilization: null as never, resets_at: null },
			}),
		).toBe(false);
		expect(
			reportsPollOnlyAxis({
				...base,
				seven_day_oauth_apps: { utilization: 0, resets_at: null },
			}),
		).toBe(true);
		expect(
			reportsPollOnlyAxis({
				...base,
				extra_usage: {
					is_enabled: false,
					monthly_limit: null,
					used_credits: null,
					utilization: 80,
				},
			}),
		).toBe(false);
		expect(
			reportsPollOnlyAxis({
				...base,
				extra_usage: {
					is_enabled: true,
					monthly_limit: 100,
					used_credits: 10,
					utilization: null,
				},
			}),
		).toBe(false);
		expect(
			reportsPollOnlyAxis({
				...base,
				extra_usage: {
					is_enabled: true,
					monthly_limit: 100,
					used_credits: 10,
					utilization: 10,
				},
			}),
		).toBe(true);
	});
});
