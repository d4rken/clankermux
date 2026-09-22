import { describe, expect, it } from "bun:test";
import { computePoolUsage } from "@clankermux/core";
import type { AccountResponse } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { buildQuotaSummary } from "../../lib/quota-summary";
import { PoolQuotaCard } from "./PoolQuotaCard";

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

function weeklyAt(pct: number, resetMs: number) {
	return {
		seven_day: { utilization: pct, resets_at: new Date(resetMs).toISOString() },
	};
}

function bothAt(
	fiveHourPct: number,
	fiveHourResetMs: number | null,
	weeklyPct: number,
	weeklyResetMs: number | null,
) {
	return {
		five_hour: {
			utilization: fiveHourPct,
			resets_at:
				fiveHourResetMs == null
					? null
					: new Date(fiveHourResetMs).toISOString(),
		},
		seven_day: {
			utilization: weeklyPct,
			resets_at:
				weeklyResetMs == null ? null : new Date(weeklyResetMs).toISOString(),
		},
	};
}

function render(accounts: AccountResponse[]) {
	const result = computePoolUsage(accounts, "seven_day", NOW);
	const fiveHourResult = computePoolUsage(accounts, "five_hour", NOW);
	const dailyResult = computePoolUsage(accounts, "daily", NOW);
	const weekly = result.classes[0];
	if (!weekly) throw new Error("no class");
	const fiveHour = fiveHourResult.classes.find(
		(c) => c.classId === weekly.classId,
	);
	const daily = dailyResult.classes.find((c) => c.classId === weekly.classId);
	return renderToStaticMarkup(
		<PoolQuotaCard
			weekly={weekly}
			shortWindow={
				fiveHour
					? { pool: fiveHour, window: "five_hour" }
					: daily
						? { pool: daily, window: "daily" }
						: null
			}
			weeklyResult={result}
			summary={buildQuotaSummary(accounts, NOW)[0]}
			now={NOW}
		/>,
	);
}

describe("PoolQuotaCard unstarted and learning disclosure", () => {
	it("says the week has not started instead of falling silent", () => {
		// The provider reports `now + 7d` and re-stamps it every poll, so that
		// instant is excluded from the class's earliest reset upstream. Without
		// this the checkpoint line simply disappears.
		const html = render([
			account({
				usageAsOfIso: new Date(NOW).toISOString(),
				usageData: weeklyAt(0, NOW + 7 * DAY) as never,
			}),
		]);

		expect(html).toContain("not started; resets 7d after first use");
		// And the withheld projection is disclosed rather than reading as
		// "nothing is projected to run out".
		expect(html).toContain("1 not yet projectable");
	});

	it("keeps a started account's reset while naming the unstarted one", () => {
		const html = render([
			account({
				id: "acc-1",
				name: "alpha",
				usageAsOfIso: new Date(NOW).toISOString(),
				usageData: weeklyAt(30, NOW + 2 * DAY) as never,
			}),
			account({
				id: "acc-2",
				name: "beta",
				usageAsOfIso: new Date(NOW).toISOString(),
				usageData: weeklyAt(0, NOW + 7 * DAY) as never,
			}),
		]);

		expect(html).toContain("1 not started");
		expect(html).toContain("resets");
		expect(html).toContain("1 not yet projectable");
	});
});

