import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../../api";
import { AccountAddForm } from "./AccountAddForm";

/**
 * A Grok sign-in that the user walks away from by switching the account type
 * must stop polling: a later `complete` from the server would otherwise reset
 * the form and report success for a flow the user is no longer looking at.
 *
 * Real timers, not a captured callback: the question is whether the 3 s
 * interval is still scheduled after the switch, and firing a captured handler
 * by hand would answer "yes" regardless.
 */

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const AUTH_URL = "https://accounts.x.ai/device?user_code=ABCD-1234";
const USER_CODE = "ABCD-1234";
/** Poll cadence (3 s) plus the completion delay (1.5 s), with margin. */
const PAST_POLL_AND_COMPLETION_MS = 3000 + 1500 + 700;

let root: Root | null = null;
let host: HTMLElement | null = null;

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

function renderForm(onSuccess: () => void): Promise<void> {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	return act(async () => {
		root?.render(
			<AccountAddForm
				onAddAccount={async () => ({ authUrl: "", sessionId: "" })}
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
				onAddGrokAccount={async () => {}}
				onAddMimoAccount={async () => {}}
				onCancel={() => {}}
				onSuccess={onSuccess}
				onError={() => {}}
			/>,
		);
	});
}

/**
 * Pick a mode from the Radix Select by keyboard. It has no native `<select>`
 * behind it, and happy-dom has no pointer stack, so ArrowDown to open and Enter
 * on the option is the only way in.
 */
async function selectMode(optionText: string): Promise<void> {
	const trigger = document.querySelector("#mode") as HTMLElement;
	trigger.focus();
	await act(async () => {
		trigger.dispatchEvent(
			new globalThis.KeyboardEvent("keydown", {
				key: "ArrowDown",
				bubbles: true,
			}),
		);
	});
	const option = Array.from(document.querySelectorAll('[role="option"]')).find(
		(el) => el.textContent?.includes(optionText),
	);
	if (!option) throw new Error(`no option matching "${optionText}"`);
	await act(async () => {
		option.dispatchEvent(
			new globalThis.KeyboardEvent("keydown", {
				key: "Enter",
				bubbles: true,
			}),
		);
	});
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	host?.remove();
	host = null;
	mock.restore();
});

describe("AccountAddForm — Grok sign-in abandoned by a mode switch", () => {
	it("stops polling and never reports success after the user leaves Grok mode", async () => {
		spyOn(api, "initGrokSubscriptionDeviceFlow").mockImplementation(
			async () => ({
				sessionId: "grok-session-1",
				authUrl: AUTH_URL,
				userCode: USER_CODE,
			}),
		);
		// The server finishes the sign-in on whatever poll next reaches it.
		const status = spyOn(
			api,
			"getGrokSubscriptionAuthStatus",
		).mockImplementation(async () => ({ status: "complete" as const }));
		const onSuccess = mock(() => {});

		await renderForm(onSuccess);
		await selectMode("Grok (Subscription)");
		await act(async () => {
			typeInto(
				document.querySelector("#name") as HTMLInputElement,
				"work-account",
			);
		});
		await act(async () => {
			byText<HTMLButtonElement>("button", "Sign in with Grok").click();
		});
		// The flow really started: its hand-off is on screen.
		expect(document.querySelector(`a[href="${AUTH_URL}"]`)).not.toBeNull();

		await selectMode("Codex (OpenAI OAuth)");
		expect(document.body.textContent).toContain("Sign in with Codex");
		const pollsAtSwitch = status.mock.calls.length;

		await act(async () => {
			await new Promise((resolve) =>
				setTimeout(resolve, PAST_POLL_AND_COMPLETION_MS),
			);
		});

		expect(onSuccess).not.toHaveBeenCalled();
		expect(status.mock.calls.length - pollsAtSwitch).toBe(0);
	}, 15_000);
});
