import { afterEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Account } from "../../api";
import { AccountPriorityDialog } from "./AccountPriorityDialog";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A rejected save used to reach the operator only through the parent's
 * page-level `actionError`, which renders behind this dialog's own overlay —
 * so the dialog sat there looking idle and the message appeared only after it
 * was dismissed. These drive the whole chain a static render cannot: a rejected
 * save, the message appearing inside the dialog, the typed value surviving, and
 * a retry that succeeds.
 */

let root: Root | null = null;
let host: HTMLElement | null = null;

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "a1",
		name: "acct",
		provider: "anthropic",
		priority: 3,
		...overrides,
	} as Account;
}

/**
 * Close requests are RECORDED rather than ignored. A fixture that hardcodes
 * `isOpen` and drops `onOpenChange` cannot tell "the dialog stayed open" from
 * "the dialog asked to close and the fixture refused", which is most of what
 * these tests claim.
 */
let closeRequests: boolean[] = [];

async function render(
	account: Account,
	onUpdatePriority: (id: string, priority: number) => Promise<void>,
) {
	if (!root) {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	}
	await act(async () =>
		root?.render(
			<AccountPriorityDialog
				account={account}
				isOpen={true}
				onOpenChange={(open) => closeRequests.push(open)}
				onUpdatePriority={onUpdatePriority}
			/>,
		),
	);
}

function button(text: string) {
	const found = [...document.querySelectorAll("button")].find(
		(node) => node.textContent?.trim() === text,
	);
	if (!found) throw new Error(`Missing button: ${text}`);
	return found;
}

async function click(text: string) {
	await act(async () => button(text).click());
}

async function type(id: string, value: string) {
	await act(async () => {
		const input = document.getElementById(id) as HTMLInputElement;
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function priorityInput() {
	return document.getElementById("priority") as HTMLInputElement;
}

/** Scoped to the dialog: "there is an alert somewhere" is not the claim. */
function alertText() {
	return (
		document.querySelector('[role="dialog"]')?.querySelector('[role="alert"]')
			?.textContent ?? null
	);
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	host?.remove();
	host = null;
	closeRequests = [];
	mock.restore();
});

describe("AccountPriorityDialog save failures", () => {
	it("shows the failure in the dialog and keeps what was typed", async () => {
		const onUpdatePriority = mock(async () => {
			throw new Error("Priority must be between 0 and 100");
		});
		await render(makeAccount(), onUpdatePriority);

		await type("priority", "42");
		await click("Update Priority");

		expect(alertText()).toContain("Priority must be between 0 and 100");
		// Still holding the operator's value: the whole point of reporting in here
		// rather than on the page behind the overlay.
		expect(priorityInput().value).toBe("42");
		// And it never ASKED to close. Without this the two assertions above would
		// also hold for a dialog that requested closure and was overruled.
		expect(closeRequests).toEqual([]);
		expect(onUpdatePriority).toHaveBeenCalledWith("a1", 42);
	});

	it("re-enables the button so the save can be retried", async () => {
		const onUpdatePriority = mock(async () => {
			throw new Error("nope");
		});
		await render(makeAccount(), onUpdatePriority);

		await click("Update Priority");

		expect(button("Update Priority").hasAttribute("disabled")).toBe(false);
	});

	it("clears the message when a retry succeeds", async () => {
		let attempt = 0;
		const onUpdatePriority = mock(async () => {
			attempt += 1;
			if (attempt === 1) throw new Error("transient");
		});
		await render(makeAccount(), onUpdatePriority);

		await type("priority", "7");
		await click("Update Priority");
		expect(alertText()).toContain("transient");

		await click("Update Priority");

		expect(alertText()).toBeNull();
		expect(onUpdatePriority).toHaveBeenCalledTimes(2);
		// A success DOES ask to close, so "no alert" cannot be satisfied by a
		// dialog that quietly did nothing on the second click.
		expect(closeRequests).toEqual([false]);
	});

	it("does not carry a failure across to a different account", async () => {
		const onUpdatePriority = mock(async () => {
			throw new Error("first account failed");
		});
		await render(makeAccount({ id: "a1" }), onUpdatePriority);
		await click("Update Priority");
		expect(alertText()).toContain("first account failed");

		await render(
			makeAccount({ id: "a2", name: "other", priority: 9 }),
			async () => {},
		);

		expect(alertText()).toBeNull();
		expect(priorityInput().value).toBe("9");
	});
});
