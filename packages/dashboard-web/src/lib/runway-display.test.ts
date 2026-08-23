import { describe, expect, it } from "bun:test";
import type { RunwayCause, RunwayOutcome } from "@clankermux/core";
import { effectiveRunwayOutcome } from "@clankermux/core";
import {
	BEYOND_HORIZON_GLYPH,
	describeRunwayCause,
	formatRunwayValue,
	runwayQualifier,
	runwayUnavailableReason,
	runwayWindowLabel,
} from "./runway-display";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);

const accounts = [
	{ id: "acc-1", name: "Primary" },
	{ id: "acc-2", name: "Backup" },
];

function runwayOutcome(
	durationMs: number,
	unprojectableAccountIds: string[] = [],
	causes: RunwayCause[] = [],
): RunwayOutcome {
	return {
		kind: "runway",
		exhaustsAtMs: NOW + durationMs,
		durationMs,
		causes,
		unprojectableAccountIds,
	};
}

describe("runwayUnavailableReason", () => {
	it("explains an empty eligible pool", () => {
		expect(runwayUnavailableReason({ kind: "no-accounts" })).toBe(
			"No accounts this key can route to",
		);
	});

	it("explains a pool with no quota evidence", () => {
		expect(runwayUnavailableReason({ kind: "unknown" })).toBe(
			"No quota evidence for any account",
		);
	});

	it("is null for every statable outcome", () => {
		const statable: RunwayOutcome[] = [
			{ kind: "out-now", causes: [], unprojectableAccountIds: [] },
			{
				kind: "beyond-horizon",
				horizonMs: 14 * DAY,
				unprojectableAccountIds: [],
			},
			runwayOutcome(HOUR),
		];
		for (const outcome of statable) {
			expect(runwayUnavailableReason(outcome)).toBeNull();
		}
	});
});

describe("formatRunwayValue", () => {
	it("renders an infinity glyph beyond the horizon", () => {
		expect(
			formatRunwayValue(
				{
					kind: "beyond-horizon",
					horizonMs: 14 * DAY,
					unprojectableAccountIds: [],
				},
				NOW,
			),
		).toBe(BEYOND_HORIZON_GLYPH);
	});

	it("says out of quota rather than showing a zero", () => {
		expect(
			formatRunwayValue(
				{
					kind: "out-now",
					causes: [],
					unprojectableAccountIds: [],
				},
				NOW,
			),
		).toBe("Out of quota");
	});

	it("marks a figure computed without every account as a lower bound", () => {
		expect(
			formatRunwayValue(runwayOutcome(3 * DAY + 2 * HOUR, ["acc-9"]), NOW),
		).toBe("≥ 3d 2h");
	});

	it("states a complete figure plainly", () => {
		expect(formatRunwayValue(runwayOutcome(3 * DAY + 2 * HOUR), NOW)).toBe(
			"3d 2h",
		);
	});

	it("has no figure for the unavailable outcomes", () => {
		expect(formatRunwayValue({ kind: "unknown" }, NOW)).toBeNull();
		expect(formatRunwayValue({ kind: "no-accounts" }, NOW)).toBeNull();
	});
});

/**
 * The outcome is served from `/api/runway` and refreshed on a poll. Rendering
 * its `durationMs` verbatim would freeze the countdown between polls, so the
 * remaining time is derived from `exhaustsAtMs` against the caller's clock.
 */
