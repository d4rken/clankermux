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

function render(accounts: AccountResponse[]) {
	const result = computePoolUsage(accounts, "seven_day", NOW);
	const weekly = result.classes[0];
	if (!weekly) throw new Error("no class");
	return renderToStaticMarkup(
		<PoolQuotaCard weekly={weekly} fiveHour={null} weeklyResult={result} />,
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
