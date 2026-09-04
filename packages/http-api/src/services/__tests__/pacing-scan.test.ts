import { describe, expect, it } from "bun:test";
import { computePacingFromAccounts } from "@clankermux/core";
import type { AccountResponse } from "@clankermux/types";

/**
 * The pacing scan, over fixture accounts.
 *
 * Drives `computePacingFromAccounts` rather than the DB-backed entry point: the
 * arithmetic is what this suite is about, and standing up an account query to
 * reach it would test the query instead.
 */

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function account(over: Partial<AccountResponse> = {}): AccountResponse {
	return {
		id: "acct-1",
		name: "alpha",
		provider: "anthropic",
		paused: false,
		rateLimitedUntil: null,
		tokenExpiresAt: null,
		hasRefreshToken: true,
		usageRateLimitedUntil: null,
		usageData: null,
		...over,
	} as unknown as AccountResponse;
}

/** An Anthropic-style payload with both account-wide windows. */
function usage(
	fiveHourPct: number | null,
	sevenDayPct: number | null,
	over: {
		fiveHourResetMs?: number | null;
		sevenDayResetMs?: number | null;
	} = {},
) {
	const fiveHourResetMs =
		over.fiveHourResetMs === undefined ? NOW + 2 * HOUR : over.fiveHourResetMs;
	const sevenDayResetMs =
		over.sevenDayResetMs === undefined ? NOW + 3 * DAY : over.sevenDayResetMs;
	return {
		five_hour: {
			utilization: fiveHourPct,
			resets_at:
				fiveHourResetMs == null
					? null
					: new Date(fiveHourResetMs).toISOString(),
		},
		seven_day: {
			utilization: sevenDayPct,
			resets_at:
				sevenDayResetMs == null
					? null
					: new Date(sevenDayResetMs).toISOString(),
		},
	} as never;
}

describe("computePacingFromAccounts", () => {
	it("keys each class's figures on its LEAST-USED account", () => {
		// The class's real headroom, because routing picks one account and the pool
		// keeps serving until every account is spent. A mean of 20 and 80 would
		// describe neither account.
		const pacing = computePacingFromAccounts(
			[
				account({ id: "a", name: "alpha", usageData: usage(0, 80) }),
				account({ id: "b", name: "beta", usageData: usage(0, 20) }),
			],
			NOW,
		);

		const claude = pacing.classes.find((c) => c.classId === "anthropic");
		expect(claude?.utilizationPct).toBe(20);
		expect(claude?.leastUsedAccountId).toBe("b");
		expect(claude?.leastUsedAccountName).toBe("beta");
	});

	it("computes the burn against the same account the percentage names", () => {
		// beta is 20% used with 3 days left of a 7-day window, so 4/7 = 57.1% has
		// elapsed and the burn reads well under sustainable. Computed over alpha it
		// would read over — which is exactly the mismatch that made the dashboard
		// print one account's ratio beside another account's name.
		const pacing = computePacingFromAccounts(
			[
				account({ id: "a", name: "alpha", usageData: usage(0, 80) }),
				account({ id: "b", name: "beta", usageData: usage(0, 20) }),
			],
			NOW,
		);

		const claude = pacing.classes.find((c) => c.classId === "anthropic");
		expect(claude?.burn?.ratio).toBeCloseTo(20 / 57.142_857, 2);
		expect(claude?.burnTone).toBe("success");
	});

	it("withholds the burn rather than inventing one early in a window", () => {
		// A window minutes old expects ~0.05%, so one percent of real usage reads
		// as 20x sustainable. Arithmetically true and useless.
		const pacing = computePacingFromAccounts(
			[
				account({
					id: "a",
					usageData: usage(0, 1, { sevenDayResetMs: NOW + 7 * DAY - HOUR }),
				}),
			],
			NOW,
		);

		expect(pacing.classes[0]?.burn).toBeNull();
		expect(pacing.classes[0]?.burnTone).toBeNull();
	});

	it("splits already-spent accounts out of the projected count", () => {
		// An account at 100% is not "projected" to reach it. The two halves carry
		// different verbs on every surface that renders them.
		const pacing = computePacingFromAccounts(
			[
				account({ id: "a", name: "alpha", usageData: usage(0, 100) }),
				account({ id: "b", name: "beta", usageData: usage(0, 95) }),
			],
			NOW,
		);

		const claude = pacing.classes.find((c) => c.classId === "anthropic");
		expect(claude?.alreadySpent).toBe(1);
		expect(claude?.willRunOut).toBeGreaterThanOrEqual(1);
	});

	it("names the earliest-resetting account by id as well as by name", () => {
		// The id is what a published surface joins on; the name is what the
		// dashboard renders. Both come from the same account or the two disagree.
		const pacing = computePacingFromAccounts(
			[
				account({
					id: "a",
					name: "alpha",
					usageData: usage(0, 50, { sevenDayResetMs: NOW + 5 * DAY }),
				}),
				account({
					id: "b",
					name: "beta",
					usageData: usage(0, 60, { sevenDayResetMs: NOW + 1 * DAY }),
				}),
			],
			NOW,
		);

		const claude = pacing.classes.find((c) => c.classId === "anthropic");
		expect(claude?.earliestResetAccountId).toBe("b");
		expect(claude?.earliestResetAccountName).toBe("beta");
	});

	it("reads a Codex class as 5-hour unread rather than out of room", () => {
		// Codex reports no 5-hour window at all. Zero-with-room is a measured
		// absence of capacity; this is an absent measurement, and the pool verdict
		// must not go green on the strength of the sibling class.
		const pacing = computePacingFromAccounts(
			[
				account({ id: "a", name: "alpha", usageData: usage(10, 20) }),
				account({
					id: "c",
					name: "gamma",
					provider: "codex",
					usageData: usage(null, 40),
				}),
			],
			NOW,
		);

		const codex = pacing.fiveHour.classes.find((c) => c.classId === "codex");
		expect(codex?.unknown).toBe(1);
		expect(codex?.room).toBe(0);
		expect(pacing.fiveHour.outlook).toEqual({
			label: "Partial",
			tone: "neutral",
		});
	});

	it("names the tightest class as binding", () => {
		// Tightest = the class whose least-used account sits highest, since that is
		// the one that stops you first. A Claude request cannot be served by a
		// Codex account, so a figure spanning both describes no decision.
		const pacing = computePacingFromAccounts(
			[
				account({ id: "a", name: "alpha", usageData: usage(0, 20) }),
				account({
					id: "c",
					name: "gamma",
					provider: "codex",
					usageData: usage(null, 62),
				}),
			],
			NOW,
		);

		expect(pacing.bindingClassId).toBe("codex");
	});
});
