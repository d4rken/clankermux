import { describe, expect, it } from "bun:test";
import type {
	AccountResponse,
	CodexResetCreditEventResponse,
} from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { deriveAccountStatus } from "../../lib/account-status";
import {
	AccountStatusChips,
	ResetCreditEventsPanel,
} from "./AccountStatusChips";

// 2024-01-03 noon UTC, matching account-status.test.ts. Off-peak for anthropic.
const NOW = Date.UTC(2024, 0, 3, 12, 0, 0);

function makeAccount(
	overrides: Partial<AccountResponse> = {},
): AccountResponse {
	return {
		id: "a1",
		name: "acct",
		provider: "openai-compatible",
		requestCount: 0,
		totalRequests: 0,
		lastUsed: null,
		created: "2024-01-01T00:00:00Z",
		paused: false,
		tokenStatus: "valid",
		tokenExpiresAt: null,
		rateLimitStatus: "OK",
		rateLimitReset: null,
		rateLimitRemaining: null,
		rateLimitedUntil: null,
		rateLimitedReason: null,
		rateLimitedAt: null,
		sessionInfo: "No active session",
		priority: 0,
		autoFallbackEnabled: false,
		autoRefreshEnabled: false,
		customEndpoint: null,
		modelMappings: null,
		usageUtilization: null,
		usageWindow: null,
		usageData: null,
		usageRateLimitedUntil: null,
		usageThrottledUntil: null,
		usageThrottledWindows: [],
		hasRefreshToken: false,
		sessionStats: null,
		isPrimary: false,
		autoPauseOnOverageEnabled: false,
		peakHoursPauseEnabled: false,
		providerOverloadKey: null,
		providerOverloadedUntil: null,
		modelFallbacks: null,
		billingType: null,
		renewalAnchor: null,
		renewalCadence: null,
		...overrides,
	};
}

function render(account: AccountResponse): string {
	return renderToStaticMarkup(
		<AccountStatusChips
			account={account}
			status={deriveAccountStatus(account, NOW)}
		/>,
	);
}

describe("AccountStatusChips — renewal chip wording", () => {
	it("labels an elapsed one-time date 'Renewal date passed', never 'Renewed'", () => {
		const html = render(
			makeAccount({ renewalAnchor: "2024-01-01", renewalCadence: "none" }),
		);
		expect(html).toContain("Renewal date passed");
		// The old wording asserted an unverified event — it must be gone.
		expect(html).not.toContain("Renewed");
		// Honest tooltip noting the provider renewal was not verified.
		expect(html).toContain("not verified");
	});

	it("labels a future renewal with 'Renews'", () => {
		const html = render(
			makeAccount({ renewalAnchor: "2024-01-08", renewalCadence: "none" }),
		);
		expect(html).toContain("Renews");
		expect(html).not.toContain("Renewal date passed");
	});
});

describe("AccountStatusChips — expired suppresses renewal chip", () => {
	it("shows 'Subscription expired' and no renewal chip when expired with a past date", () => {
		const html = render(
			makeAccount({
				paused: true,
				pauseReason: "subscription_expired",
				renewalAnchor: "2024-01-01",
				renewalCadence: "none",
			}),
		);
		expect(html).toContain("Subscription expired");
		// No renewal chip text at all — real provider state dominates.
		expect(html).not.toContain("Renewal date passed");
		expect(html).not.toContain("Renewed");
		expect(html).not.toContain("Renews");
	});

	it("suppresses the renewal chip when expired even with a future renewal date", () => {
		const html = render(
			makeAccount({
				paused: true,
				pauseReason: "subscription_expired",
				renewalAnchor: "2024-02-01",
				renewalCadence: "monthly",
			}),
		);
		expect(html).toContain("Subscription expired");
		expect(html).not.toContain("Renews");
	});
});

