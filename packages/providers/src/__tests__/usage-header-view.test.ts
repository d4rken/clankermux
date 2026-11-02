import { describe, expect, it } from "bun:test";
import {
	type ExtractedClaimReading,
	normalizeAnthropicUsage,
	reportsNoSessionWindow,
} from "@clankermux/core";
import type { AnthropicUsageData } from "@clankermux/types";
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

function windows(overrides: Partial<HeaderWindows> = {}): HeaderWindows {
	return {
		fiveHour: null,
		sevenDay: null,
		fiveHourShape: null,
		fiveHourAbsentAtMs: null,
		...overrides,
	};
}

/** A response with no 5h claim beside a usable 7d one, as the store holds it. */
function absentAt(observedAtMs: number): HeaderWindows {
	return windows({
		fiveHourShape: { kind: "absent", observedAtMs },
		fiveHourAbsentAtMs: observedAtMs,
	});
}

function presentAt(observedAtMs: number) {
	return { kind: "present", observedAtMs } as const;
}

function poll(data: UsageData, ageMs = 60_000) {
	return { data, writtenAtMs: NOW - ageMs, observedAtMs: NOW - ageMs };
}

const FIVE_RESET = NOW + 2 * HOUR;
const WEEK_RESET = NOW + 90 * HOUR;

/** A verified Ultra account's poll: the 5h window does not exist. */
function ultraPollData(weekPct = 30): UsageData {
	return {
		five_hour: null,
		seven_day: { utilization: weekPct, resets_at: iso(WEEK_RESET + 431) },
	};
}

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
		expect(windows).toEqual({
			fiveHour: null,
			sevenDay: null,
			fiveHourShape: null,
			fiveHourAbsentAtMs: null,
		});
	});
});

describe("headerWindowsFromClaims — 5h claim shape", () => {
	const weekly = claim({ claim: "7d", resetMs: WEEK_RESET });

	it("records an absence as the shape and the watermark", () => {
		const windows = headerWindowsFromClaims([weekly], NOW, "absent");
		expect(windows.fiveHourShape).toEqual({
			kind: "absent",
			observedAtMs: NOW,
		});
		expect(windows.fiveHourAbsentAtMs).toBe(NOW);
	});

	it("records a presence without a usable 5h reading", () => {
		const windows = headerWindowsFromClaims([weekly], NOW, "present");
		expect(windows.fiveHour).toBeNull();
		expect(windows.fiveHourShape).toEqual(presentAt(NOW));
		expect(windows.fiveHourAbsentAtMs).toBeNull();
	});

	it("records no shape when it is unknown", () => {
		const windows = headerWindowsFromClaims([weekly], NOW, "unknown");
		expect(windows.fiveHourShape).toBeNull();
		expect(windows.fiveHourAbsentAtMs).toBeNull();
	});
});

