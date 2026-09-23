import { describe, expect, it } from "bun:test";
import type {
	AccountResponse,
	AnthropicBankedResetsInfo,
} from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { deriveAccountStatus } from "../../lib/account-status";
import type { AnthropicBankedResetGrantInfo } from "../../lib/anthropic-banked-resets";
import { AccountStatusChips } from "./AccountStatusChips";
import { BankedResetGrantsPanel } from "./AnthropicBankedResetChip";
import { ResetApplyConfirmPanel } from "./UsageResetPanels";

const NOW = Date.UTC(2024, 0, 3, 12, 0, 0);
const HOUR = 3_600_000;
const CHIP_ANCHOR = "Click for banked resets and history.";

function grant(
	overrides: Partial<AnthropicBankedResetGrantInfo> = {},
): AnthropicBankedResetGrantInfo {
	return {
		id: "g1",
		label: "Welcome reset",
		resetsLeft: 2,
		resetsTotal: 3,
		endsAt: new Date(NOW + 72 * HOUR).toISOString(),
		startsAt: null,
		clears: ["seven_day"],
		paused: false,
		usableNow: true,
		useRequiresLimit: true,
		isNext: true,
		...overrides,
	};
}

function info(
	overrides: Partial<AnthropicBankedResetsInfo> = {},
): AnthropicBankedResetsInfo {
	const grants = overrides.grants ?? [grant()];
	return {
		eligible: true,
		ineligibleReason: null,
		exhausted: [],
		cooldownUntil: null,
		weeklyResetsAt: null,
		nextGrantId: "g1",
		resetsLeftTotal: grants.reduce((sum, g) => sum + g.resetsLeft, 0),
		fetchedAt: new Date(NOW).toISOString(),
		...overrides,
		grants,
	};
}

function makeAccount(
	overrides: Partial<AccountResponse> = {},
): AccountResponse {
	return {
		id: "a1",
		name: "acct",
		provider: "anthropic",
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
		// Protected, so no amber policy chip competes with the reset chip.
		autoPauseOnOverageEnabled: true,
		customEndpoint: null,
		usageUtilization: null,
		usageWindow: null,
		usageData: null,
		usageRateLimitedUntil: null,
		usageThrottledUntil: null,
		usageThrottledWindows: [],
		hasRefreshToken: true,
		notes: null,
		sessionStats: null,
		isPrimary: false,
		billingType: null,
		isDuplicateAccount: false,
		duplicateAccountIds: [],
		anthropicBankedResets: info(),
		...overrides,
	} as AccountResponse;
}

function render(
	account: AccountResponse,
	variant: "account" | "usage" = "account",
): string {
	return renderToStaticMarkup(
		<AccountStatusChips
			account={account}
			status={deriveAccountStatus(account, NOW)}
			variant={variant}
		/>,
	);
}

/** The banked-reset chip element, cut out of the whole chip row; null when absent. */
function bankedChip(html: string): string | null {
	const anchor = html.indexOf(CHIP_ANCHOR);
	if (anchor === -1) return null;
	const start = html.lastIndexOf("<span", anchor);
	const end = html.indexOf("</span>", anchor);
	return html.slice(start, end + "</span>".length);
}