describe("AccountStatusChips — on-credits chip", () => {
	it("renders 'On credits' with balance and plan for a codex account on credits", () => {
		const html = render(
			makeAccount({
				provider: "codex",
				codexCredits: {
					hasCredits: true,
					balance: 2430.25,
					unlimited: false,
					planType: "prolite",
					weeklyUsedPct: 100,
				},
			}),
		);
		expect(html).toContain("On credits");
		// Native credits (rounded) + exact EUR value at €0.04/credit.
		expect(html).toContain("2430 cr");
		expect(html).toContain("€97.21");
		expect(html).toContain("prolite");
		// Codex balances are credits/EUR, never USD.
		expect(html).not.toContain("$");
	});

	it("does not render the chip for an unlimited codex account", () => {
		const html = render(
			makeAccount({
				provider: "codex",
				codexCredits: {
					hasCredits: true,
					balance: null,
					unlimited: true,
					planType: "pro",
					weeklyUsedPct: 100,
				},
			}),
		);
		expect(html).not.toContain("On credits");
	});
});

describe("AccountStatusChips — earned usage resets", () => {
	it("renders the authoritative count and nearest expiry for a Codex account", () => {
		const html = render(
			makeAccount({
				provider: "codex",
				codexRateLimitResetCredits: {
					availableCount: 3,
					credits: [
						{
							status: "available",
							expiresAt: "2030-02-10T00:00:00.000Z",
							title: "Full reset",
							description: null,
						},
						{
							status: "available",
							expiresAt: "2030-01-05T00:00:00.000Z",
							title: "Full reset",
							description: null,
						},
					],
					fetchedAt: "2030-01-01T00:00:00.000Z",
				},
			}),
		);

		expect(html).toContain("3 usage resets");
		expect(html).toContain("next expires Jan 5");
	});

	it("shows a known zero balance", () => {
		const html = render(
			makeAccount({
				provider: "codex",
				codexRateLimitResetCredits: {
					availableCount: 0,
					credits: [],
					fetchedAt: "2030-01-01T00:00:00.000Z",
				},
			}),
		);

		expect(html).toContain("0 usage resets");
	});

	it("does not render reset metadata on a non-Codex account", () => {
		const html = render(
			makeAccount({
				provider: "anthropic",
				codexRateLimitResetCredits: {
					availableCount: 3,
					credits: null,
					fetchedAt: "2030-01-01T00:00:00.000Z",
				},
			}),
		);

		expect(html).not.toContain("usage reset");
	});
});

/** A Codex account with one available reset credit expiring at `expiresAt`. */
function makeResetCreditAccount(
	expiresAt: string | null,
	overrides: Partial<AccountResponse> = {},
): AccountResponse {
	return makeAccount({
		provider: "codex",
		codexRateLimitResetCredits: {
			availableCount: 1,
			credits: [
				{
					status: "available",
					expiresAt,
					title: "Full reset",
					description: null,
				},
			],
			fetchedAt: new Date(NOW).toISOString(),
		},
		...overrides,
	});
}

describe("AccountStatusChips — reset-credit urgency colors", () => {
	it("uses red classes when the soonest expiry is under an hour away", () => {
		const html = render(
			makeResetCreditAccount(new Date(NOW + 30 * 60_000).toISOString()),
		);
		expect(html).toContain("bg-red-100");
		expect(html).not.toContain("bg-sky-100");
	});

	it("uses amber classes when the soonest expiry is under 24 hours away", () => {
		const html = render(
			makeResetCreditAccount(new Date(NOW + 5 * 3_600_000).toISOString()),
		);
		expect(html).toContain("bg-amber-100");
		expect(html).not.toContain("bg-sky-100");
	});

	it("keeps the default sky classes when nothing expires soon", () => {
		const html = render(
			makeResetCreditAccount(new Date(NOW + 3 * 86_400_000).toISOString()),
		);
		expect(html).toContain("bg-sky-100");
		expect(html).not.toContain("bg-red-100");
		expect(html).not.toContain("bg-amber-100");
	});
});