describe("mergeHeaderWindows — 5h claim shape", () => {
	it("keeps the newest shape; a tie goes to presence", () => {
		expect(
			mergeHeaderWindows(
				windows({ fiveHourShape: presentAt(NOW - 5_000) }),
				absentAt(NOW - 10_000),
			).fiveHourShape,
		).toEqual(presentAt(NOW - 5_000));
		expect(
			mergeHeaderWindows(
				absentAt(NOW),
				windows({ fiveHourShape: presentAt(NOW) }),
			).fiveHourShape,
		).toEqual(presentAt(NOW));
		const tie = mergeHeaderWindows(
			windows({ fiveHourShape: presentAt(NOW) }),
			absentAt(NOW),
		);
		expect(tie.fiveHourShape).toEqual(presentAt(NOW));
		expect(tie.fiveHourAbsentAtMs).toBe(NOW);
	});

	it("an absence drops a 5h reading observed at or before it", () => {
		const reading = header({ observedAtMs: NOW - 5_000 });
		expect(
			mergeHeaderWindows(windows({ fiveHour: reading }), absentAt(NOW - 5_000))
				.fiveHour,
		).toBeNull();
		const later = header({ observedAtMs: NOW });
		expect(
			mergeHeaderWindows(
				windows({ fiveHour: later, fiveHourShape: presentAt(NOW) }),
				absentAt(NOW - 5_000),
			).fiveHour,
		).toBe(later);
	});

	it("a delayed pre-transition response cannot bring the 5h reading back", () => {
		const merged = mergeHeaderWindows(
			absentAt(NOW - 20_000),
			windows({
				fiveHour: header({ observedAtMs: NOW - 30_000 }),
				fiveHourShape: presentAt(NOW - 30_000),
			}),
		);
		expect(merged.fiveHour).toBeNull();
		expect(merged.fiveHourShape).toEqual({
			kind: "absent",
			observedAtMs: NOW - 20_000,
		});
	});

	it("absence, malformed presence, then a late valid reading: nothing resurrects", () => {
		const t10 = NOW - 30_000;
		const t20 = NOW - 20_000;
		const t30 = NOW - 10_000;
		let stored = mergeHeaderWindows(undefined, absentAt(t20));
		stored = mergeHeaderWindows(
			stored,
			windows({ fiveHourShape: presentAt(t30) }),
		);
		stored = mergeHeaderWindows(
			stored,
			windows({
				fiveHour: header({ observedAtMs: t10 }),
				fiveHourShape: presentAt(t10),
			}),
		);
		expect(stored.fiveHour).toBeNull();
		expect(stored.fiveHourShape).toEqual(presentAt(t30));
		expect(stored.fiveHourAbsentAtMs).toBe(t20);
	});

	it("the absence watermark only rises", () => {
		const merged = mergeHeaderWindows(
			mergeHeaderWindows(
				absentAt(NOW - 5_000),
				windows({ fiveHourShape: presentAt(NOW) }),
			),
			absentAt(NOW - 10_000),
		);
		expect(merged.fiveHourAbsentAtMs).toBe(NOW - 5_000);
		expect(merged.fiveHourShape).toEqual(presentAt(NOW));
	});
});

describe("mergeHeaderWindows", () => {
	it("never replaces a reading with an older-observed one", () => {
		const newer = header({ utilization: 60, observedAtMs: NOW });
		const older = header({ utilization: 55, observedAtMs: NOW - 5_000 });
		const merged = mergeHeaderWindows(
			windows({ fiveHour: newer }),
			windows({ fiveHour: older, sevenDay: header({ resetMs: WEEK_RESET }) }),
		);
		expect(merged.fiveHour).toBe(newer);
		expect(merged.sevenDay?.resetMs).toBe(WEEK_RESET);
	});

	it("keeps the stored axis when the incoming one is absent", () => {
		const stored = header();
		const merged = mergeHeaderWindows(windows({ fiveHour: stored }), windows());
		expect(merged.fiveHour).toBe(stored);
	});

	it("takes a newer-observed reading", () => {
		const merged = mergeHeaderWindows(
			windows({ fiveHour: header({ observedAtMs: NOW - 5_000 }) }),
			windows({ fiveHour: header({ utilization: 70, observedAtMs: NOW }) }),
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
		const view = buildUsageView(
			poll(pollData(40, 30)),
			windows({
				fiveHour: header({ utilization: 55, resetMs: FIVE_RESET }),
				sevenDay: header({ utilization: 20, resetMs: WEEK_RESET }),
			}),
			NOW,
		);
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
			windows({
				fiveHour: header({
					utilization: 99,
					status: "allowed_warning",
					resetMs: FIVE_RESET,
				}),
			}),
			NOW,
		);
		expect((view.data as UsageData).five_hour?.utilization).toBe(100);
	});

	it("a header window with a later reset replaces the poll's axis", () => {
		const nextReset = FIVE_RESET + 5 * HOUR;
		const view = buildUsageView(
			poll(pollData(100, 30)),
			windows({ fiveHour: header({ utilization: 3, resetMs: nextReset }) }),
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
			windows({
				fiveHour: header({ utilization: 90, resetMs: FIVE_RESET - HOUR }),
			}),
			NOW,
		);
		expect((view.data as UsageData).five_hour?.utilization).toBe(40);
		expect(view.fiveHour.source).toBe("poll");
	});

	it("ignores a header window whose reset has passed", () => {
		const view = buildUsageView(
			poll(pollData(40, 30)),
			windows({ fiveHour: header({ utilization: 90, resetMs: NOW }) }),
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
			windows({ fiveHour: header({ utilization: 2 }) }),
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
			windows({ fiveHour: header({ utilization: 60 }) }),
			NOW,
		);
		const out = view.data as UsageData;
		expect(out.five_hour).toBeUndefined();
		expect(out.limits?.[0].percent).toBe(60);
		// The poll payload itself is never mutated.
		expect(data.limits?.[0].percent).toBe(40);
	});
});