function text(html: string): string {
	return html
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

describe("AnthropicBankedResetChip — visibility", () => {
	it("is hidden with no status, and on an ineligible account without grants", () => {
		expect(
			bankedChip(render(makeAccount({ anthropicBankedResets: null }))),
		).toBe(null);
		expect(
			bankedChip(
				render(
					makeAccount({
						anthropicBankedResets: info({
							eligible: false,
							ineligibleReason: "tier",
							grants: [],
						}),
					}),
				),
			),
		).toBe(null);
	});

	it("is hidden on an API-key Anthropic account", () => {
		expect(bankedChip(render(makeAccount({ hasRefreshToken: false })))).toBe(
			null,
		);
	});

	it("shows spent grants as a muted zero on Accounts, and not at all on Usage", () => {
		const spent = makeAccount({
			anthropicBankedResets: info({ grants: [grant({ resetsLeft: 0 })] }),
		});
		const chip = bankedChip(render(spent));
		expect(chip).toContain("0 resets");
		expect(chip).toContain("bg-secondary");
		expect(bankedChip(render(spent, "usage"))).toBe(null);
		expect(bankedChip(render(makeAccount(), "usage"))).toContain("2 resets");
	});
});

describe("AnthropicBankedResetChip — count and urgency", () => {
	it("counts resets left across grants", () => {
		const html = render(
			makeAccount({
				anthropicBankedResets: info({
					grants: [grant(), grant({ id: "g2", resetsLeft: 1, isNext: false })],
				}),
			}),
		);
		expect(text(bankedChip(html) ?? "")).toBe("3 resets · expires Jan 6");
		const single = render(
			makeAccount({
				anthropicBankedResets: info({ grants: [grant({ resetsLeft: 1 })] }),
			}),
		);
		expect(text(bankedChip(single) ?? "")).toBe("1 reset · expires Jan 6");
	});

	it("names no date when no grant with resets left has a use-by date", () => {
		const html = render(
			makeAccount({
				anthropicBankedResets: info({ grants: [grant({ endsAt: null })] }),
			}),
		);
		expect(text(bankedChip(html) ?? "")).toBe("2 resets");
	});

	it.each([
		[0.5, "bg-destructive/15"],
		[5, "bg-warning/15"],
		[72, "bg-info/15"],
	])("colors a use-by date %sh away with %s", (hours, className) => {
		const html = render(
			makeAccount({
				anthropicBankedResets: info({
					grants: [
						grant({ endsAt: new Date(NOW + hours * HOUR).toISOString() }),
					],
				}),
			}),
		);
		expect(bankedChip(html)).toContain(className);
	});
});

describe("AnthropicBankedResetChip — auto-apply tooltip line", () => {
	/** The chip's tooltip, entity-decoded. */
	function tooltip(account: AccountResponse): string {
		const chip = bankedChip(render(account)) ?? "";
		return (chip.match(/title="([^"]*)"/)?.[1] ?? "").replaceAll("&#x27;", "'");
	}

	it.each([
		[false, false, "Auto-apply is off — unused banked resets may expire."],
		[
			true,
			false,
			"Auto-apply armed — the next banked reset is applied shortly before it expires.",
		],
		[
			false,
			true,
			"Auto-apply armed (weekly limit) — the next banked reset is applied at a weekly limit it clears when no other Claude account can serve and the account's natural weekly reset is at least 12 hours away, or when it would expire before that limit lifts. Manual pauses conserve banked resets.",
		],
		[
			true,
			true,
			"Auto-apply armed (expiry + weekly limit) — the next banked reset is applied shortly before it expires, and at a weekly limit it clears when no other Claude account can serve and the account's natural weekly reset is at least 12 hours away, or when it would expire before that limit lifts. Manual pauses conserve banked resets.",
		],
	])("expiry=%s weekly=%s reads '%s'", (expiry, weekly, line) => {
		expect(
			tooltip(
				makeAccount({
					autoApplyBankedResetsEnabled: expiry,
					autoApplyBankedResetOnWeeklyLimitEnabled: weekly,
				}),
			),
		).toContain(line);
	});

	it("opens with the count left and lists every grant's expiry", () => {
		const title = tooltip(
			makeAccount({
				anthropicBankedResets: info({
					grants: [
						grant(),
						grant({
							id: "g2",
							resetsLeft: 1,
							isNext: false,
							endsAt: new Date(NOW + 96 * HOUR).toISOString(),
						}),
					],
				}),
			}),
		);
		expect(title).toStartWith(
			`3 banked resets left. Expires: ${new Date(NOW + 72 * HOUR).toLocaleString()}; ${new Date(NOW + 96 * HOUR).toLocaleString()}.`,
		);
		expect(title).toEndWith(" Click for banked resets and history.");
		expect(title).not.toMatch(/claim|consume|redeem|grant/i);
	});
});

describe("BankedResetGrantsPanel", () => {
	function panel(value: AnthropicBankedResetsInfo): string {
		return text(
			renderToStaticMarkup(<BankedResetGrantsPanel info={value} now={NOW} />),
		);
	}

	it("lists each grant with its label, count, windows and use rule", () => {
		const html = panel(
			info({
				grants: [
					grant({
						clears: [
							"five_hour",
							"seven_day_overage_included",
							"seven_day_cowork",
						],
						useRequiresLimit: false,
					}),
					grant({
						id: "g2",
						label: null,
						resetsLeft: 1,
						resetsTotal: 1,
						clears: ["seven_day_opus", "seven_day_sonnet"],
						isNext: false,
						paused: true,
					}),
				],
			}),
		);
		expect(html).toContain("Welcome reset 2/3 next");
		expect(html).toContain("clears session, weekly ·");
		expect(html).toContain("usable anytime");
		expect(html).toContain("Reset 1/1 paused");
		expect(html).toContain("clears Opus weekly, Sonnet weekly");
		expect(html).toContain("usable at a limit");
		expect(html).toContain("use by ");
		expect(html).not.toContain("cowork");
	});

	it("states why an account with grants cannot use them", () => {
		const html = panel(
			info({
				eligible: false,
				ineligibleReason: "cli_version",
				exhausted: ["seven_day", "five_hour"],
				cooldownUntil: new Date(NOW + HOUR).toISOString(),
			}),
		);
		expect(html).toContain("Not eligible (Claude Code version)");
		expect(html).toContain("Cooling down until ");
		expect(html).toContain("At a limit: session, weekly");
	});

	it("drops a cooldown that has already ended", () => {
		expect(
			panel(info({ cooldownUntil: new Date(NOW - HOUR).toISOString() })),
		).not.toContain("Cooling down");
	});
});

describe("ResetApplyConfirmPanel retry timing", () => {
	function retryMarkup(retryAt: number | undefined): string {
		return renderToStaticMarkup(
			<ResetApplyConfirmPanel
				available
				state={{ kind: "retry", message: "Couldn't confirm", retryAt }}
				confirmPrompt=""
				onArm={() => {}}
				onConfirm={() => {}}
				onCancel={() => {}}
				onRetry={() => {}}
				onDismiss={() => {}}
				now={NOW}
			/>,
		);
	}
	const retryButton = (markup: string) =>
		markup.match(/<button[^>]*>Retry<\/button>/)?.[0] ?? "";

	it("disables Retry until the claim's next attempt time", () => {
		const markup = retryButton(retryMarkup(NOW + 60_000));
		expect(markup).toContain(' disabled=""');
		expect(markup).toContain("Retry after ");
	});

	it("enables Retry once that time has passed, or when none was given", () => {
		expect(retryButton(retryMarkup(NOW))).not.toContain(' disabled=""');
		expect(retryButton(retryMarkup(undefined))).not.toContain(' disabled=""');
	});
});
