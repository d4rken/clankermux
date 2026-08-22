import { afterEach, describe, expect, it } from "bun:test";
import type { AccountResponse } from "@clankermux/types";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Account } from "../../api";
import { AccountListItem } from "./AccountListItem";
import { RateLimitProgress } from "./RateLimitProgress";

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
		requestCount: 130_012,
		totalRequests: 130_012,
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
		sessionInfo: "Active: 144 reqs",
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
		activeSessionCount: 1,
		sessionStats: {
			requests: 144,
			inputTokens: 72_200,
			cacheCreationInputTokens: 9_900_000,
			cacheReadInputTokens: 61_300_000,
			outputTokens: 283_600,
			planCostUsd: 6.67,
			apiCostUsd: 0,
		},
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

describe("account detail popovers", () => {
	it("opens the active-session token and cost breakdown on click", async () => {
		await mount(
			<AccountListItem
				account={makeAccount()}
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

		const trigger = document.querySelector<HTMLButtonElement>(
			'button[aria-label="Show active session details"]',
		);
		expect(trigger).not.toBeNull();
		expect(document.body.textContent).not.toContain("Cache write");

		await act(async () => trigger?.click());

		expect(document.body.textContent).toContain("Cache write");
		expect(document.body.textContent).toContain("9.9M tokens");
		expect(document.body.textContent).toContain("plan cost");
		expect(document.body.textContent).toContain("$6.67");
	});

	it("opens a quota projection from its underlined label on click", async () => {
		const reset = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
		await mount(
			<RateLimitProgress
				resetIso={null}
				usageData={{
					five_hour: { utilization: 30, resets_at: reset },
					seven_day: { utilization: 40, resets_at: reset },
				}}
				provider="anthropic"
				showWeekly
				compact
			/>,
		);

		const trigger = document.querySelector<HTMLButtonElement>(
			'button[aria-label="Show 5-hour usage details"]',
		);
		expect(trigger).not.toBeNull();
		expect(document.body.textContent).not.toContain("5-hour usage");

		await act(async () => trigger?.click());

		expect(document.body.textContent).toContain("5-hour usage");
		expect(document.body.textContent).toContain("before running out");
	});
});