describe("PoolQuotaCard at-risk row", () => {
	it("says 'account' when the class holds one", () => {
		// 90% used a day into a 7-day window: the projection lands well before
		// the reset, so this single account is the whole capacity AND the whole
		// forecast.
		const html = render([
			account({ usageData: weeklyAt(90, NOW + 6 * DAY) as never }),
		]);
		expect(html).toContain(
			"1 of 1 account projected to hit 100% before its own reset",
		);
	});

	it("says 'accounts' when the class holds more than one", () => {
		const html = render([
			account({ usageData: weeklyAt(90, NOW + 6 * DAY) as never }),
			account({
				id: "acc-2",
				name: "beta",
				usageData: weeklyAt(88, NOW + 6 * DAY) as never,
			}),
		]);
		expect(html).toContain(
			"2 of 2 accounts projected to hit 100% before their own reset",
		);
	});

	it("leaves a paused account out of the forecast", () => {
		// `exhausted` mixes quota exhaustion with paused/cooling/expired
		// accounts. A paused account is a choice someone made, not a projection,
		// and counting it made the badge claim a forecast it never computed.
		// 10% used one day into the window projects out at day 10, past the
		// reset — so nothing here is at risk and the row must not appear at all.
		const html = render([
			account({ usageData: weeklyAt(10, NOW + 6 * DAY) as never }),
			account({ id: "acc-2", name: "beta", paused: true }),
		]);
		expect(html).not.toContain("projected to hit 100% before");
	});

	it("states the reporting coverage when an account has no reading", () => {
		const html = render([
			account({ usageData: weeklyAt(10, NOW + 6 * DAY) as never }),
			account({ id: "acc-2", name: "beta" }),
		]);
		expect(html).toContain("1 of 2 accounts reporting");
	});
});

describe("PoolQuotaCard pace", () => {
	it("measures the pace against the WEEKLY window the headline states", () => {
		// Halfway through the weekly window at 75%: an even burn would be at 50%,
		// so this is 1.5x sustainable. The 5-hour window is deliberately at a
		// different multiple (20% halfway through is 0.4x), so a row computed off
		// it would state a visibly different figure than the headline it sits
		// under.
		const html = render([
			account({
				usageData: bothAt(20, NOW + 2.5 * HOUR, 75, NOW + 3.5 * DAY) as never,
			}),
		]);

		expect(html).toContain("pace 1.5× sustainable pace");
		expect(html).toContain("5h: 20% used");
	});

	it("says nothing about pace without a weekly reset to measure against", () => {
		// The window's start is derived from its reset, so no weekly reset means
		// no weekly window to be on pace through — and a live 5-hour reset is not
		// a substitute, because it paces a different budget.
		const html = render([
			account({ usageData: bothAt(75, NOW + 2.5 * HOUR, 20, null) as never }),
		]);

		expect(html).toContain("5h: 75% used");
		expect(html).not.toContain("sustainable pace");
	});

	it("keeps speaking when one account's window is too young to divide by", () => {
		// Two accounts halfway through their week at 75% are 1.5x each. The third
		// reset an hour ago, so an even burn expects 0.6% of its window — under
		// the floor, and the only account that cannot be measured. Averaging into
		// null hid both good readings behind it.
		const html = render([
			account({
				usageData: weeklyAt(75, NOW + 3.5 * DAY) as never,
			}),
			account({
				id: "acc-2",
				name: "beta",
				usageData: weeklyAt(75, NOW + 3.5 * DAY) as never,
			}),
			account({
				id: "acc-3",
				name: "gamma",
				usageData: weeklyAt(0, NOW + 7 * DAY - HOUR) as never,
			}),
		]);

		expect(html).toContain("Average pace 1.5× sustainable pace");
		expect(html).toContain("2 of 3 accounts");
	});

	it("states no coverage when every account is in the average", () => {
		const html = render([
			account({ usageData: weeklyAt(75, NOW + 3.5 * DAY) as never }),
			account({
				id: "acc-2",
				name: "beta",
				usageData: weeklyAt(25, NOW + 3.5 * DAY) as never,
			}),
		]);

		expect(html).toContain("Average pace 1.0× sustainable pace");
		expect(html).not.toContain("· 2 of 2 accounts");
	});

	it("leaves an unstarted window out of the average rather than pacing a placeholder", () => {
		// `now + 7d` is re-stamped on every poll, so it is not a deadline. The
		// measured account must be the whole average, and the coverage has to say
		// so — a silently-included placeholder would read as a second data point.
		const html = render([
			account({ usageData: weeklyAt(75, NOW + 3.5 * DAY) as never }),
			account({
				id: "acc-2",
				name: "beta",
				usageAsOfIso: new Date(NOW).toISOString(),
				usageData: weeklyAt(0, NOW + 7 * DAY) as never,
			}),
		]);

		expect(html).toContain("Average pace 1.5× sustainable pace");
		expect(html).toContain("1 of 2 accounts");
	});

	it("still says nothing when no account can be measured at all", () => {
		const html = render([
			account({ usageData: weeklyAt(0, NOW + 7 * DAY - HOUR) as never }),
			account({
				id: "acc-2",
				name: "beta",
				usageData: weeklyAt(1, NOW + 7 * DAY - HOUR) as never,
			}),
		]);

		expect(html).not.toContain("sustainable pace");
	});
});

