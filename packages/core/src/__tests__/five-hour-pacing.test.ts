import { describe, expect, it } from "bun:test";
import type { AccountResponse } from "@clankermux/types";
import { computeFiveHourPacing } from "../five-hour-pacing";
import { computePoolUsage } from "../pool-usage";

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function account(over: Partial<AccountResponse> = {}): AccountResponse {
	return {
		id: "acc-1",
		name: "alpha",
		provider: "anthropic",
		paused: false,
		rateLimitedUntil: null,
		tokenExpiresAt: null,
		hasRefreshToken: false,
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
		over.sevenDayResetMs === undefined ? NOW + 6 * DAY : over.sevenDayResetMs;
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

function pacingFor(accounts: AccountResponse[], now = NOW) {
	return computeFiveHourPacing(
		computePoolUsage(accounts, "five_hour", now),
		computePoolUsage(accounts, "seven_day", now),
		now,
	);
}

describe("computeFiveHourPacing", () => {
	it("counts a 5h-spent account as waiting and names its lift", () => {
		const pacing = pacingFor([
			account({ id: "a", name: "alpha", usageData: usage(100, 20) }),
			account({ id: "b", name: "beta", usageData: usage(30, 20) }),
			account({
				id: "c",
				name: "gamma",
				provider: "codex",
				usageData: usage(10, 20),
			}),
		]);

		expect(pacing.waiting).toBe(1);
		expect(pacing.nextLiftMs).toBe(NOW + 2 * HOUR);
		expect(pacing.nextLiftAccountName).toBe("alpha");
		const claude = pacing.classes.find((c) => c.classId === "anthropic");
		expect(claude?.waiting).toBe(1);
		expect(claude?.room).toBe(1);
		// A sibling can still serve, so this is pacing rather than a dead end.
		expect(claude?.noPath).toBe(false);
		expect(pacing.outlook).toEqual({ label: "Pacing", tone: "warning" });
	});

	it("flags a single-account class with nothing left as noPath", () => {
		const pacing = pacingFor([
			account({ id: "a", name: "alpha", usageData: usage(100, 20) }),
		]);

		const claude = pacing.classes.find((c) => c.classId === "anthropic");
		expect(claude?.noPath).toBe(true);
		expect(pacing.outlook).toEqual({ label: "Paced", tone: "destructive" });
	});

	it("counts a reporting account projected past its 5h limit as running hot", () => {
		// 90% used with one hour of a five-hour window left: 22.5%/h over the four
		// hours elapsed puts the run-out ~27 minutes out, comfortably before the
		// reset — so this account is heading for the limit while still serving.
		const pacing = pacingFor([
			account({
				id: "a",
				name: "alpha",
				usageData: usage(90, 20, { fiveHourResetMs: NOW + HOUR }),
			}),
		]);

		expect(pacing.runningHot).toBe(1);
		expect(pacing.room).toBe(1);
		expect(pacing.waiting).toBe(0);
		expect(pacing.outlook).toEqual({ label: "Pacing", tone: "warning" });
	});

	it("counts a provider with no 5-hour window as unknown, never as room", () => {
		const pacing = pacingFor([
			account({ id: "a", name: "alpha", usageData: usage(20, 20) }),
			account({
				id: "c",
				name: "gamma",
				provider: "codex",
				usageData: usage(null, 40),
			}),
		]);

		const codex = pacing.classes.find((c) => c.classId === "codex");
		expect(codex?.unknown).toBe(1);
		expect(codex?.room).toBe(0);
		expect(codex?.waiting).toBe(0);
		// NOT "Clear", which is what this asserted while the unread-class rule was
		// only applied pool-wide. The clean class is still clean and the row for it
		// still says so; what may not happen is the SUMMARY chip claiming the pool
		// is clear on the strength of it, because the codex class beside it has no
		// 5-hour reading whatsoever. Neutral, not a warning: an absent measurement
		// is not evidence of trouble, only the absence of evidence of health — and
		// with a Codex account in the pool this is the permanent state.
		expect(pacing.outlook).toEqual({ label: "Partial", tone: "neutral" });
	});

	it("keeps Clear when every class has a reading", () => {
		// The counterpart to the case above, pinning that "Partial" is caused by an
		// UNREAD class and not merely by having more than one class.
		const pacing = pacingFor([
			account({ id: "a", name: "alpha", usageData: usage(20, 20) }),
			account({
				id: "c",
				name: "gamma",
				provider: "codex",
				usageData: usage(10, 40),
			}),
		]);

		// The codex class must actually BE here: `every` over a list that lost it
		// is vacuously true, so without this the test would keep passing if the
		// second class stopped being built at all.
		expect(pacing.classes.map((c) => c.classId).sort()).toEqual([
			"anthropic",
			"codex",
		]);
		expect(pacing.classes.every((c) => c.unknown === 0)).toBe(true);
		expect(pacing.outlook).toEqual({ label: "Clear", tone: "success" });
	});

	it("does not call a class read because its other account is paused", () => {
		// A paused account is classified BEFORE usage extraction and stored with
		// `pct: null`, so it contributes no 5-hour reading — knowing why it cannot
		// serve says nothing about the class's pacing. While `classIsUnread` also
		// required `unavailable === 0`, this class passed as read and the anthropic
		// class's room carried the whole panel to green.
		const pacing = pacingFor([
			account({ id: "a", name: "alpha", usageData: usage(20, 20) }),
			account({
				id: "c",
				name: "gamma",
				provider: "codex",
				usageData: usage(null, 40),
			}),
			account({
				id: "d",
				name: "delta",
				provider: "codex",
				paused: true,
			}),
		]);

		const codex = pacing.classes.find((c) => c.classId === "codex");
		expect(codex?.unknown).toBe(1);
		expect(codex?.unavailable).toBe(1);
		expect(codex?.room).toBe(0);
		expect(pacing.outlook).toEqual({ label: "Partial", tone: "neutral" });
	});

	it("ranks an actively-paced class above an unread one", () => {
		// Pins the PRECEDENCE, which the cases above cannot: each of them has only
		// one candidate branch. Here both apply at once — the anthropic class is
		// holding an account on the 5-hour limit while the codex class has no
		// reading — and the warning must win, because a known limiting condition
		// outranks missing coverage. Without this, moving the "Partial" branch
		// above "Pacing" would leave every other test passing.
		const pacing = pacingFor([
			account({
				id: "a",
				name: "alpha",
				usageData: usage(100, 20, { fiveHourResetMs: NOW + HOUR }),
			}),
			account({ id: "b", name: "beta", usageData: usage(20, 20) }),
			account({
				id: "c",
				name: "gamma",
				provider: "codex",
				usageData: usage(null, 40),
			}),
		]);

		expect(pacing.waiting).toBe(1);
		expect(pacing.classes.find((c) => c.classId === "codex")?.unknown).toBe(1);
		expect(pacing.outlook).toEqual({ label: "Pacing", tone: "warning" });
	});

	it("says Clear when nothing is waiting or running hot", () => {
		const pacing = pacingFor([
			account({ id: "a", name: "alpha", usageData: usage(5, 5) }),
			account({ id: "b", name: "beta", usageData: usage(10, 5) }),
		]);

		expect(pacing.waiting).toBe(0);
		expect(pacing.runningHot).toBe(0);
		expect(pacing.nextLiftMs).toBeNull();
		expect(pacing.outlook).toEqual({ label: "Clear", tone: "success" });
	});

	it("does not offer a reset already in the past as the next lift", () => {
		const pacing = pacingFor([
			account({
				id: "a",
				name: "alpha",
				usageData: usage(100, 20, { fiveHourResetMs: NOW - HOUR }),
			}),
			account({ id: "b", name: "beta", usageData: usage(20, 20) }),
		]);

		expect(pacing.waiting).toBe(1);
		expect(pacing.nextLiftMs).toBeNull();
		expect(pacing.nextLiftAccountName).toBeNull();
	});

	it("treats an account spent on both windows as unavailable, not waiting", () => {
		// The 5-hour lift gives this account nothing: its weekly quota is gone
		// either way. Counting it as waiting would promise capacity in two hours
		// that does not arrive until the weekly reset.
		const pacing = pacingFor([
			account({ id: "a", name: "alpha", usageData: usage(100, 100) }),
			account({ id: "b", name: "beta", usageData: usage(20, 20) }),
		]);

		const claude = pacing.classes.find((c) => c.classId === "anthropic");
		expect(claude?.waiting).toBe(0);
		expect(claude?.unavailable).toBe(1);
		expect(pacing.nextLiftMs).toBeNull();
		expect(pacing.outlook).toEqual({ label: "Clear", tone: "success" });
	});
});
