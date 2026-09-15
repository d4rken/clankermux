import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { AccountPayment } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../../api";
import { PaymentsHistoryCard } from "./PaymentsHistoryCard";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The delete confirmation's target and its error have to move together. They
 * did not: Cancel set the target to null directly instead of going through the
 * dialog's close handler, and the row button set a new target without touching
 * the error, so a failure on one payment greeted the operator on the next one
 * they tried to delete — before any request had been made for it.
 */

let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient;

function payment(overrides: Partial<AccountPayment> = {}): AccountPayment {
	return {
		id: "p1",
		accountId: "a1",
		accountName: "acct-one",
		kind: "credits",
		paidDate: "2026-09-01",
		amountUsd: 25,
		notes: null,
		...overrides,
	} as AccountPayment;
}

const payments = [
	payment(),
	payment({ id: "p2", accountName: "acct-two", amountUsd: 40 }),
];

async function mount() {
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
			mutations: { retry: false },
		},
	});
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<QueryClientProvider client={client}>
				<PaymentsHistoryCard payments={payments} />
			</QueryClientProvider>,
		);
	});
}

function deleteButtons() {
	return [...document.querySelectorAll('button[title="Delete payment"]')];
}

async function openConfirmFor(index: number) {
	const button = deleteButtons()[index];
	if (!button) throw new Error(`no delete button at index ${index}`);
	await act(async () => (button as HTMLButtonElement).click());
}

async function click(text: string) {
	const found = [...document.querySelectorAll("button")].find(
		(node) => node.textContent?.trim() === text,
	);
	if (!found) throw new Error(`Missing button: ${text}`);
	await act(async () => found.click());
}

function dialog() {
	return document.querySelector('[role="dialog"]');
}

function alertText() {
	return dialog()?.querySelector('[role="alert"]')?.textContent ?? null;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	host?.remove();
	host = null;
	mock.restore();
});

describe("PaymentsHistoryCard delete confirmation", () => {
	it("reports a failed delete in the confirmation", async () => {
		spyOn(api, "deletePayment").mockImplementation(async () => {
			throw new Error("Payment is referenced by a closed period");
		});
		await mount();

		await openConfirmFor(0);
		await click("Delete");

		expect(alertText()).toContain("closed period");
		// Still open: the operator can read it and decide.
		expect(dialog()).not.toBeNull();
	});

	it("does not carry that failure into another payment's confirmation", async () => {
		spyOn(api, "deletePayment").mockImplementation(async () => {
			throw new Error("first payment failed");
		});
		await mount();

		await openConfirmFor(0);
		await click("Delete");
		expect(alertText()).toContain("first payment failed");

		// Cancel used to bypass the dialog's close handler entirely, so the error
		// survived into the next confirmation.
		await click("Cancel");
		await openConfirmFor(1);

		expect(alertText()).toBeNull();
	});

	it("closes on a successful delete", async () => {
		spyOn(api, "deletePayment").mockImplementation(
			async () => undefined as never,
		);
		await mount();

		await openConfirmFor(0);
		await click("Delete");

		expect(dialog()).toBeNull();
	});
});
