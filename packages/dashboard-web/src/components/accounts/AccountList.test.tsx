import { describe, expect, it } from "bun:test";
import type { AccountResponse } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../../api";
import type { AccountListSortMode } from "../../lib/account-list-sort";
import { AccountList } from "./AccountList";

function makeAccount(overrides: Partial<AccountResponse> = {}): Account {
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
		notes: null,
		billingType: null,
		renewalAnchor: null,
		renewalCadence: null,
		...overrides,
	} as Account;
}

const noop = () => {};

/** The account names in the order the list renders them. */
function renderedOrder(
	accounts: Account[],
	sortMode: AccountListSortMode,
): string[] {
	const markup = renderToStaticMarkup(
		<AccountList
			accounts={accounts}
			sortMode={sortMode}
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
	return accounts
		.map((account) => ({
			name: account.name,
			at: markup.indexOf(account.name),
		}))
		.filter((entry) => entry.at >= 0)
		.sort((a, b) => a.at - b.at)
		.map((entry) => entry.name);
}

/**
 * The list applies the order, not the tab that owns the picker. The renewal key
 * is resolved against "now", and this is the component holding the clock that
 * advances it.
 */
describe("AccountList ordering", () => {
	const accounts = [
		makeAccount({ id: "a", name: "zulu", provider: "codex" }),
		makeAccount({
			id: "b",
			name: "alpha",
			provider: "zai",
			refreshTokenExpiresAt: "2099-01-02T00:00:00.000Z",
		}),
		makeAccount({
			id: "c",
			name: "mike",
			provider: "anthropic",
			refreshTokenExpiresAt: "2099-01-01T00:00:00.000Z",
		}),
	];

	it("keeps the server order in default mode", () => {
		expect(renderedOrder(accounts, "default")).toEqual([
			"zulu",
			"alpha",
			"mike",
		]);
	});

	it("reorders by name", () => {
		expect(renderedOrder(accounts, "name")).toEqual(["alpha", "mike", "zulu"]);
	});

	it("reorders by soonest re-auth deadline, no-deadline accounts last", () => {
		expect(renderedOrder(accounts, "reauth")).toEqual([
			"mike",
			"alpha",
			"zulu",
		]);
	});

	it("reorders by provider", () => {
		// Anthropic, OpenAI, z.ai by display name.
		expect(renderedOrder(accounts, "provider")).toEqual([
			"mike",
			"zulu",
			"alpha",
		]);
	});

	it("renders the empty state without a sort applied", () => {
		expect(renderedOrder([], "name")).toEqual([]);
	});
});