describe("countdown against a fixed response", () => {
	const fixed = runwayOutcome(4 * HOUR);

	it("shrinks as `now` advances", () => {
		expect(formatRunwayValue(fixed, NOW)).toBe("4h");
		expect(formatRunwayValue(fixed, NOW + HOUR)).toBe("3h");
		expect(formatRunwayValue(fixed, NOW + 3.5 * HOUR)).toBe("30m");
	});

	it("flips to the out-of-quota rendering once its deadline passes", () => {
		// Not "0", and not a stale "4h": the projection's own answer past its
		// deadline, with no newer data, is that there is no quota.
		expect(formatRunwayValue(fixed, NOW + 4 * HOUR)).toBe("Out of quota");
		expect(formatRunwayValue(fixed, NOW + 5 * HOUR)).toBe("Out of quota");
	});

	it("keeps the lower-bound marker off the expired rendering", () => {
		const bounded = runwayOutcome(4 * HOUR, ["acc-9"]);
		expect(formatRunwayValue(bounded, NOW)).toBe("≥ 4h");
		expect(formatRunwayValue(bounded, NOW + 4 * HOUR)).toBe("Out of quota");
		// The unreadable account is still reported, just not as a bound on a
		// figure that no longer exists.
		expect(runwayQualifier(bounded, NOW + 4 * HOUR)).toBe("1 account unknown");
	});

	it("carries the causes across the transition", () => {
		const outcome: RunwayOutcome = {
			kind: "runway",
			exhaustsAtMs: NOW + 4 * HOUR,
			durationMs: 4 * HOUR,
			causes: [{ accountId: "acc-2", windowKind: "seven_day" }],
			unprojectableAccountIds: [],
		};

		expect(describeRunwayCause(outcome, accounts, NOW)).toBe("Backup weekly");
		expect(describeRunwayCause(outcome, accounts, NOW + 5 * HOUR)).toBe(
			"Backup weekly",
		);
		expect(effectiveRunwayOutcome(outcome, NOW + 5 * HOUR).kind).toBe(
			"out-now",
		);
		// Untouched while the deadline is still ahead.
		expect(effectiveRunwayOutcome(outcome, NOW)).toBe(outcome);
	});
});

describe("runwayWindowLabel", () => {
	it("names the two account-wide windows", () => {
		expect(runwayWindowLabel("five_hour")).toBe("5-hour");
		expect(runwayWindowLabel("seven_day")).toBe("weekly");
	});

	it("falls back to a readable form of an unknown kind", () => {
		expect(runwayWindowLabel("some_other_window")).toBe("some other window");
	});
});

describe("describeRunwayCause", () => {
	it("names the account and window that ran out", () => {
		expect(
			describeRunwayCause(
				{
					kind: "out-now",
					causes: [{ accountId: "acc-2", windowKind: "seven_day" }],
					unprojectableAccountIds: [],
				},
				accounts,
				NOW,
			),
		).toBe("Backup weekly");
	});

	it("summarises ties instead of listing them", () => {
		expect(
			describeRunwayCause(
				{
					kind: "runway",
					exhaustsAtMs: NOW + HOUR,
					durationMs: HOUR,
					causes: [
						{ accountId: "acc-1", windowKind: "five_hour" },
						{ accountId: "acc-2", windowKind: "five_hour" },
						{ accountId: "acc-2", windowKind: "seven_day" },
					],
					unprojectableAccountIds: [],
				},
				accounts,
				NOW,
			),
		).toBe("Primary 5-hour +2 more");
	});

	it("falls back to the id when the account is gone", () => {
		expect(
			describeRunwayCause(
				{
					kind: "out-now",
					causes: [{ accountId: "acc-gone", windowKind: "five_hour" }],
					unprojectableAccountIds: [],
				},
				accounts,
				NOW,
			),
		).toBe("acc-gone 5-hour");
	});

	it("is null when the outcome names no cause", () => {
		expect(
			describeRunwayCause(
				{
					kind: "beyond-horizon",
					horizonMs: 14 * DAY,
					unprojectableAccountIds: [],
				},
				accounts,
				NOW,
			),
		).toBeNull();
		expect(describeRunwayCause({ kind: "unknown" }, accounts, NOW)).toBeNull();
	});
});

describe("runwayQualifier", () => {
	it("states what the infinity glyph actually checked", () => {
		expect(
			runwayQualifier(
				{
					kind: "beyond-horizon",
					horizonMs: 14 * DAY,
					unprojectableAccountIds: [],
				},
				NOW,
			),
		).toBe("no run-out within 14d");
	});

	it("counts the accounts the figure could not see", () => {
		expect(runwayQualifier(runwayOutcome(HOUR, ["a", "b"]), NOW)).toBe(
			"2 accounts unknown",
		);
	});

	it("combines both notes", () => {
		expect(
			runwayQualifier(
				{
					kind: "beyond-horizon",
					horizonMs: 14 * DAY,
					unprojectableAccountIds: ["a"],
				},
				NOW,
			),
		).toBe("no run-out within 14d · 1 account unknown");
	});

	it("is null when there is nothing to qualify", () => {
		expect(
			runwayQualifier(
				{
					kind: "out-now",
					causes: [],
					unprojectableAccountIds: [],
				},
				NOW,
			),
		).toBeNull();
	});
});