describe("PoolQuotaCard quota used", () => {
	it("averages all accounts, including a five-hour block, without naming the lowest", () => {
		const accounts = [
			account({
				name: "Claud1",
				usageData: bothAt(100, NOW + HOUR, 20, NOW + DAY) as never,
			}),
			account({
				id: "acc-2",
				name: "Claud2",
				usageData: bothAt(10, NOW + HOUR, 80, NOW + DAY) as never,
			}),
		];
		const html = render(accounts);
		expect(html).toContain("50% used");
		expect(html).toContain("Weekly · account average");
		expect(html).not.toContain("lowest");
		expect(html).toContain("Claud1: 20% used · 5h limit reached");
		expect(html).toContain("1/2 available");
		expect(render(accounts.map((a) => ({ ...a, paused: true })))).toContain(
			"50% used",
		);
	});
	it("does not shrink the average's denominator when a reading is missing", () => {
		const html = render([
			account({ usageData: weeklyAt(20, NOW + DAY) as never }),
			account({ id: "acc-2", name: "Claud2" }),
		]);
		expect(html).toContain("Weekly quota incomplete");
		expect(html).not.toContain(">20% used</p>");
		expect(html).toContain("1 of 2 accounts reporting");
	});
});

describe("PoolQuotaCard short window", () => {
	it("names the 5-hour window on a provider that runs one", () => {
		expect(
			render([account({ usageData: bothAt(30, NOW + HOUR, 60, NOW + DAY) })]),
		).toContain("5h: 30% used · account average");
	});

	it("names Devin's 24-hour window rather than calling it 5h", () => {
		const html = render([
			account({
				id: "devin-1",
				name: "Devin-1",
				provider: "devin",
				usageData: {
					kind: "devin",
					quotaBased: true,
					daily: { utilization: 40, resetAt: NOW + 6 * HOUR },
					weekly: { utilization: 65, resetAt: NOW + 3 * DAY },
					planName: "Team",
					email: null,
					accountId: null,
				} as never,
			}),
		]);
		expect(html).toContain("65% used");
		expect(html).toContain("24h: 40% used · account average");
		expect(html).not.toContain("5h:");
	});
});

describe("PoolQuotaCard capacity claims", () => {
	it("says capacity is unknown rather than that nothing can serve", () => {
		// The account is configured and not paused; its weekly window simply has
		// no reading. "No account can serve this" asserts an inability nothing
		// here established — it may well be serving right now.
		const html = render([account({ usageData: undefined })]);
		expect(html).toContain("Capacity unknown");
		expect(html).not.toContain("No account can serve this");
	});

	it("claims no inability when the readings are spent rather than absent", () => {
		// Two spent accounts are capacity, not a gap, so neither badge applies —
		// the at-risk line above already states what happened to them.
		const html = render([
			account({ usageData: weeklyAt(100, NOW + DAY) as never }),
			account({
				id: "acc-2",
				name: "beta",
				usageData: weeklyAt(100, NOW + DAY) as never,
			}),
		]);
		expect(html).not.toContain("No account can serve this");
		expect(html).not.toContain("Capacity unknown");
		expect(html).toContain("2 of 2 accounts spent or projected");
	});
});
