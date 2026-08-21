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
 * The single wrapping row that carries request counts, session info, cost and
 * the re-auth deadline. Isolating it is what lets these tests assert
 * *placement* rather than mere presence: the cost strings existed before this
 * change too, just one row lower.
 */
function infoRow(html: string): string {
	const marker =
		'<div class="flex flex-wrap items-center gap-x-row gap-y-tight text-sm">';
	const start = html.indexOf(marker);
	if (start === -1) throw new Error("info row not found");
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

	it("tightens the card padding and uses the item step for block spacing", () => {
		const html = render(makeAccount({}));

		expect(html).toContain("p-3 border rounded-lg");
		expect(html).toContain("space-y-item border-border");
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

	it("keeps the token breakdown reachable as a tooltip", () => {
		const html = render(makeAccount({ sessionStats: SESSION_STATS }));

		// Nothing is lost — the four token counts move from a visible row into
		// the title of the session segments.
		expect(html).toContain("↑72.2k in");
		expect(html).toContain("✦9.9M cache↑");
		expect(html).toContain("✦61.3M cache↓");
		expect(html).toContain("↓283.6k out");
		// …and they only ever appear inside a title attribute, never as text.
		expect(html).not.toMatch(/>[^<]*↑72\.2k in/);
	});

	it("renders no session segments at all without session stats", () => {
		const html = render(makeAccount({ sessionStats: null }));

		expect(html).not.toContain("cache↑");
		expect(html).not.toContain(" plan");
		// With nothing behind it, the session text advertises no tooltip either.
		expect(html).not.toContain("cursor-help");
		expect(html).toContain("1204 requests");
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
		expect(html).toContain("rounded-lg border p-2");
	});
});