describe("buildUsageView — no 5h window", () => {
	const pollAxis = (ageMs: number) => ({
		source: "poll" as const,
		observedAtMs: NOW - ageMs,
		freshAtMs: NOW - ageMs,
	});

	it("a poll without the window outranks an older, still-future header reading", () => {
		const data = ultraPollData();
		const view = buildUsageView(
			poll(data),
			windows({
				fiveHour: header({ observedAtMs: NOW - 120_000 }),
				fiveHourShape: presentAt(NOW - 120_000),
			}),
			NOW,
		);
		expect((view.data as UsageData).five_hour).toBeNull();
		expect(view.fiveHour).toEqual(pollAxis(60_000));
	});

	it("a header reading newer than the poll's absence is taken", () => {
		const view = buildUsageView(
			poll(ultraPollData()),
			windows({
				fiveHour: header({ utilization: 7 }),
				fiveHourShape: presentAt(NOW - 10_000),
			}),
			NOW,
		);
		expect((view.data as UsageData).five_hour?.utilization).toBe(7);
		expect(view.fiveHour.source).toBe("header");
	});

	it("a header absence newer than the poll removes the poll's 5h window", () => {
		const data = pollData(40, 30);
		const view = buildUsageView(poll(data), absentAt(NOW - 10_000), NOW);
		const out = view.data as UsageData;
		expect(out.five_hour).toBeNull();
		expect(out.seven_day.utilization).toBe(30);
		expect(reportsNoSessionWindow(out as AnthropicUsageData)).toBe(true);
		expect(view.fiveHour).toEqual({
			source: "header",
			observedAtMs: NOW - 10_000,
			freshAtMs: NOW - 10_000,
		});
		// The poll payload itself is never mutated.
		expect(data.five_hour?.utilization).toBe(40);
	});

	it("a poll carrying the window, newer than a header absence, keeps it", () => {
		const view = buildUsageView(
			poll(pollData(40, 30)),
			absentAt(NOW - 120_000),
			NOW,
		);
		expect((view.data as UsageData).five_hour?.utilization).toBe(40);
		expect(view.fiveHour).toEqual(pollAxis(60_000));
	});

	it("an absence removes the limits[] session entries too", () => {
		const limits = [
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
		];
		const data = { limits } as unknown as UsageData;
		const view = buildUsageView(poll(data), absentAt(NOW - 10_000), NOW);
		const out = view.data as UsageData;
		expect(out.five_hour).toBeNull();
		expect(out.limits?.map((e) => e.kind)).toEqual(["weekly_all"]);
		expect(reportsNoSessionWindow(out as AnthropicUsageData)).toBe(true);
		expect(data.limits).toHaveLength(2);
	});

	it("poll and header both without the window: timed by the newer of the two", () => {
		const data = ultraPollData();
		const view = buildUsageView(poll(data), absentAt(NOW - 120_000), NOW);
		expect(view.data).toBe(data);
		expect(view.fiveHour).toEqual({
			source: "merged",
			observedAtMs: NOW - 60_000,
			freshAtMs: NOW - 60_000,
		});
		const newer = buildUsageView(poll(data), absentAt(NOW - 5_000), NOW);
		expect(newer.fiveHour).toEqual({
			source: "merged",
			observedAtMs: NOW - 5_000,
			freshAtMs: NOW - 5_000,
		});
	});

	it.each([
		["a poll carrying the window", pollData(40, 30)],
		["a poll without the window", ultraPollData()],
	] as const)("absence then a malformed presence over %s: no 5h reading, no invented freshness", (_label, data) => {
		const view = buildUsageView(
			poll(data, 120_000),
			windows({
				fiveHourShape: presentAt(NOW - 5_000),
				fiveHourAbsentAtMs: NOW - 10_000,
			}),
			NOW,
		);
		const out = view.data as UsageData;
		expect("five_hour" in out).toBe(false);
		expect(reportsNoSessionWindow(out as AnthropicUsageData)).toBe(false);
		expect(
			normalizeAnthropicUsage(out as AnthropicUsageData, NOW).session,
		).toBeNull();
		expect(view.fiveHour).toEqual({
			source: "poll",
			observedAtMs: null,
			freshAtMs: Number.NEGATIVE_INFINITY,
		});
		expect(isUsageViewFresh(view, NOW, 60_000)).toBe(false);
	});

	// Poll at 99% (T0), header absence (T1), malformed header presence (T2).
	const reappearedUnread = (extra: Partial<HeaderWindows> = {}) =>
		windows({
			fiveHourShape: presentAt(NOW - 10_000),
			fiveHourAbsentAtMs: NOW - 20_000,
			sevenDay: header({ observedAtMs: NOW - 10_000, resetMs: WEEK_RESET }),
			...extra,
		});

	it("a window that came back with nothing usable reading it is never fresh", () => {
		const view = buildUsageView(
			poll(pollData(99, 30), 30_000),
			reappearedUnread(),
			NOW,
		);
		expect("five_hour" in (view.data as UsageData)).toBe(false);
		expect(view.fiveHour.source).toBe("poll");
		expect(isUsageViewFresh(view, NOW, 180_000)).toBe(false);
	});

	it("a usable header reading after the reappearance makes it fresh again", () => {
		const view = buildUsageView(
			poll(pollData(99, 30), 30_000),
			reappearedUnread({
				fiveHour: header({ utilization: 12, observedAtMs: NOW - 5_000 }),
			}),
			NOW,
		);
		expect((view.data as UsageData).five_hour?.utilization).toBe(12);
		expect(isUsageViewFresh(view, NOW, 180_000)).toBe(true);
	});

	it("a usable poll after the reappearance makes it fresh again", () => {
		const view = buildUsageView(
			poll(pollData(55, 30), 5_000),
			reappearedUnread(),
			NOW,
		);
		expect((view.data as UsageData).five_hour?.utilization).toBe(55);
		expect(view.fiveHour).toEqual(pollAxis(5_000));
		expect(isUsageViewFresh(view, NOW, 180_000)).toBe(true);
	});

	it("a fresh header absence and 7d reading carry an old poll", () => {
		const view = buildUsageView(
			poll(ultraPollData(), 500_000),
			{
				...absentAt(NOW - 5_000),
				sevenDay: header({ observedAtMs: NOW - 5_000, resetMs: WEEK_RESET }),
			},
			NOW,
		);
		expect(isUsageViewFresh(view, NOW, 180_000)).toBe(true);
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
			windows({
				fiveHour: { ...fresh(5_000), resetMs: FIVE_RESET },
				sevenDay: { ...fresh(5_000), resetMs: WEEK_RESET },
			}),
			NOW,
		);
		expect(isUsageViewFresh(view, NOW, 180_000)).toBe(true);
	});

	it("one axis still on the old poll keeps the view stale", () => {
		const view = buildUsageView(
			poll(pollData(), 500_000),
			windows({ fiveHour: { ...fresh(5_000), resetMs: FIVE_RESET } }),
			NOW,
		);
		expect(isUsageViewFresh(view, NOW, 180_000)).toBe(false);
	});

	it("a reported poll-only axis older than the bound makes the view stale", () => {
		const stored = windows({
			fiveHour: { ...fresh(5_000), resetMs: FIVE_RESET },
			sevenDay: { ...fresh(5_000), resetMs: WEEK_RESET },
		});
		const withOauth: UsageData = {
			...pollData(),
			seven_day_oauth_apps: { utilization: 12, resets_at: iso(WEEK_RESET) },
		};
		expect(
			isUsageViewFresh(
				buildUsageView(poll(withOauth, 500_000), stored, NOW),
				NOW,
				180_000,
			),
		).toBe(false);
		expect(
			isUsageViewFresh(
				buildUsageView(poll(withOauth, 100_000), stored, NOW),
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