describe("AccountStatusChips — auto-apply tooltip line", () => {
	it("mentions 'Auto-apply armed' when the account has the toggle enabled", () => {
		const html = render(
			makeResetCreditAccount(new Date(NOW + 3 * 86_400_000).toISOString(), {
				autoApplyResetCreditsEnabled: true,
			}),
		);
		expect(html).toContain("Auto-apply armed");
		expect(html).not.toContain("Auto-apply is off");
	});

	it("mentions 'Auto-apply is off' when the toggle is disabled", () => {
		const html = render(
			makeResetCreditAccount(new Date(NOW + 3 * 86_400_000).toISOString(), {
				autoApplyResetCreditsEnabled: false,
			}),
		);
		expect(html).toContain("Auto-apply is off");
		expect(html).not.toContain("Auto-apply armed");
	});

	it("omits the auto-apply line entirely when no credits are available", () => {
		const html = render(
			makeAccount({
				provider: "codex",
				autoApplyResetCreditsEnabled: true,
				codexRateLimitResetCredits: {
					availableCount: 0,
					credits: [],
					fetchedAt: new Date(NOW).toISOString(),
				},
			}),
		);
		expect(html).not.toContain("Auto-apply");
	});
});

describe("ResetCreditEventsPanel — popover history states", () => {
	function makeEvent(
		overrides: Partial<CodexResetCreditEventResponse> = {},
	): CodexResetCreditEventResponse {
		return {
			id: "ev1",
			creditId: "credit-1",
			trigger: "auto",
			attemptSeq: 1,
			status: "reset",
			windowsReset: 2,
			errorMessage: null,
			creditExpiresAt: "2030-01-05T00:00:00.000Z",
			createdAt: "2030-01-04T23:50:00.000Z",
			resolvedAt: "2030-01-04T23:50:05.000Z",
			...overrides,
		};
	}

	it("renders a loading indicator", () => {
		const html = renderToStaticMarkup(
			<ResetCreditEventsPanel state={{ kind: "loading" }} />,
		);
		expect(html).toContain("Loading reset events");
	});

	it("renders the error message on failure", () => {
		const html = renderToStaticMarkup(
			<ResetCreditEventsPanel
				state={{ kind: "error", message: "boom went the fetch" }}
			/>,
		);
		expect(html).toContain("Failed to load reset events");
		expect(html).toContain("boom went the fetch");
	});

	it("renders an empty state when there are no events", () => {
		const html = renderToStaticMarkup(
			<ResetCreditEventsPanel state={{ kind: "loaded", events: [] }} />,
		);
		expect(html).toContain("No reset events yet");
	});

	it("renders fetched events with trigger badge, status label and windows reset", () => {
		const html = renderToStaticMarkup(
			<ResetCreditEventsPanel
				state={{
					kind: "loaded",
					events: [
						makeEvent(),
						makeEvent({
							id: "ev2",
							trigger: "manual",
							status: "nothingToReset",
							windowsReset: 0,
						}),
					],
				}}
			/>,
		);
		expect(html).toContain("auto");
		expect(html).toContain("manual");
		expect(html).toContain("Reset applied");
		expect(html).toContain("Nothing to reset");
		expect(html).toContain("2 windows reset");
		// windowsReset of 0 is noise next to "Nothing to reset" — not rendered.
		expect(html).not.toContain("0 windows reset");
	});

	it("truncates a long error message but keeps the full text in the title", () => {
		const longMessage = `upstream exploded: ${"x".repeat(200)}`;
		const html = renderToStaticMarkup(
			<ResetCreditEventsPanel
				state={{
					kind: "loaded",
					events: [makeEvent({ status: "failed", errorMessage: longMessage })],
				}}
			/>,
		);
		expect(html).toContain("Failed");
		// Inline text is capped at 120 chars ("upstream exploded: " = 19 chars,
		// so exactly 101 x's survive) and ends with an ellipsis…
		expect(html).toContain(`${"x".repeat(101)}…</p>`);
		expect(html).not.toContain(`${"x".repeat(102)}…`);
		// …while the title attribute carries the full message.
		expect(html).toContain(`title="${longMessage}"`);
	});
});
