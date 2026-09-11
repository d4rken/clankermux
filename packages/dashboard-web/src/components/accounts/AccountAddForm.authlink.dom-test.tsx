import {
	afterAll,
	afterEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../../api";
import { AccountAddForm } from "./AccountAddForm";

/**
 * Every authorization hand-off in the add-account form has to reach the user as
 * a real link plus a Copy button, and nothing may be opened automatically: the
 * browser showing the dashboard is usually signed in to a different account
 * than the one being added, so an auto-opened tab lands in the wrong browser.
 * `window.open` is therefore counted, not merely stubbed — zero calls is the
 * guarantee.
 *
 * All three legs are covered: the Anthropic/console code flow and the Codex and
 * Qwen device flows (which also surface a user code to copy).
 *
 * Mounted for real rather than rendered to static markup: the link only exists
 * after the init call resolves, which needs a click and a state transition.
 */

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const AUTH_URL =
	"https://claude.ai/oauth/authorize?code=true&client_id=abc123&state=xyz";
const USER_CODE = "ABCD-1234";
/** Failure the stubbed status poll reports, to send a leg to its error step. */
const POLL_ERROR = "boom";
/** Poll cadence both device flows hand to `setInterval`. */
const POLL_INTERVAL_MS = 3000;

let root: Root | null = null;
let host: HTMLElement | null = null;
let openCalls = 0;
const realWindowOpen = globalThis.window.open;
globalThis.window.open = ((..._args: unknown[]) => {
	openCalls += 1;
	return null;
}) as unknown as typeof globalThis.window.open;

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

function renderForm(
	onAddAccount: () => Promise<{ authUrl: string; sessionId: string }>,
): Promise<void> {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	return act(async () => {
		root?.render(
			<AccountAddForm
				onAddAccount={onAddAccount}
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
}

/** Mount the form and drive it to the "Enter Authorization Code" step. */
async function mountAtCodeStep(authUrl: string): Promise<void> {
	await renderForm(async () => ({ authUrl, sessionId: "session-1" }));

	const name = document.querySelector("#name") as HTMLInputElement;
	await act(async () => {
		typeInto(name, "work-account");
	});
	await act(async () => {
		byText<HTMLButtonElement>("button", "Continue").click();
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

/**
 * Swaps `setInterval` for a pass-through that also hands back the leg's poll
 * callback, so a test can drive one poll tick synchronously instead of waiting
 * out the 3 s cadence. Only the form's own interval is captured; every other
 * timer (React, happy-dom) is scheduled untouched. Undone by `mock.restore()`.
 */
function capturePoll(): { fire: () => Promise<void> } {
	const captured: { poll: ((...args: unknown[]) => unknown) | null } = {
		poll: null,
	};
	const realSetInterval = globalThis.setInterval;
	spyOn(globalThis, "setInterval").mockImplementation(((
		handler: unknown,
		ms?: number,
		...args: unknown[]
	) => {
		if (typeof handler === "function" && ms === POLL_INTERVAL_MS) {
			captured.poll = handler as (...args: unknown[]) => unknown;
		}
		return realSetInterval.call(
			globalThis,
			handler as () => void,
			ms as number,
			...args,
		);
	}) as unknown as typeof globalThis.setInterval);

	return {
		fire: async () => {
			const poll = captured.poll;
			if (!poll) throw new Error("no poll callback captured");
			await act(async () => {
				await poll();
			});
		},
	};
}

/** Mount the form, pick this leg's mode, name the account and click Start. */
async function startLeg(optionText: string, startLabel: string): Promise<void> {
	await renderForm(async () => ({
		authUrl: AUTH_URL,
		sessionId: "session-1",
	}));
	await selectMode(optionText);

	const name = document.querySelector("#name") as HTMLInputElement;
	await act(async () => {
		typeInto(name, "work-account");
	});
	await act(async () => {
		byText<HTMLButtonElement>("button", startLabel).click();
	});
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	host?.remove();
	host = null;
	openCalls = 0;
	mock.restore();
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
		expect(
			document.querySelector('button[title="Copy authorization link"]'),
		).not.toBeNull();
		expect(openCalls).toBe(0);
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

/** Installs the device-flow spies for one leg. */
type StubDeviceFlow = () => void;

/**
 * Re-points this leg's status poll at a failure, so the next poll tick sends it
 * to its error step.
 */
type StubStatusError = () => void;

/**
 * Re-installs this leg's init spy so it only resolves once `gate` does, holding
 * the retry in its pending step.
 */
type StubGatedInit = (gate: () => Promise<void>) => void;

const DEVICE_FLOWS: Array<
	[string, string, string, StubDeviceFlow, StubStatusError, StubGatedInit]
> = [
	[
		"Codex",
		"Codex (OpenAI OAuth)",
		"Sign in with Codex",
		() => {
			spyOn(api, "initCodexDeviceFlow").mockImplementation(async () => ({
				sessionId: "s1",
				verificationUrl: AUTH_URL,
				userCode: USER_CODE,
			}));
			spyOn(api, "getCodexAuthStatus").mockImplementation(async () => ({
				status: "pending" as const,
			}));
		},
		() => {
			spyOn(api, "getCodexAuthStatus").mockImplementation(async () => ({
				status: "error" as const,
				error: POLL_ERROR,
			}));
		},
		(gate) => {
			spyOn(api, "initCodexDeviceFlow").mockImplementation(async () => {
				await gate();
				return {
					sessionId: "s2",
					verificationUrl: AUTH_URL,
					userCode: USER_CODE,
				};
			});
		},
	],
	[
		"Qwen",
		"Qwen (Alibaba Cloud OAuth)",
		"Sign in with Qwen",
		() => {
			spyOn(api, "initQwenDeviceFlow").mockImplementation(async () => ({
				sessionId: "s1",
				authUrl: AUTH_URL,
				userCode: USER_CODE,
			}));
			spyOn(api, "getQwenAuthStatus").mockImplementation(async () => ({
				status: "pending" as const,
			}));
		},
		() => {
			spyOn(api, "getQwenAuthStatus").mockImplementation(async () => ({
				status: "error" as const,
				error: POLL_ERROR,
			}));
		},
		(gate) => {
			spyOn(api, "initQwenDeviceFlow").mockImplementation(async () => {
				await gate();
				return {
					sessionId: "s2",
					authUrl: AUTH_URL,
					userCode: USER_CODE,
				};
			});
		},
	],
];

describe.each(
	DEVICE_FLOWS,
)("AccountAddForm — %s device flow hand-off", (_leg, optionText, startLabel, stubDeviceFlow, stubStatusError, stubGatedInit) => {
	it("renders a copyable link and user code, and never opens a tab", async () => {
		stubDeviceFlow();
		await startLeg(optionText, startLabel);

		expect(openCalls).toBe(0);
		const link = document.querySelector<HTMLAnchorElement>(
			`a[href="${AUTH_URL}"]`,
		);
		expect(link).not.toBeNull();
		expect(link?.textContent).toBe("Open authorization page");
		expect(
			document.querySelector('button[title="Copy authorization link"]'),
		).not.toBeNull();
		expect(
			document.querySelector('button[title="Copy user code"]'),
		).not.toBeNull();
		expect(document.body.textContent).toContain(USER_CODE);
	});

	it("drops the failed attempt's link and code while the retry is in flight", async () => {
		// Attempt 1: the init resolves at once, then the first poll tick
		// reports a failure, so the leg lands on its error step with the URL
		// and user code still held in form state.
		stubDeviceFlow();
		stubStatusError();
		const captured = capturePoll();

		await startLeg(optionText, startLabel);
		expect(document.querySelector(`a[href="${AUTH_URL}"]`)).not.toBeNull();

		await captured.fire();
		expect(document.body.textContent).toContain(POLL_ERROR);
		// The error step renders no hand-off, so nothing is on screen yet.
		expect(document.querySelector("a[href]")).toBeNull();

		// Attempt 2, held open. The footer start button is what restarts a
		// failed leg (the Alert's "Try again" only returns it to idle), and the
		// retry re-enters the pending step before the new device code exists,
		// so the failed attempt's link and code — which belong to a session the
		// server has finished with — must not still be on screen.
		let release: (() => void) | null = null;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		stubGatedInit(() => gate);
		await act(async () => {
			byText<HTMLButtonElement>("button", startLabel).click();
		});

		expect(document.querySelector("a[href]")).toBeNull();
		expect(
			document.querySelector('button[title="Copy authorization link"]'),
		).toBeNull();
		expect(document.querySelector('button[title="Copy user code"]')).toBeNull();
		expect(document.body.textContent).toContain("Requesting a device code…");

		await act(async () => {
			release?.();
			await gate;
		});

		expect(document.querySelector(`a[href="${AUTH_URL}"]`)).not.toBeNull();
		expect(openCalls).toBe(0);
	});
});
