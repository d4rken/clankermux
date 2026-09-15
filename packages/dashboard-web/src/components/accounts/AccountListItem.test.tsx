import { describe, expect, it } from "bun:test";
import type { AccountResponse } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../../api";
import { AccountListItem } from "./AccountListItem";

function makeAccount(overrides: Partial<AccountResponse> = {}): Account {
	return {
		id: "a1",
		name: "acct",
		provider: "anthropic",
		requestCount: 1204,
		totalRequests: 1204,
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
		sessionInfo: "Active: 324 reqs",
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
	} as Account;
}

const noop = () => {};

function render(account: Account): string {
	return renderToStaticMarkup(
		<AccountListItem
			account={account}
			onPauseToggle={noop}
			onForceResetRateLimit={noop}
			onRefreshUsage={async () => {}}
			onRemove={noop}
			onRename={noop}
			onPriorityChange={noop}
			onSaveNotes={noop}
			onRenewalChange={noop}
			onRecordPayment={noop}
			onAutoFallbackToggle={noop}
			onAutoRefreshToggle={noop}
			onBillingTypeToggle={noop}
		/>,
	);
}

const SESSION_STATS = {
	requests: 324,
	inputTokens: 72_200,
	cacheCreationInputTokens: 9_900_000,
	cacheReadInputTokens: 61_300_000,
	outputTokens: 283_600,
	planCostUsd: 98.15,
	apiCostUsd: 0,
};

/**
 * The markup of one `<div data-testid="…">` and everything nested inside it.
 *
 * Anchored on the testid, never on a class string: the info-row helper this grew
 * out of matched the full `class="…"` verbatim, so it threw the moment the panel
 * moved onto the shared InsetPanel primitive. What these tests are about is each
 * region's CONTENT, so its styling must be free to change.
 */
function region(html: string, id: string): string {
	const testid = html.indexOf(`data-testid="${id}"`);
	if (testid === -1) throw new Error(`${id} not found`);
	const start = html.lastIndexOf("<div", testid);
	if (start === -1) throw new Error(`${id} has no element start`);
	// Walk to the matching close so a nested <span> cannot end the slice early.
	let depth = 0;
	let i = start;
	while (i < html.length) {
		if (html.startsWith("<div", i)) depth++;
		else if (html.startsWith("</div>", i)) {
			depth--;
			if (depth === 0) return html.slice(start, i + "</div>".length);
		}
		i++;
	}
	throw new Error(`${id} never closed`);
}

it("leads the heading row's routing cluster with the pause state", () => {
	const html = render(makeAccount({ paused: true, priority: 3 }));
	const heading = region(html, "account-heading-row");

	// In the row that names the account, and ahead of "Priority: 3" there — the
	// first chip of the cluster it governs, because a paused account's priority
	// decides nothing.
	expect(heading).toContain("acct");
	expect(heading.indexOf("Paused")).toBeGreaterThan(-1);
	expect(heading.indexOf("Paused")).toBeLessThan(
		heading.indexOf("Priority: 3"),
	);
	// And nowhere else: not in the chip row below it, beside the causes that
	// explain the pause.
	expect(region(html, "account-status-chips")).not.toContain("Paused");
});

describe("AccountListItem — Force Reset placement", () => {
	// Hard-limited and unpaused: what `showForceReset` is derived from.
	const LIMITED = makeAccount({
		rateLimitStatus: "Rate limited",
		rateLimitedUntil: Date.now() + 60 * 60 * 1000,
	});

	it("offers the action in the header strip, not a panel of its own", () => {
		const html = render(LIMITED);

		expect(region(html, "account-actions")).toContain("Force Reset");
		expect(html).not.toContain('data-testid="account-info-row"');
	});

	it("lets the strip wrap so it cannot crowd the account name", () => {
		// The narrow-width result is not observable in static markup; this class
		// is the mechanism behind it.
		expect(region(render(LIMITED), "account-actions")).toContain("flex-wrap");
	});
});

it("pads the card and separates its groups by the row step", () => {
	const html = render(makeAccount({}));

	expect(html).toContain("p-group border rounded-lg");
	expect(html).toContain("space-y-row border-border");
});

it("leaves the activity figures to the Usage page", () => {
	const html = render(makeAccount({ sessionStats: SESSION_STATS }));

	expect(html).not.toContain("Active: 324 reqs");
	expect(html).not.toContain("$98.15 plan");
	expect(html).not.toContain('aria-label="Show active session details"');
});

describe("AccountListItem — compact quota cards", () => {
	it("asks RateLimitProgress for the compact single-row layout", () => {
		const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const html = render(
			makeAccount({
				rateLimitReset: future,
				usageData: {
					five_hour: { utilization: 12, resets_at: future },
					seven_day: { utilization: 42, resets_at: future },
				},
			}),
		);

		expect(html).toContain("xl:grid-flow-col");
		expect(html).toContain("rounded-lg border p-item");
	});
});

it("renders Devin account identity and a metadata-only refresh action", () => {
	const html = render(
		makeAccount({
			provider: "devin",
			identityEmail: "devin@example.test",
			identityExternalId: "devin-account-123",
			identityPlanTier: "free",
		}),
	);
	expect(html).toContain("devin@example.test · Free");
	expect(html).toContain("Account ID: devin-account-123");
	expect(html).toContain("#devin-ac");
	expect(html).toContain(
		"Refresh Devin account and usage metadata (does not consume inference quota)",
	);
});

describe("AccountListItem — OpenRouter details", () => {
	it("offers metadata refresh for API-key accounts without OAuth tokens", () => {
		const html = render(
			makeAccount({ provider: "openrouter", hasRefreshToken: false }),
		);
		expect(html).toContain("Refresh OpenRouter account details and usage");
		expect(html).toContain("OpenRouter account details unavailable");
	});
	it("does not offer official OpenRouter metadata for custom endpoints", () => {
		const html = render(
			makeAccount({
				provider: "openrouter",
				customEndpoint: "https://example.test",
			}),
		);
		expect(html).not.toContain("Refresh OpenRouter account details");
		expect(html).not.toContain("OpenRouter account details unavailable");
	});
});
