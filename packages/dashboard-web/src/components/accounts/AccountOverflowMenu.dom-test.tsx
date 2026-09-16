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

async function mountAccountItem(
	account: Account,
	onRemove: (account: Account) => void = noop,
): Promise<void> {
	await mount(
		<AccountListItem
			account={account}
			onPauseToggle={noop}
			onForceResetRateLimit={noop}
			onRefreshUsage={async () => {}}
			onRemove={onRemove}
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

async function openOverflowMenu(): Promise<void> {
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

function menuItemByLabel(label: string): HTMLElement {
	const item = Array.from(
		document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
	).find((element) => element.textContent?.trim() === label);
	expect(item).toBeDefined();
	return item as HTMLElement;
}

/** Radix selects a menu item from `pointerup` after a `pointerdown` on it. */
async function selectMenuItem(item: HTMLElement): Promise<void> {
	await act(async () => {
		item.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
		item.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
		item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	// The menu unmounts asynchronously, and its focus restore runs then — after
	// the note editor has already mounted and focused itself.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

describe("AccountListItem — overflow menu", () => {
	it("offers Delete Account in the menu rather than as a separate button", async () => {
		let removed: Account | null = null;
		await mountAccountItem(makeAccount(), (account) => {
			removed = account;
		});

		// The delete button used to sit in this strip untitled, next to the
		// overflow trigger. Asserting the strip's full inventory by title is what
		// catches it coming back: an icon-only button carries nothing else to
		// match on.
		const strip = document.querySelector('[data-testid="account-actions"]');
		expect(
			Array.from(strip?.querySelectorAll("button") ?? []).map((button) =>
				button.getAttribute("title"),
			),
		).toEqual([
			"Refresh usage data (restarts usage polling and refreshes token if expired)",
			"Pause account",
			"More actions",
		]);

		await openOverflowMenu();
		await selectMenuItem(menuItemByLabel("Delete Account"));

		expect((removed as Account | null)?.id).toBe("a1");
	});

	it("leaves the caret in the note field after Add note", async () => {
		await mountAccountItem(makeAccount({ notes: null }));
		await openOverflowMenu();
		await selectMenuItem(menuItemByLabel("Add note"));

		const field = document.querySelector("textarea");
		expect(field).not.toBeNull();
		expect(document.activeElement).toBe(field);
	});

	it("leaves the caret after the existing text when editing a note", async () => {
		await mountAccountItem(makeAccount({ notes: "existing note" }));

		const pencil = document.querySelector<HTMLButtonElement>(
			'button[title="Edit note"]',
		);
		expect(pencil).not.toBeNull();
		await act(async () => {
			pencil?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		const field = document.querySelector("textarea");
		expect(document.activeElement).toBe(field);
		expect(field?.selectionStart).toBe("existing note".length);
	});
});
