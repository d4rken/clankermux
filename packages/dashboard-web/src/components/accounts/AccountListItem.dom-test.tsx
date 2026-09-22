import { afterEach, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Account } from "../../api";
import { AccountListItem } from "./AccountListItem";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
});

const noop = () => {};

it.each([
	"subscription_expired",
	"usage_permission_denied",
])("rechecks %s through the account refresh action and disables both refresh controls while pending", async (pauseReason) => {
	const account = {
		id: "account-to-recheck",
		name: "Claude expired",
		provider: "anthropic",
		paused: true,
		pauseReason,
		requestCount: 0,
		totalRequests: 0,
		created: "2026-01-01T00:00:00Z",
		tokenStatus: "valid",
		rateLimitStatus: "OK",
		priority: 0,
		hasRefreshToken: false,
		usageThrottledWindows: [],
		identitySubscriptionCheckedAt: null,
		identityProfileFetchedAt: null,
	} as unknown as Account;
	const calls: Account[] = [];
	let complete = () => {};
	const pending = new Promise<void>((resolve) => {
		complete = resolve;
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<AccountListItem
				account={account}
				onPauseToggle={noop}
				onForceResetRateLimit={noop}
				onRefreshUsage={async (target) => {
					calls.push(target);
					await pending;
				}}
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
	});
	const recheck = [...host.querySelectorAll("button")].find(
		(button) => button.textContent === "Recheck access",
	);
	const refresh = host.querySelector<HTMLButtonElement>(
		'button[title="Refresh usage data (restarts usage polling and refreshes token if expired)"]',
	);
	expect(recheck).toBeDefined();
	expect(refresh).not.toBeNull();
	await act(async () => recheck?.click());
	expect(calls).toEqual([account]);
	expect(recheck?.disabled).toBe(true);
	expect(recheck?.textContent).toBe("Checking access…");
	expect(refresh?.disabled).toBe(true);
	await act(async () => {
		recheck?.click();
		refresh?.click();
	});
	expect(calls).toHaveLength(1);
	await act(async () => {
		complete();
		await pending;
	});
	expect(recheck?.disabled).toBe(false);
	expect(recheck?.textContent).toBe("Recheck access");
	expect(refresh?.disabled).toBe(false);
});

/**
 * The refresh control is gated on `supportsUsagePolling`, not on a per-provider
 * list in this component — so a provider that gained a poller gains the button
 * with it. Asserted rather than assumed: the tile is the only place an operator
 * can ask for a reading, and the gate is a flag in another package.
 */
it("offers the usage refresh action on a grok-subscription account", async () => {
	const account = {
		id: "account-grok",
		name: "SuperGrok-1",
		provider: "grok-subscription",
		paused: false,
		requestCount: 0,
		totalRequests: 0,
		created: "2026-01-01T00:00:00Z",
		tokenStatus: "valid",
		rateLimitStatus: "OK",
		priority: 0,
		hasRefreshToken: true,
		usageThrottledWindows: [],
		identitySubscriptionCheckedAt: null,
		identityProfileFetchedAt: null,
	} as unknown as Account;
	const calls: Account[] = [];
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<AccountListItem
				account={account}
				onPauseToggle={noop}
				onForceResetRateLimit={noop}
				onRefreshUsage={async (target) => {
					calls.push(target);
				}}
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
	});
	const refresh = host.querySelector<HTMLButtonElement>(
		'button[title="Refresh usage data (restarts usage polling)"]',
	);
	expect(refresh).not.toBeNull();
	expect(refresh?.disabled).toBe(false);
	await act(async () => refresh?.click());
	expect(calls).toEqual([account]);
});
