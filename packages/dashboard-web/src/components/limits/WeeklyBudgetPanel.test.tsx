import { describe, expect, it } from "bun:test";
import { computePacingFromAccounts, computePoolUsage } from "@clankermux/core";
import type { AccountResponse } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { buildQuotaSummary } from "../../lib/quota-summary";
import { WeeklyBudgetPanel } from "./WeeklyBudgetPanel";

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function account(over: Partial<AccountResponse> = {}): AccountResponse {
	return {
		id: "acc-1",
		name: "alpha",
		provider: "anthropic",
		paused: false,
		rateLimitCause: "ok",
		rateLimitedUntil: null,
		tokenExpiresAt: null,
		hasRefreshToken: false,
		usageRateLimitedUntil: null,
		usageData: null,
		...over,
	} as unknown as AccountResponse;
}

function render(accounts: AccountResponse[]) {
	return renderToStaticMarkup(
		<WeeklyBudgetPanel
			pacing={computePacingFromAccounts(accounts, NOW)}
			sevenDay={computePoolUsage(accounts, "seven_day", NOW)}
			summaryRows={buildQuotaSummary(accounts, NOW)}
			now={NOW}
			loading={false}
		/>,
	);
}

/**
 * The badge sits behind `willRunOutCapacity === 0`, which counts contributors
 * plus accounts spent on the weekly window — so it is reached both by a class
 * held out for known reasons and by one whose readings never arrived.
 */
describe("WeeklyBudgetPanel zero-capacity badge", () => {
	it("does not claim inability while any account's window went unread", () => {
		// One cooling down, one never polled. The unread account may be serving
		// right now, so "no account can serve this" is not established.
		const html = render([
			account({
				id: "acc-1",
				name: "alpha",
				rateLimitCause: "rate_limited",
				rateLimitedUntil: NOW + HOUR,
			}),
			account({ id: "acc-2", name: "beta" }),
		]);
		expect(html).toContain("Capacity unknown");
		expect(html).not.toContain("No account can serve this");
	});

	it("claims it once the only account is held out for a stated reason", () => {
		// One account, cooling down, with weekly quota still on it. Nothing is
		// unknown here: it cannot serve right now and the badge may say so.
		const html = render([
			account({
				rateLimitCause: "rate_limited",
				rateLimitedUntil: NOW + HOUR,
				usageData: {
					seven_day: {
						utilization: 40,
						resets_at: new Date(NOW + 3 * DAY).toISOString(),
					},
				},
			}),
		]);
		expect(html).toContain("No account can serve this");
		expect(html).not.toContain("Capacity unknown");
	});
});

function weeklyAt(pct: number, resetMs: number) {
	return {
		seven_day: { utilization: pct, resets_at: new Date(resetMs).toISOString() },
	} as never;
}

describe("WeeklyBudgetPanel pace", () => {
	it("names the least-used account when that account has a ratio", () => {
		// Halfway through the week: an even burn is at 50%, so 25% is 0.5x.
		const html = render([
			account({ usageData: weeklyAt(25, NOW + 3.5 * DAY) }),
			account({
				id: "acc-2",
				name: "beta",
				usageData: weeklyAt(75, NOW + 3.5 * DAY),
			}),
		]);
		expect(html).toContain("alpha: 0.5× sustainable pace");
	});

	it("falls back to the pooled average when the least-used account is fresh", () => {
		// `gamma` reset an hour ago at 0%, so it is the least-used account AND the
		// one with no honest ratio. Keyed on it alone the class reported nothing
		// while two accounts sat measurably over pace.
		const html = render([
			account({ usageData: weeklyAt(75, NOW + 3.5 * DAY) }),
			account({
				id: "acc-2",
				name: "beta",
				usageData: weeklyAt(75, NOW + 3.5 * DAY),
			}),
			account({
				id: "acc-3",
				name: "gamma",
				usageData: weeklyAt(0, NOW + 7 * DAY - HOUR),
			}),
		]);
		expect(html).toContain("2 of 3 accounts: 1.5× sustainable pace");
		// The fallback must not borrow the keyed line's subject: the average
		// describes two accounts, and `gamma` is the one it could not measure.
		expect(html).not.toContain("gamma: ");
	});

	it("says nothing when neither the account nor the pool can be measured", () => {
		const html = render([
			account({ usageData: weeklyAt(0, NOW + 7 * DAY - HOUR) }),
		]);
		expect(html).not.toContain("sustainable pace");
	});

	it("counts a spent account, which burned the most of anyone", () => {
		// Halfway through the week an even burn is at 50%, so 25% is 0.5x and
		// 100% is 2.0x — a 1.25x average. The spent account draws no bar and its
		// `pct` reads null for that reason; measuring the class's burn from the
		// bar instead of the reading dropped it and reported a reassuring 0.5x.
		const html = render([
			account({
				id: "acc-fresh",
				name: "fresh",
				usageData: weeklyAt(0, NOW + 7 * DAY - HOUR),
			}),
			account({
				id: "acc-mid",
				name: "mid",
				usageData: weeklyAt(25, NOW + 3.5 * DAY),
			}),
			account({
				id: "acc-spent",
				name: "spent",
				usageData: weeklyAt(100, NOW + 3.5 * DAY),
			}),
		]);
		expect(html).toContain("2 of 3 accounts: 1.3× sustainable pace");
	});

	it("does not pace a stale unstarted placeholder as a real window", () => {
		// `stale` is untouched and was last read two hours ago, so its placeholder
		// window looks two hours old — far enough in to clear the expected-percent
		// floor. Keyed on it the class would report 0x and suppress the pooled
		// figure that has the real answer.
		const html = render([
			account({
				id: "acc-stale",
				name: "stale",
				usageAsOfIso: new Date(NOW - 2 * HOUR).toISOString(),
				usageData: weeklyAt(0, NOW - 2 * HOUR + 7 * DAY),
			}),
			account({
				id: "acc-hot",
				name: "hot",
				usageData: weeklyAt(75, NOW + 3.5 * DAY),
			}),
		]);
		expect(html).not.toContain("stale: 0.0× sustainable pace");
		expect(html).toContain("1 of 2 accounts: 1.5× sustainable pace");
	});
});
