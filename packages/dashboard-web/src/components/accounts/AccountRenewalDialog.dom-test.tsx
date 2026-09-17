import { afterEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Account } from "../../api";
import { AccountRenewalDialog } from "./AccountRenewalDialog";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

const AUTOMATIC_LABEL = "Use the automatic estimate";

function account(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "primary",
		renewalAnchor: null,
		renewalAnchorSource: null,
		renewalCadence: null,
		renewalPriceUsd: null,
		identitySubscriptionStartedAt: null,
		identitySubscriptionEndsAt: null,
		identitySubscriptionWillRenew: null,
		identitySubscriptionStatus: null,
		...overrides,
	} as unknown as Account;
}

async function mount(
	acc: Account,
	handlers: {
		onUpdateRenewal?: AccountRenewalDialogHandlers["onUpdateRenewal"];
		onUseAutomaticRenewal?: AccountRenewalDialogHandlers["onUseAutomaticRenewal"];
		onOpenChange?: (open: boolean) => void;
	} = {},
) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<AccountRenewalDialog
				account={acc}
				isOpen={true}
				onOpenChange={handlers.onOpenChange ?? (() => {})}
				onUpdateRenewal={handlers.onUpdateRenewal ?? (async () => {})}
				onUseAutomaticRenewal={
					handlers.onUseAutomaticRenewal ?? (async () => {})
				}
			/>,
		);
	});
}

interface AccountRenewalDialogHandlers {
	onUpdateRenewal: (
		accountId: string,
		anchor: string | null,
		cadence: "monthly" | "yearly" | "none",
		priceUsd: number | null,
	) => Promise<void>;
	onUseAutomaticRenewal: (accountId: string) => Promise<void>;
}

function findButton(text: string): HTMLButtonElement | undefined {
	return [...document.querySelectorAll("button")].find(
		(b) => b.textContent?.trim() === text,
	);
}

async function click(text: string) {
	const button = findButton(text);
	if (!button) throw new Error(`Missing ${text}`);
	await act(async () => {
		button.click();
	});
}

function dialogText(): string {
	return document.body.textContent ?? "";
}

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	mock.restore();
});

describe("AccountRenewalDialog — handing tracking back to automatic", () => {
	it("hands a manual account back and closes", async () => {
		const calls: string[] = [];
		const opens: boolean[] = [];
		await mount(
			account({ renewalAnchor: "2026-01-14", renewalAnchorSource: "manual" }),
			{
				onUseAutomaticRenewal: async (id) => {
					calls.push(id);
				},
				onOpenChange: (open) => opens.push(open),
			},
		);

		await click(AUTOMATIC_LABEL);

		expect(calls).toEqual(["acc-1"]);
		expect(opens).toEqual([false]);
	});

	it("offers the hand-back for an account the operator cleared", async () => {
		await mount(
			account({ renewalAnchor: null, renewalAnchorSource: "manual" }),
		);

		expect(findButton(AUTOMATIC_LABEL)).toBeDefined();
	});

	it("does not offer it to an account already on automatic", async () => {
		await mount(account({ renewalAnchor: null, renewalAnchorSource: null }));

		expect(findButton(AUTOMATIC_LABEL)).toBeUndefined();
	});

	// A date saved before the provenance column existed: anchor set, source NULL.
	// Nothing estimates over it, so the account is not on automatic.
	it("offers the hand-back for a date that predates the provenance column", async () => {
		await mount(
			account({ renewalAnchor: "2026-01-14", renewalAnchorSource: null }),
		);

		expect(findButton(AUTOMATIC_LABEL)).toBeDefined();
	});

	it("keeps the dialog open when the hand-back fails, and shows why", async () => {
		const opens: boolean[] = [];
		await mount(
			account({ renewalAnchor: "2026-01-14", renewalAnchorSource: "manual" }),
			{
				onUseAutomaticRenewal: async () => {
					throw new Error("upstream exploded");
				},
				onOpenChange: (open) => opens.push(open),
			},
		);

		await click(AUTOMATIC_LABEL);

		expect(opens).toEqual([]);
		expect(document.querySelector("[role='alert']")?.textContent).toContain(
			"upstream exploded",
		);
	});
});

describe("AccountRenewalDialog — the three tracking states read differently", () => {
	it("a cleared account and a never-configured one do not look identical", async () => {
		await mount(
			account({ renewalAnchor: null, renewalAnchorSource: "manual" }),
		);
		const cleared = dialogText();
		await act(async () => root?.unmount());
		host?.remove();

		await mount(account({ renewalAnchor: null, renewalAnchorSource: null }));
		const never = dialogText();

		expect(cleared).not.toBe(never);
		expect(cleared.toLowerCase()).toContain("off");
		expect(never.toLowerCase()).toContain("automatic");
	});

	it("names an estimate as an estimate", async () => {
		await mount(
			account({
				renewalAnchor: "2026-04-10",
				renewalAnchorSource: "derived",
				identitySubscriptionStartedAt: new Date(2026, 3, 10, 12, 0).getTime(),
			}),
		);

		expect(dialogText().toLowerCase()).toContain("estimate");
	});

	it("names a date the operator set as their own", async () => {
		await mount(
			account({ renewalAnchor: "2026-01-14", renewalAnchorSource: "manual" }),
		);

		expect(dialogText().toLowerCase()).toContain("date you set");
	});
});
