import { afterEach, describe, expect, it } from "bun:test";
import type { AccountResponse } from "@clankermux/types";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Account } from "../../api";
import { AccountListItem } from "./AccountListItem";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

const noop = () => {};

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
		...overrides,
	} as Account;
}

async function mount(node: ReactNode): Promise<void> {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(node);
	});
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	host?.remove();
	host = null;
});

/**
 * Mounts the row with EVERY optional automation handler supplied and opens the
 * overflow menu. Nothing else in the suite opens it: `AccountListItem.test.tsx`
 * renders static markup with the dropdown closed and omits the optional
 * handlers, so the menu's automation group is otherwise never exercised.
 */
async function openAutomationMenu(account: Account): Promise<void> {
	await mount(
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
			onAutoPauseOnOverageToggle={noop}
			onPeakHoursPauseToggle={noop}
			onAutoApplyResetCreditsToggle={noop}
			onAutoApplyResetOnWeeklyLimitToggle={noop}
		/>,
	);

	const trigger = document.querySelector<HTMLButtonElement>(
		'button[title="More actions"]',
	);
	expect(trigger).not.toBeNull();
	// Radix opens the menu from `pointerdown`, not `click`.
	await act(async () => {
		trigger?.dispatchEvent(
			new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
		);
	});
}

interface MenuCheckbox {
	label: string;
	title: string;
	checked: boolean;
}

function automationItems(): MenuCheckbox[] {
	return Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).map(
		(element) => ({
			label: element.textContent ?? "",
			title: element.getAttribute("title") ?? "",
			checked: element.getAttribute("aria-checked") === "true",
		}),
	);
}

describe("AccountListItem — automation menu copy", () => {
	it("labels and explains every codex automation item", async () => {
		await openAutomationMenu(
			makeAccount({
				provider: "codex",
				autoFallbackEnabled: true,
				autoRefreshEnabled: false,
				// Protected: the inverted "allow credits" item must read unchecked.
				autoPauseOnOverageEnabled: true,
				autoApplyResetCreditsEnabled: true,
				autoApplyResetOnWeeklyLimitEnabled: false,
			}),
		);

		expect(automationItems()).toEqual([
			{
				label: "Auto-fallback",
				title:
					"Automatically switch back to this account from lower-priority ones when its rate limit resets. Requires multiple accounts with different priorities.",
				checked: true,
			},
			{
				label: "Auto-refresh",
				title:
					"Automatically sends a minimal message when the usage window resets to avoid cold-start latency. Does not affect OAuth token refreshing.",
				checked: false,
			},
			{
				label: "Allow credits past weekly limit",
				title:
					"When the weekly Codex limit is reached, allow this account to keep running on purchased credits. When OFF (default), the account pauses and traffic fails over to other accounts, then auto-resumes when the weekly window resets.",
				checked: false,
			},
			{
				label: "Auto-apply expiring usage resets",
				title:
					"Automatically consume a banked usage reset shortly (~10 min) before it expires so it isn't wasted. Applies even while paused, unless the account needs re-authentication.",
				checked: true,
			},
			{
				label: "Auto-apply reset at weekly limit",
				title:
					"Automatically consume a banked usage reset at 100% weekly usage when no usable Codex alternative is available. Respects API-key account pins. Manual pauses conserve weekly resets; an overage pause is lifted by the reset. At most one auto-apply per hour.",
				checked: false,
			},
		]);
	});

	it("labels and explains every anthropic automation item", async () => {
		await openAutomationMenu(
			makeAccount({
				provider: "anthropic",
				autoFallbackEnabled: false,
				autoRefreshEnabled: true,
				// Unprotected: the inverted "allow overage" item must read checked.
				autoPauseOnOverageEnabled: false,
			}),
		);

		expect(automationItems()).toEqual([
			{
				label: "Auto-fallback",
				title:
					"Automatically switch back to this account from lower-priority ones when its rate limit resets. Requires multiple accounts with different priorities.",
				checked: false,
			},
			{
				label: "Auto-refresh",
				title:
					"Automatically sends a minimal message when the usage window resets to avoid cold-start latency. Does not affect OAuth token refreshing.",
				checked: true,
			},
			{
				label: "Allow overage spend",
				title:
					"Allow this account to incur overage charges past its plan limit. When OFF (default), the account auto-pauses when overage usage is detected and resumes when the usage window resets. Note: detection relies on Anthropic reporting overage, so some overage may occur before pausing.",
				checked: true,
			},
		]);
	});

	it("labels and explains the zai peak-hours item", async () => {
		await openAutomationMenu(
			makeAccount({ provider: "zai", peakHoursPauseEnabled: true }),
		);

		expect(automationItems().at(-1)).toEqual({
			label: "Peak hours pause",
			title:
				"Automatically pause this account during Zai peak hours (14:00–18:00 SGT)",
			checked: true,
		});
	});

	it("labels and explains the compatible-provider billing item", async () => {
		await openAutomationMenu(
			makeAccount({ provider: "openai-compatible", billingType: "plan" }),
		);

		expect(automationItems()).toEqual([
			{
				label: "Plan billing",
				title: "Toggle plan billing for this account",
				checked: true,
			},
		]);
	});
});
