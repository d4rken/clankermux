import { describe, expect, it } from "bun:test";
import type { AccountResponse } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { RateLimitInfo } from "./RateLimitInfo";

const NOW = 1_750_000_000_000;
const MIN = 60_000;

function makeAccount(
	overrides: Partial<AccountResponse> = {},
): AccountResponse {
	return {
		id: "a1",
		name: "acct",
		provider: "anthropic",
		paused: false,
		rateLimitStatus: "OK",
		rateLimitCause: "ok",
		rateLimitCauseResetMs: null,
		rateLimitProviderStatus: null,
		rateLimitReset: null,
		rateLimitRemaining: null,
		rateLimitedUntil: null,
		...overrides,
	} as AccountResponse;
}

function render(accounts: AccountResponse[]): string {
	return renderToStaticMarkup(<RateLimitInfo accounts={accounts} now={NOW} />);
}

describe("RateLimitInfo", () => {
	it("renders nothing when no account is limited", () => {
		expect(render([makeAccount()])).toBe("");
	});

	it("excludes PAUSED accounts even when their stored state looks limited", () => {
		const html = render([
			makeAccount({
				name: "paused-acct",
				paused: true,
				rateLimitStatus: "rate_limited (30m)",
				rateLimitCause: "rate_limited",
				rateLimitCauseResetMs: NOW + 30 * MIN,
			}),
		]);
		expect(html).toBe("");
	});

	it("counts the countdown from rateLimitCauseResetMs, not rateLimitReset", () => {
		const html = render([
			makeAccount({
				name: "exhausted",
				rateLimitStatus: "usage_exhausted (120m)",
				rateLimitCause: "usage_exhausted",
				rateLimitCauseResetMs: NOW + 120 * MIN,
				// The raw provider header disagrees — it must not drive the countdown.
				rateLimitReset: new Date(NOW + 5 * MIN).toISOString(),
			}),
		]);
		expect(html).toContain("Resets in 120m");
		expect(html).not.toContain("Resets in 5m");
	});

	it("colors a hard cause destructive and a soft cause warning", () => {
		const hard = render([
			makeAccount({
				name: "hard",
				rateLimitStatus: "usage_exhausted (10m)",
				rateLimitCause: "usage_exhausted",
				rateLimitCauseResetMs: NOW + 10 * MIN,
			}),
		]);
		expect(hard).toContain("bg-destructive/10");

		const soft = render([
			makeAccount({
				name: "soft",
				rateLimitStatus: "queueing_soft (10m)",
				rateLimitCause: "queueing_soft",
				rateLimitCauseResetMs: NOW + 10 * MIN,
			}),
		]);
		expect(soft).toContain("bg-warning/10");
	});

	it("falls back to the display string for legacy payloads without a cause", () => {
		const html = render([
			makeAccount({
				name: "legacy",
				rateLimitStatus: "rate_limited (30m)",
				rateLimitCause:
					undefined as unknown as AccountResponse["rateLimitCause"],
				rateLimitCauseResetMs: null,
				rateLimitReset: new Date(NOW + 30 * MIN).toISOString(),
			}),
		]);
		expect(html).toContain("legacy");
		expect(html).toContain("Resets in 30m");
	});
});
