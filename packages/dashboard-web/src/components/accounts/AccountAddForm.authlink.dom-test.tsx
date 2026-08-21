import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AccountAddForm } from "./AccountAddForm";

/**
 * The OAuth code-entry step has to keep the authorization URL reachable.
 *
 * `window.open` is the only place the URL used to go, so a popup blocker, a
 * closed tab, or a browser on another machine left the user with no way back to
 * it. The re-auth dialogs already render it as an anchor; this is the same
 * guarantee for the add-account flow.
 *
 * Mounted for real rather than rendered to static markup: the link only exists
 * after `onAddAccount` resolves, which needs a click and a state transition.
 */

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const AUTH_URL =
	"https://claude.ai/oauth/authorize?code=true&client_id=abc123&state=xyz";

let root: Root | null = null;
let host: HTMLElement | null = null;
/**
 * `window.open` is stubbed, not asserted on: happy-dom would otherwise try to
 * navigate a real detached window to the URL. The point of the change is that
 * the flow no longer *depends* on this call succeeding.
 */
const realWindowOpen = globalThis.window.open;
globalThis.window.open = (() => null) as typeof globalThis.window.open;

/** Set a controlled input's value the way a real keystroke would. */
function typeInto(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(
		globalThis.HTMLInputElement.prototype,
		"value",
	)?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function byText<T extends Element>(selector: string, text: string): T {
	const match = Array.from(document.querySelectorAll(selector)).find(
		(el) => el.textContent?.trim() === text,
	);
	if (!match) throw new Error(`no ${selector} with text "${text}"`);
	return match as unknown as T;
}

/** Mount the form and drive it to the "Enter Authorization Code" step. */
async function mountAtCodeStep(authUrl: string): Promise<void> {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<AccountAddForm
				onAddAccount={async () => ({ authUrl, sessionId: "session-1" })}
				onCompleteAccount={async () => {}}
				onAddZaiAccount={async () => {}}
				onAddMinimaxAccount={async () => {}}
				onAddAnthropicCompatibleAccount={async () => {}}
				onAddOpenAIAccount={async () => {}}
				onAddAlibabaCodingPlanAccount={async () => {}}
				onAddKiloAccount={async () => {}}
				onAddOpenRouterAccount={async () => {}}
				onAddOllamaAccount={async () => {}}
				onAddOllamaCloudAccount={async () => {}}
				onCancel={() => {}}
				onSuccess={() => {}}
				onError={() => {}}
			/>,
		);
	});

	const name = document.querySelector("#name") as HTMLInputElement;
	await act(async () => {
		typeInto(name, "work-account");
	});
	await act(async () => {
		byText<HTMLButtonElement>("button", "Continue").click();
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

afterAll(() => {
	globalThis.window.open = realWindowOpen;
});

describe("AccountAddForm — authorization link", () => {
	it("renders the authorization URL as an anchor on the code step", async () => {
		await mountAtCodeStep(AUTH_URL);

		expect(document.body.textContent).toContain("Authorization Code");
		const link = document.querySelector<HTMLAnchorElement>(
			`a[href="${AUTH_URL}"]`,
		);
		expect(link).not.toBeNull();
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(link?.textContent).toBe("Open authorization page");
	});

	it("drops the link when the flow is cancelled", async () => {
		await mountAtCodeStep(AUTH_URL);
		await act(async () => {
			byText<HTMLButtonElement>("button", "Cancel").click();
		});

		expect(document.querySelector(`a[href="${AUTH_URL}"]`)).toBeNull();
		expect(document.querySelector("#name")).not.toBeNull();
	});
});
