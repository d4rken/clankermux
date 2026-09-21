import { describe, expect, it } from "bun:test";
import type {
	AccountResponse,
	CodexResetCreditEventResponse,
} from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { deriveAccountStatus } from "../../lib/account-status";
import {
	AccountPausedChip,
	AccountStatusChips,
	ResetCreditApplyPanel,
	ResetCreditEventsPanel,
} from "./AccountStatusChips";

// 2024-01-03 noon UTC, matching account-status.test.ts.
const NOW = Date.UTC(2024, 0, 3, 12, 0, 0);

describe("AccountPausedChip", () => {
	it("explains a Devin quota pause without implying a charge or relabeling manual pauses", () => {
		const quota = renderPaused(
			makeAccount({
				provider: "devin",
				paused: true,
				pauseReason: "overage",
				autoFallbackEnabled: true,
			}),
		);
		expect(quota).toContain("Paused: included quota");
		expect(quota).toContain("exhausted or unavailable");
		const manual = renderPaused(
			makeAccount({
				provider: "devin",
				paused: true,
				pauseReason: "manual",
				autoFallbackEnabled: true,
			}),
		);
		expect(manual).toContain("Paused");
		expect(manual).not.toContain("Paused: included quota");
	});

	it("renders nothing for an account that is in rotation", () => {
		expect(renderPaused(makeAccount())).toBe("");
	});

	// The heading row owns the pause now; the chip row must not repeat it beside
	// the cause chips that explain it.
	it("is absent from the status chip row", () => {
		const html = render(
			makeAccount({ paused: true, pauseReason: "oauth_invalid_grant" }),
		);
		expect(html).toContain("Re-auth needed");
		expect(html).not.toContain("Paused");
	});

	function renderPaused(account: AccountResponse): string {
		return renderToStaticMarkup(
			<AccountPausedChip
				account={account}
				status={deriveAccountStatus(account, NOW)}
			/>,
		);
	}
});

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
		rateLimitCause: "ok",
		rateLimitCauseResetMs: null,
		rateLimitProviderStatus: null,
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
		usageUtilization: null,
		usageWindow: null,
		usageData: null,
		usageRateLimitedUntil: null,
		usageThrottledUntil: null,
		usageThrottledWindows: [],
		hasRefreshToken: false,
		notes: null,
		sessionStats: null,
		isPrimary: false,
		autoPauseOnOverageEnabled: false,
		peakHoursPauseEnabled: false,
		providerOverloadKey: null,
		providerOverloadedUntil: null,
		billingType: null,
		renewalAnchor: null,
		renewalCadence: null,
		identityExternalId: null,
		identityEmail: null,
		identityOrganizationName: null,
		identityPlanTier: null,
		identityRateLimitTier: null,
		identitySubscriptionStatus: null,
		identitySubscriptionStartedAt: null,
		identitySubscriptionEndsAt: null,
		identitySubscriptionWillRenew: null,
		identitySubscriptionGraceEndsAt: null,
		identitySubscriptionCheckedAt: null,
		identityCapturedAt: null,
		identityProfileFetchedAt: null,
		isDuplicateAccount: false,
		duplicateAccountIds: [],
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

/**
 * The rendered markup as visible text. Chips that dim their countdown put it in
 * a nested span, so `"Overloaded: Haiku · 2m"` never appears contiguously in the
 * HTML even though that is exactly what the chip reads as. `StatusChip` is a
 * flex row with `gap-tight`, so each element boundary renders AS a space — hence
 * every tag becomes one here rather than being dropped.
 */
