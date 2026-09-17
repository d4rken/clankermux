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
