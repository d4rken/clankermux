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
 * The inset panel carrying request, client, session, cost and re-auth figures.
 *
 * Anchored on the panel's `data-testid`, never on its class string: this helper
 * used to match the full `class="…"` verbatim, so it threw "info row not found"
 * the moment the panel moved onto the shared InsetPanel primitive. What these
 * tests are about is the row's CONTENT, so its styling must be free to change.
 */
function infoRow(html: string): string {
	const testid = html.indexOf('data-testid="account-info-row"');
	if (testid === -1) throw new Error("info row not found");
	const start = html.lastIndexOf("<div", testid);
	if (start === -1) throw new Error("info row has no element start");
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
	throw new Error("info row never closed");
}

describe("AccountListItem — session stats", () => {
	it("drops the standalone session token line", () => {
		const html = render(makeAccount({ sessionStats: SESSION_STATS }));

		// The dense second row is gone; its request count already appears in the
		// first row as the server-rendered "Active: 324 reqs".
		expect(html).not.toContain("Session: 324 req");
		expect(html).toContain("Active: 324 reqs");
	});

	it("folds the session cost into the first info row", () => {
		const row = infoRow(render(makeAccount({ sessionStats: SESSION_STATS })));

		// Placement, not presence: the cost has to sit in the same row as the
		// request counts, which is precisely what the old standalone row did not.
		expect(row).toContain("Active: 324 reqs");
		expect(row).toContain("$98.15 plan");
	});

	it("pads the card and separates its four groups by the row step", () => {
		const html = render(makeAccount({}));

		expect(html).toContain("p-group border rounded-lg");
		expect(html).toContain("space-y-row border-border");
	});

	it("shows api cost alongside plan cost when both are non-zero", () => {
		const row = infoRow(
			render(
				makeAccount({
					sessionStats: { ...SESSION_STATS, apiCostUsd: 1.2 },
				}),
			),
		);

		expect(row).toContain("$98.15 plan");
		expect(row).toContain("$1.20 api");
	});

	it("omits a cost segment that is zero", () => {
		const row = infoRow(
			render(
				makeAccount({
					sessionStats: { ...SESSION_STATS, planCostUsd: 0 },
				}),
			),
		);

		expect(row).not.toContain("plan");
		expect(row).not.toContain("api");
	});

	it("advertises the token breakdown as a click-open detail", () => {
		const html = render(makeAccount({ sessionStats: SESSION_STATS }));

		// The dotted underline and button semantics make the hidden detail
		// discoverable without relying on hover-only native title text.
		expect(html).toContain('aria-label="Show active session details"');
		expect(html).toContain("underline decoration-dotted");
		expect(html).not.toContain("cursor-help");
	});

	it("renders no session segments at all without session stats", () => {
		const html = render(makeAccount({ sessionStats: null }));

		expect(html).not.toContain("cache↑");
		expect(html).not.toContain(" plan");
		// With nothing behind it, the session text advertises no tooltip either.
		expect(html).not.toContain("cursor-help");
		expect(html).toContain("Requests</dt><dd");
		expect(html).toContain(">1,204</dd>");
	});

	it("groups the headline figures in an inset metrics panel", () => {
		const html = render(
			makeAccount({
				requestCount: 130_012,
				activeSessionCount: 1,
				sessionStats: SESSION_STATS,
			}),
		);

		expect(html).toContain("bg-muted/30");
		expect(html).toContain(">130,012</dd>");
		expect(html).toContain("Clients · 15m");
		expect(html).toContain("Active: 324 reqs");
		expect(html).toContain("$98.15 plan");
	});
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
