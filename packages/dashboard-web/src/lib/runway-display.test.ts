import { describe, expect, it } from "bun:test";
import type { RunwayOutcome } from "@clankermux/core";
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

const accounts = [
	{ id: "acc-1", name: "Primary" },
	{ id: "acc-2", name: "Backup" },
];

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
			{
				kind: "runway",
				exhaustsAtMs: 1,
				durationMs: HOUR,
				causes: [],
				unprojectableAccountIds: [],
			},
		];
		for (const outcome of statable) {
			expect(runwayUnavailableReason(outcome)).toBeNull();
		}
	});
});

describe("formatRunwayValue", () => {
	it("renders an infinity glyph beyond the horizon", () => {
		expect(
			formatRunwayValue({
				kind: "beyond-horizon",
				horizonMs: 14 * DAY,
				unprojectableAccountIds: [],
			}),
		).toBe(BEYOND_HORIZON_GLYPH);
	});

	it("says out of quota rather than showing a zero", () => {
		expect(
			formatRunwayValue({
				kind: "out-now",
				causes: [],
				unprojectableAccountIds: [],
			}),
		).toBe("Out of quota");
	});

	it("marks a figure computed without every account as a lower bound", () => {
		expect(
			formatRunwayValue({
				kind: "runway",
				exhaustsAtMs: 1,
				durationMs: 3 * DAY + 2 * HOUR,
				causes: [],
				unprojectableAccountIds: ["acc-9"],
			}),
		).toBe("≥ 3d 2h");
	});

	it("states a complete figure plainly", () => {
		expect(
			formatRunwayValue({
				kind: "runway",
				exhaustsAtMs: 1,
				durationMs: 3 * DAY + 2 * HOUR,
				causes: [],
				unprojectableAccountIds: [],
			}),
		).toBe("3d 2h");
	});

	it("has no figure for the unavailable outcomes", () => {
		expect(formatRunwayValue({ kind: "unknown" })).toBeNull();
		expect(formatRunwayValue({ kind: "no-accounts" })).toBeNull();
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
			),
		).toBe("Backup weekly");
	});

	it("summarises ties instead of listing them", () => {
		expect(
			describeRunwayCause(
				{
					kind: "runway",
					exhaustsAtMs: 1,
					durationMs: HOUR,
					causes: [
						{ accountId: "acc-1", windowKind: "five_hour" },
						{ accountId: "acc-2", windowKind: "five_hour" },
						{ accountId: "acc-2", windowKind: "seven_day" },
					],
					unprojectableAccountIds: [],
				},
				accounts,
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
			),
		).toBeNull();
		expect(describeRunwayCause({ kind: "unknown" }, accounts)).toBeNull();
	});
});

describe("runwayQualifier", () => {
	it("states what the infinity glyph actually checked", () => {
		expect(
			runwayQualifier({
				kind: "beyond-horizon",
				horizonMs: 14 * DAY,
				unprojectableAccountIds: [],
			}),
		).toBe("no run-out within 14d");
	});

	it("counts the accounts the figure could not see", () => {
		expect(
			runwayQualifier({
				kind: "runway",
				exhaustsAtMs: 1,
				durationMs: HOUR,
				causes: [],
				unprojectableAccountIds: ["a", "b"],
			}),
		).toBe("2 accounts unknown");
	});

	it("combines both notes", () => {
		expect(
			runwayQualifier({
				kind: "beyond-horizon",
				horizonMs: 14 * DAY,
				unprojectableAccountIds: ["a"],
			}),
		).toBe("no run-out within 14d · 1 account unknown");
	});

	it("is null when there is nothing to qualify", () => {
		expect(
			runwayQualifier({
				kind: "out-now",
				causes: [],
				unprojectableAccountIds: [],
			}),
		).toBeNull();
	});
});