function text(html: string): string {
	return html
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

describe("AccountStatusChips — Usage presentation", () => {
	function renderUsage(account: AccountResponse) {
		return renderToStaticMarkup(
			<AccountStatusChips
				account={account}
				status={deriveAccountStatus(account, NOW)}
				variant="usage"
			/>,
		);
	}

	it("keeps the Accounts inventory while omitting it on Usage", () => {
		const account = makeAccount({
			provider: "codex",
			isPrimary: true,
			priority: 7,
			autoFallbackEnabled: true,
			autoApplyResetCreditsEnabled: true,
			renewalAnchor: "2024-01-08",
			renewalCadence: "none",
			codexRateLimitResetCredits: {
				availableCount: 0,
				credits: [],
				fetchedAt: new Date(NOW).toISOString(),
			},
		});
		const accounts = render(account);
		const usage = renderUsage(account);
		for (const label of [
			"Primary",
			"Priority: 7",
			"Fallback",
			"Prewarm",
			"Apply:",
			"Credit spend",
			"Renews",
			"0 resets",
		]) {
			expect(accounts).toContain(label);
			expect(usage).not.toContain(label);
		}
	});

	it("retains available resets, credit spending and shared-quota warnings", () => {
		const account = makeAccount({
			provider: "codex",
			isDuplicateAccount: true,
			duplicateAccountIds: ["other"],
			codexCredits: {
				hasCredits: true,
				unlimited: false,
				weeklyUsedPct: 100,
				balance: 100,
				planType: "plus",
			},
			codexRateLimitResetCredits: {
				availableCount: 2,
				credits: [],
				fetchedAt: new Date(NOW).toISOString(),
			},
		});
		const usage = renderUsage(account);
		for (const label of ["2 resets", "On credits", "Duplicate"]) {
			expect(usage).toContain(label);
		}
	});
});

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

describe("AccountStatusChips — refresh-token re-auth chip", () => {
	const DAY = 24 * 60 * 60 * 1000;

	function renderUsageVariant(account: AccountResponse): string {
		return renderToStaticMarkup(
			<AccountStatusChips
				account={account}
				status={deriveAccountStatus(account, NOW)}
				variant="usage"
			/>,
		);
	}

	it("counts down in days inside the warning window", () => {
		const html = render(
			makeAccount({
				refreshTokenExpiresAt: new Date(NOW + 5 * DAY).toISOString(),
			}),
		);
		expect(html).toContain("Re-auth in 5 days");
		// The tooltip carries the actual date, not just the countdown.
		expect(html).toContain("rotation does not extend");
	});

	it("names the duration, not a calendar day, inside the last 24 hours", () => {
		// "today" would contradict the date rendered beside it whenever the
		// deadline crosses local midnight.
		const html = render(
			makeAccount({
				refreshTokenExpiresAt: new Date(NOW + 6 * 60 * 60 * 1000).toISOString(),
			}),
		);
		expect(html).toContain("Re-auth within 24h");
		expect(html).not.toContain("Re-auth today");
	});

	it("renders the absolute date in neutral tone while the deadline is far out", () => {
		const html = render(
			makeAccount({
				refreshTokenExpiresAt: new Date(NOW + 60 * DAY).toISOString(),
			}),
		);
		expect(html).toContain("Re-auth by");
		expect(html).toContain("bg-secondary text-secondary-foreground");
		// A day count this far out is noise; the date is the useful form.
		expect(html).not.toContain("Re-auth in");
	});

	it("omits the far-out date on Usage, which reports capacity and problems", () => {
		const html = renderUsageVariant(
			makeAccount({
				refreshTokenExpiresAt: new Date(NOW + 60 * DAY).toISOString(),
			}),
		);
		expect(html).not.toContain("Re-auth");
	});

	it("keeps the warning-window chip on Usage", () => {
		const html = renderUsageVariant(
			makeAccount({
				refreshTokenExpiresAt: new Date(NOW + 5 * DAY).toISOString(),
			}),
		);
		expect(html).toContain("Re-auth in 5 days");
		expect(html).toContain("bg-warning/15 text-warning-strong");
	});

	it("renders no chip for a provider that reports no deadline", () => {
		const html = render(makeAccount({ refreshTokenExpiresAt: null }));
		expect(html).not.toContain("Re-auth");
	});

	it("shows only the terminal chip once the account is already paused for reauth", () => {
		const account = makeAccount({
			paused: true,
			pauseReason: "oauth_invalid_grant",
			refreshTokenExpiresAt: new Date(NOW - DAY).toISOString(),
		});
		for (const html of [render(account), renderUsageVariant(account)]) {
			expect(html).toContain("Re-auth needed");
			expect(html).not.toContain("Re-auth in");
			expect(html).not.toContain("Re-auth overdue");
			// The deadline form too: a rejected token has no deadline left to plan
			// around, and two chips saying the same thing is the regression here.
			expect(html).not.toContain("Re-auth by");
		}
	});
});

describe("AccountStatusChips — expired suppresses renewal chip", () => {
	it("explains that Anthropic expiry checks continue in the background", () => {
		const html = render(
			makeAccount({
				provider: "anthropic",
				paused: true,
				pauseReason: "subscription_expired",
			}),
		);
		expect(html).toContain("Background checks continue");
		expect(html).toContain("pause clears when usage access returns");
		expect(html).not.toContain("no retries are scheduled");
	});

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
		// The two reasons are different facts and must not borrow each other's
		// chip: one is the usage endpoint refusing, the other is the plan.
		expect(html).not.toContain("Usage access denied");
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

	it("keeps 'Usage access denied' on its own reason", () => {
		const html = render(
			makeAccount({ paused: true, pauseReason: "usage_permission_denied" }),
		);
		expect(html).toContain("Usage access denied");
		expect(html).not.toContain("Subscription expired");
	});
});

describe("AccountRenewalInfo — provider-reported period", () => {
	/** 2024-01-20 noon UTC: 17 days after NOW. */
	const PERIOD_END = Date.UTC(2024, 0, 20, 12, 0, 0);

	const providerAccount = (overrides: Partial<AccountResponse> = {}) =>
		makeAccount({
			renewalAnchor: "2024-01-20",
			renewalCadence: "monthly",
			renewalAnchorSource: "provider",
			identitySubscriptionEndsAt: PERIOD_END,
			...overrides,
		});

	it("says 'Renews' with no estimate marker while nothing says otherwise", () => {
		const html = render(providerAccount());
		expect(html).toContain("Renews");
		expect(html).not.toContain("~");
	});

	it("says 'Ends' once the provider reports it will not renew", () => {
		const html = render(
			providerAccount({ identitySubscriptionWillRenew: false }),
		);
		expect(html).toContain("Ends");
		expect(html).not.toContain("Renews");
	});

	it("keeps saying 'Renews' when renewal intent was never reported", () => {
		// null is "not reported", which is not the same claim as false.
		const html = render(
			providerAccount({ identitySubscriptionWillRenew: null }),
		);
		expect(html).toContain("Renews");
	});

	it("says 'Ended' once the reported period end has passed", () => {
		const past = Date.UTC(2023, 11, 20, 12, 0, 0);
		const html = render(
			providerAccount({
				renewalAnchor: "2023-12-20",
				identitySubscriptionEndsAt: past,
			}),
		);
		expect(html).toContain("Ended");
		// NOT the recurrence: a monthly cadence would have advanced this to a
		// future date the provider never reported.
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
		// The chip shows credits (rounded) and whole euros at €0.04/credit…
		const visible = text(html);
		expect(visible).toContain("On credits");
		expect(visible).toContain("2430 cr (€97)");
		// …and leaves the cents and the plan type to the tooltip.
		expect(visible).not.toContain("€97.21");
		expect(visible).not.toContain("prolite");
		expect(html).toContain("€97.21");
		expect(html).toContain("Plan: prolite");
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

/**
 * The full API → `deriveAccountStatus` → `RateLimitStatusChip` chain. The chip's
 * own tests inject `binding` directly, so only this level proves the field
 * actually survives the derivation in between.
 */
describe("AccountStatusChips — usage-exhausted binding chain", () => {
	function exhausted(
		binding: AccountResponse["rateLimitCauseBinding"],
	): AccountResponse {
		return makeAccount({
			provider: "anthropic",
			rateLimitStatus: "usage_exhausted (13m)",
			rateLimitCause: "usage_exhausted",
			rateLimitCauseBinding: binding,
			rateLimitCauseResetMs: NOW + 13 * 60_000,
			rateLimitProviderStatus: "rejected",
		});
	}

	it("renders the 5-hour tooltip for a session-bound exhaustion", () => {
		const html = render(exhausted("session"));
		expect(html).toContain("Exhausted");
		expect(html).toContain("5-hour session quota is spent");
		expect(html).not.toContain("Weekly usage quota");
	});

	it("renders the weekly tooltip for a weekly-bound exhaustion", () => {
		const html = render(exhausted("weekly"));
		expect(html).toContain("Weekly usage quota is spent");
		expect(html).not.toContain("5-hour session");
	});

	it("stays generic when the server sent no binding", () => {
		const html = render(exhausted(undefined));
		expect(html).toContain("A usage quota is spent");
	});
});

describe("AccountStatusChips — family-scoped overload chips", () => {
	it("renders a per-family chip for an open family bucket, without the generic chip", () => {
		const html = render(
			makeAccount({
				provider: "anthropic",
				providerOverloadedUntil: NOW + 90_000,
				providerOverload: [
					{
						family: "haiku",
						state: "open",
						until: NOW + 90_000,
						probeActive: false,
					},
				],
			}),
		);
		expect(text(html)).toContain("Overloaded: Haiku · 2m");
		expect(text(html)).not.toContain("Overloaded ·");
	});

	it("renders the generic chip for a provider-wide open bucket", () => {
		const html = render(
			makeAccount({
				provider: "anthropic",
				providerOverloadedUntil: NOW + 90_000,
				providerOverload: [
					{
						family: null,
						state: "open",
						until: NOW + 90_000,
						probeActive: false,
					},
				],
			}),
		);
		expect(text(html)).toContain("Overloaded · 2m");
		expect(html).not.toContain("Overloaded:");
	});

	it("renders probing chips for half-open buckets", () => {
		const html = render(
			makeAccount({
				provider: "anthropic",
				providerOverload: [
					{
						family: "haiku",
						state: "half-open",
						until: null,
						probeActive: true,
					},
					{ family: null, state: "half-open", until: null, probeActive: false },
				],
			}),
		);
		expect(html).toContain("Probing: Haiku");
		// The provider-wide bucket gets its own bare chip beside the family one.
		expect(text(html)).toMatch(/Probing(?!:)/);
		expect(html).not.toContain("Overloaded");
	});

	it("renders one chip per family for a multi-family incident", () => {
		const html = render(
			makeAccount({
				provider: "anthropic",
				providerOverload: [
					{
						family: "sonnet",
						state: "open",
						until: NOW + 60_000,
						probeActive: false,
					},
					{
						family: "haiku",
						state: "open",
						until: NOW + 60_000,
						probeActive: false,
					},
				],
			}),
		);
		expect(text(html)).toContain("Overloaded: Haiku · 1m");
		expect(text(html)).toContain("Overloaded: Sonnet · 1m");
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

		expect(text(html)).toContain("3 resets · expires Jan 5");
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

		expect(html).toContain("0 resets");
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

		expect(text(html)).not.toMatch(/\d+ resets?\b/);
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

/**
 * The reset-credit chip on its own, cut out of the whole chip row. Anchored on
 * the tooltip's "Click for reset history" tail, which only that chip carries.
 */
function resetCreditChip(html: string): string {
	const anchor = html.indexOf("Click for reset history");
	if (anchor === -1) throw new Error("reset-credit chip not found");
	const start = html.lastIndexOf("<span", anchor);
	if (start === -1) throw new Error("reset-credit chip has no element start");
	let depth = 0;
	let i = start;
	while (i < html.length) {
		if (html.startsWith("<span", i)) depth++;
		else if (html.startsWith("</span>", i)) {
			depth--;
			if (depth === 0) return html.slice(start, i + "</span>".length);
		}
		i++;
	}
	throw new Error("reset-credit chip never closed");
}

describe("AccountStatusChips — reset-credit urgency colors", () => {
	it("uses red classes when the soonest expiry is under an hour away", () => {
		const html = render(
			makeResetCreditAccount(new Date(NOW + 30 * 60_000).toISOString()),
		);
		expect(html).toContain("bg-destructive/15");
		expect(html).not.toContain("bg-info/15");
	});

	it("uses amber classes when the soonest expiry is under 24 hours away", () => {
		const html = render(
			makeResetCreditAccount(new Date(NOW + 5 * 3_600_000).toISOString()),
		);
		expect(html).toContain("bg-warning/15");
		expect(html).not.toContain("bg-info/15");
	});

	it("keeps the default sky classes when nothing expires soon", () => {
		const html = render(
			makeResetCreditAccount(new Date(NOW + 3 * 86_400_000).toISOString()),
		);
		expect(html).toContain("bg-info/15");
		expect(html).not.toContain("bg-destructive/15");
		// Scoped to the reset chip: this fixture leaves extra spend permitted, so
		// the policy chip beside it legitimately carries the amber tone. What this
		// test is about is the reset chip's OWN urgency colour.
		expect(resetCreditChip(html)).not.toContain("bg-warning/15");
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

	it("mentions the weekly-limit variant when only the weekly toggle is enabled", () => {
		const html = render(
			makeResetCreditAccount(new Date(NOW + 3 * 86_400_000).toISOString(), {
				autoApplyResetCreditsEnabled: false,
				autoApplyResetOnWeeklyLimitEnabled: true,
			}),
		);
		expect(html).toContain("Auto-apply armed (weekly limit)");
		expect(html).not.toContain("expiry + weekly limit");
		expect(html).not.toContain("Auto-apply is off");
	});

	it("mentions both causes when both toggles are enabled", () => {
		const html = render(
			makeResetCreditAccount(new Date(NOW + 3 * 86_400_000).toISOString(), {
				autoApplyResetCreditsEnabled: true,
				autoApplyResetOnWeeklyLimitEnabled: true,
			}),
		);
		expect(html).toContain("Auto-apply armed (expiry + weekly limit)");
		expect(html).not.toContain("Auto-apply is off");
	});

	it("keeps the expiry-only wording when only the expiry toggle is enabled", () => {
		const html = render(
			makeResetCreditAccount(new Date(NOW + 3 * 86_400_000).toISOString(), {
				autoApplyResetCreditsEnabled: true,
				autoApplyResetOnWeeklyLimitEnabled: false,
			}),
		);
		expect(html).toContain(
			"Auto-apply armed — a reset will be consumed automatically shortly before expiry.",
		);
		expect(html).not.toContain("weekly limit");
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
		// The specific tooltip sentences, not the bare word: "Auto-apply" is also
		// the label of the two policy chips this codex fixture always renders.
		expect(html).not.toContain("Auto-apply armed");
		expect(html).not.toContain("Auto-apply is off");
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
			cause: null,
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

	it("labels auto events with their cause (expiry vs weekly limit)", () => {
		const html = renderToStaticMarkup(
			<ResetCreditEventsPanel
				state={{
					kind: "loaded",
					events: [
						makeEvent({ id: "ev-exp", cause: "expiry" }),
						makeEvent({ id: "ev-wk", cause: "weekly-limit" }),
					],
				}}
			/>,
		);
		expect(html).toContain("auto · expiry");
		expect(html).toContain("auto · weekly limit");
	});

	it("keeps manual rows unchanged (no cause suffix) and plain 'auto' when cause is unknown", () => {
		const html = renderToStaticMarkup(
			<ResetCreditEventsPanel
				state={{
					kind: "loaded",
					events: [
						makeEvent({ id: "ev-m", trigger: "manual", cause: null }),
						makeEvent({ id: "ev-a", trigger: "auto", cause: null }),
					],
				}}
			/>,
		);
		expect(html).toContain(">manual<");
		expect(html).toContain(">auto<");
		expect(html).not.toContain("manual ·");
		expect(html).not.toContain("auto ·");
	});
});

describe("ResetCreditApplyPanel — manual Apply-now flow", () => {
	const noop = () => {};
	function renderPanel(
		state: Parameters<typeof ResetCreditApplyPanel>[0]["state"],
		availableCount = 1,
	): string {
		return renderToStaticMarkup(
			<ResetCreditApplyPanel
				accountName="acct"
				availableCount={availableCount}
				state={state}
				onArm={noop}
				onConfirm={noop}
				onCancel={noop}
				onRetry={noop}
				onDismiss={noop}
			/>,
		);
	}

	it("shows the Apply now button when a reset credit is available", () => {
		const html = renderPanel({ kind: "idle" }, 1);
		expect(html).toContain("Apply now");
	});

	it("renders nothing at zero available credits", () => {
		expect(renderPanel({ kind: "idle" }, 0)).toBe("");
	});

	it("renders the inline confirm step naming the account", () => {
		const html = renderPanel({ kind: "confirm" });
		expect(html).toContain("Consume 1 reset for");
		expect(html).toContain("acct");
		expect(html).toContain("Confirm");
		expect(html).toContain("Cancel");
		expect(html).not.toContain("Apply now");
	});

	it("renders an in-flight indicator while applying", () => {
		const html = renderPanel({ kind: "applying" });
		expect(html).toContain("Applying reset…");
		expect(html).not.toContain("Confirm");
	});

	it.each([
		["reset", "Reset applied — usage windows cleared"],
		["nothingToReset", "Nothing to reset"],
		["noCredit", "No credit available"],
		["alreadyRedeemed", "Already redeemed"],
	] as const)("renders the '%s' business outcome", (outcome, message) => {
		const html = renderPanel({ kind: "done", outcome, message });
		expect(html).toContain(message);
		expect(html).not.toContain("Retry");
	});

	it("colors only the successful reset outcome green", () => {
		expect(
			renderPanel({
				kind: "done",
				outcome: "reset",
				message: "Reset applied — usage windows cleared",
			}),
		).toContain("text-success-strong");
		expect(
			renderPanel({
				kind: "done",
				outcome: "noCredit",
				message: "No credit available",
			}),
		).not.toContain("text-success-strong");
	});

	it("renders a dismiss control in the done state (path back to idle)", () => {
		// Without this, the Apply-now button would disappear permanently after
		// one use — "done" had no way back to idle.
		const html = renderPanel({
			kind: "done",
			outcome: "reset",
			message: "Reset applied — usage windows cleared",
		});
		expect(html).toContain("Done");
		expect(html).not.toContain("Retry");
	});

	it("renders the error state with the message and a Retry affordance", () => {
		const html = renderPanel({
			kind: "error",
			message: "upstream 500: transport failed",
		});
		expect(html).toContain("Failed to apply reset");
		expect(html).toContain("upstream 500: transport failed");
		expect(html).toContain("Retry");
		expect(html).toContain("Cancel");
	});
});

describe("AccountStatusChips — family-weekly exhausted chip", () => {
	it("renders an amber warning chip with the family label and countdown", () => {
		const html = render(
			makeAccount({
				usageData: {
					limits: [
						{
							kind: "weekly_scoped",
							group: "weekly",
							percent: 100,
							resets_at: "2024-01-05T12:00:00.000Z", // 48h after NOW
							scope: {
								model: { id: null, display_name: "Fable" },
								surface: null,
							},
							is_active: true,
						},
					],
				} as unknown as AccountResponse["usageData"],
			}),
		);
		expect(text(html)).toContain("Fable weekly exhausted · 48h");
		expect(html).toContain("bg-warning/15");
		// The account is routable for other families — no Force Reset offer.
		expect(html).not.toContain("Force reset");
	});

	it("does not render the chip when no scoped window is exhausted", () => {
		const html = render(makeAccount());
		expect(html).not.toContain("weekly exhausted");
	});
});

it("labels usage permission denial without claiming the subscription expired", () => {
	const html = render(
		makeAccount({ paused: true, pauseReason: "usage_permission_denied" }),
	);
	expect(html).toContain("Usage access denied");
	expect(html).not.toContain("Subscription expired");
});

it("explains the request-path org restriction even when quota has headroom", () => {
	const html = render(
		makeAccount({
			rateLimitedReason: "org_permission_denied",
			rateLimitedUntil: NOW + 60_000,
			usageUtilization: 10,
		}),
	);
	expect(html).toContain("Org access disabled");
	expect(html).not.toContain("Subscription expired");
});

it("shows Devin quota override state with provider-specific spending consequences", () => {
	const html = render(
		makeAccount({ provider: "devin", autoPauseOnOverageEnabled: false }),
	);
	expect(html).toContain("Unverified spend");
	expect(html).toContain("prepaid credits");
	expect(html).toContain("CLI, Desktop, and cloud");
	expect(html).not.toContain("Anthropic reporting overage");
	expect(html).not.toContain("Prewarm");
});

describe("AccountStatusChips — D5 Devin grace period", () => {
	it("D5: names the grace-period state the provider reported", () => {
		const html = render(
			makeAccount({
				provider: "devin",
				usageData: {
					kind: "devin",
					quotaBased: true,
					daily: null,
					weekly: null,
					planName: "Team",
					email: "seat@example.com",
					accountId: "acct-1",
					canUseCli: true,
					overageBalanceUsd: 0,
					includedCreditsRemaining: 10,
					gracePeriodStatus: "expired",
					gracePeriodEndMs: NOW - 86_400_000,
				},
			}),
		);

		expect(html.toLowerCase()).toContain("grace");
	});

	// Devin's proto maps `GracePeriodStatus.NONE = 1`, so a healthy seat arrives
	// as the string "none" rather than as an absent field. Only "active" and
	// "expired" describe something running; "none" must render no chip at all.
	it("D6: renders no grace chip for a seat Devin reports as not in one", () => {
		const html = render(
			makeAccount({
				provider: "devin",
				usageData: {
					kind: "devin",
					quotaBased: true,
					daily: null,
					weekly: null,
					planName: "Team",
					email: "seat@example.com",
					accountId: "acct-1",
					canUseCli: true,
					overageBalanceUsd: 0,
					includedCreditsRemaining: 10,
					gracePeriodStatus: "none",
					gracePeriodEndMs: null,
				},
			}),
		);

		expect(html.toLowerCase()).not.toContain("grace");
	});
});

describe("AccountStatusChips — D8 subscription-expired auto-resume claim", () => {
	/**
	 * The tooltip of the chip whose label is `label`: the nearest `title`
	 * attribute preceding the label text. Anchored on the visible label rather
	 * than on any phrase inside the tooltip, so rewording the tooltip does not
	 * silently turn this into a vacuous pass.
	 */
	function chipTitle(html: string, label: string): string {
		const index = html.indexOf(label);
		expect(index).toBeGreaterThan(-1);
		const titles = [...html.slice(0, index).matchAll(/title="([^"]*)"/g)];
		return titles[titles.length - 1]?.[1] ?? "";
	}

	// Only the Codex spend coordinator resumes a `subscription_expired` pause
	// (`resumeAccountIfPausedWithReason`). A Devin seat paused this way stays
	// paused until a human resumes it, so the chip must not promise otherwise.
	it("D8: does not promise a self-lifting pause on a Devin seat", () => {
		const html = render(
			makeAccount({
				provider: "devin",
				paused: true,
				pauseReason: "subscription_expired",
			}),
		);

		expect(html).toContain("Subscription expired");
		const title = chipTitle(html, "Subscription expired");
		expect(title).not.toMatch(
			/lifts? (on its own|itself|automatically)|resumes? (on its own|itself|automatically)|automatically/i,
		);
	});
});
