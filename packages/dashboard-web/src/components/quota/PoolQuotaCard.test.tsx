import { describe, expect, it } from "bun:test";
import { computePoolUsage } from "@clankermux/core";
import type { AccountResponse } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
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
	const weekly = result.classes[0];
	if (!weekly) throw new Error("no class");
	return renderToStaticMarkup(
		<PoolQuotaCard
			weekly={weekly}
			fiveHour={
				fiveHourResult.classes.find((c) => c.classId === weekly.classId) ?? null
			}
			weeklyResult={result}
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
		expect(html).toContain("5h pace: 20% used");
	});

	it("says nothing about pace without a weekly reset to measure against", () => {
		// The window's start is derived from its reset, so no weekly reset means
		// no weekly window to be on pace through — and a live 5-hour reset is not
		// a substitute, because it paces a different budget.
		const html = render([
			account({ usageData: bothAt(75, NOW + 2.5 * HOUR, 20, null) as never }),
		]);

		expect(html).toContain("5h pace: 75% used");
		expect(html).not.toContain("sustainable pace");
	});
});
