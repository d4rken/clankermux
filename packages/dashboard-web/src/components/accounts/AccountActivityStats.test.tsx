import { describe, expect, it } from "bun:test";
import type { AccountResponse } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountActivityStats } from "./AccountActivityStats";

function makeAccount(
	overrides: Partial<AccountResponse> = {},
): AccountResponse {
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
		...overrides,
	} as AccountResponse;
}

/**
 * The component renders the `account-activity-stats` region and nothing else,
 * so the markup below IS that region — no scoping helper needed here, unlike
 * the host cards that surround it with chips and quota bars.
 */
function render(account: AccountResponse): string {
	return renderToStaticMarkup(<AccountActivityStats account={account} />);
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

describe("AccountActivityStats — session stats", () => {
	it("drops the standalone session token line", () => {
		const html = render(makeAccount({ sessionStats: SESSION_STATS }));

		// The dense second row is gone; its request count already appears in the
		// first row as the server-rendered "Active: 324 reqs".
		expect(html).not.toContain("Session: 324 req");
		expect(html).toContain("Active: 324 reqs");
	});

	it("folds the session cost into the figures row", () => {
		const html = render(makeAccount({ sessionStats: SESSION_STATS }));

		// Placement, not presence: the cost has to sit in the same row as the
		// request counts, which is precisely what the old standalone row did not.
		expect(html).toContain("Active: 324 reqs");
		expect(html).toContain("$98.15 plan");
	});

	it("shows api cost alongside plan cost when both are non-zero", () => {
		const html = render(
			makeAccount({
				sessionStats: { ...SESSION_STATS, apiCostUsd: 1.2 },
			}),
		);

		expect(html).toContain("$98.15 plan");
		expect(html).toContain("$1.20 api");
	});

	it("omits a cost segment that is zero", () => {
		const html = render(
			makeAccount({
				sessionStats: { ...SESSION_STATS, planCostUsd: 0 },
			}),
		);

		expect(html).not.toContain("plan");
		expect(html).not.toContain("api");
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

	it("groups the headline figures in one row", () => {
		const html = render(
			makeAccount({
				requestCount: 130_012,
				activeSessionCount: 1,
				sessionStats: SESSION_STATS,
			}),
		);

		expect(html).toContain(">130,012</dd>");
		expect(html).toContain("Clients · 15m");
		expect(html).toContain("Active: 324 reqs");
		expect(html).toContain("$98.15 plan");
	});
});
