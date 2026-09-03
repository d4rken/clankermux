import { describe, expect, it } from "bun:test";
import type { AccountResponse } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { computePoolUsage } from "../../lib/pool-usage";
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
	weeklyResetMs: number,
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
			resets_at: new Date(weeklyResetMs).toISOString(),
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

describe("PoolQuotaCard at-risk row", () => {
	it("says 'account' when the class holds one", () => {
		// 90% used a day into a 7-day window: the projection lands well before
		// the reset, so this single account is the whole capacity AND the whole
		// forecast.
		const html = render([
			account({ usageData: weeklyAt(90, NOW + 6 * DAY) as never }),
		]);
		expect(html).toContain("1 of 1 account projected to run out before reset");
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
		expect(html).toContain("2 of 2 accounts projected to run out before reset");
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
		expect(html).not.toContain("projected to run out before reset");
	});

	it("states the reporting coverage when an account has no reading", () => {
		const html = render([
			account({ usageData: weeklyAt(10, NOW + 6 * DAY) as never }),
			account({ id: "acc-2", name: "beta" }),
		]);
		expect(html).toContain("1 of 2 accounts reporting");
	});
});

describe("PoolQuotaCard 5-hour pace", () => {
	it("states the burn against the sustainable pace", () => {
		// Halfway through a five-hour window at 75%: an even burn would be at
		// 50%, so this is 1.5x sustainable.
		const html = render([
			account({
				usageData: bothAt(75, NOW + 2.5 * HOUR, 20, NOW + 6 * DAY) as never,
			}),
		]);

		expect(html).toContain("pace 1.5× sustainable pace");
	});

	it("says nothing about pace without a reset to measure against", () => {
		// The window's start is derived from its reset, so no reset means no
		// window to be on pace through.
		const html = render([
			account({ usageData: bothAt(75, null, 20, NOW + 6 * DAY) as never }),
		]);

		expect(html).toContain("5h pace: 75% used");
		expect(html).not.toContain("sustainable pace");
	});
});
