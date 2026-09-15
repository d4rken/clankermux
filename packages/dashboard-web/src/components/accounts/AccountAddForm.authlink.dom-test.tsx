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
import { type Account, api } from "../../api";
import { AccountAddForm } from "./AccountAddForm";

/**
 * Every authorization hand-off in the add-account form has to reach the user as
 * a real link plus a Copy button, and nothing may be opened automatically: the
 * browser showing the dashboard is usually signed in to a different account
 * than the one being added, so an auto-opened tab lands in the wrong browser.
 * `window.open` is therefore counted, not merely stubbed — zero calls is the
 * guarantee.
 *
 * All four legs are covered: the Anthropic/console code flow, the Codex and
 * Qwen device flows (which also surface a user code to copy), and the Z.AI
 * sign-in whose redirect URL comes back by paste.
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
	callbacks: {
		onSuccess?: () => void;
		onError?: (message: string) => void;
	} = {},
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
				onAddGrokAccount={async () => {}}
				onCancel={() => {}}
				onSuccess={callbacks.onSuccess ?? (() => {})}
				onError={callbacks.onError ?? (() => {})}
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
		// `Reflect.apply` rather than `.call(...spread)`: the chosen `setInterval`
		// overload fixes its parameter list, so a spread argument has no rest slot
		// to land in. The receiver still has to be the global — happy-dom's timer
		// is a window method.
		return Reflect.apply(realSetInterval, globalThis, [handler, ms, ...args]);
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

const ZAI_LOGIN = {
	sessionId: "zai-session-1",
	authUrl: "https://chat.z.ai/api/oauth/authorize?client_id=abc&state=xyz",
	expiresAt: Date.now() + 600_000,
};
const REDIRECT_URL =
	"http://localhost:54548/callback?code=one-use-code&state=xyz";

/** Mount the form on the Z.AI leg with an account name already entered. */
async function mountZaiLeg(
	callbacks: {
		onSuccess?: () => void;
		onError?: (message: string) => void;
	} = {},
): Promise<void> {
	await renderForm(
		async () => ({ authUrl: AUTH_URL, sessionId: "session-1" }),
		callbacks,
	);
	await selectMode("z.ai");
	await act(async () => {
		typeInto(
			document.querySelector("#name") as HTMLInputElement,
			"work-account",
		);
	});
}

describe("AccountAddForm — Z.AI sign-in hand-off", () => {
	it("hands over the authorization link and asks for the redirect URL, opening nothing", async () => {
		const start = spyOn(api, "startZaiLogin").mockResolvedValue(ZAI_LOGIN);
		await renderForm(async () => ({ authUrl: AUTH_URL, sessionId: "s" }));
		await selectMode("z.ai");
		expect(
			byText<HTMLButtonElement>("button", "Sign in with Z.AI").disabled,
		).toBe(true);
		await act(async () => {
			typeInto(
				document.querySelector("#name") as HTMLInputElement,
				"work-account",
			);
		});
		await act(async () => {
			byText<HTMLButtonElement>("button", "Sign in with Z.AI").click();
		});

		expect(start).toHaveBeenCalledWith({ name: "work-account", priority: 0 });
		const link = document.querySelector<HTMLAnchorElement>(
			`a[href="${ZAI_LOGIN.authUrl}"]`,
		);
		expect(link?.textContent).toBe("Open authorization page");
		expect(
			document.querySelector('button[title="Copy authorization link"]'),
		).not.toBeNull();
		expect(document.querySelector("#zai-redirect")).not.toBeNull();
		expect(document.body.textContent).toContain("localhost:54548");
		expect(openCalls).toBe(0);
	});

	it("completes the sign-in with the pasted redirect URL", async () => {
		spyOn(api, "startZaiLogin").mockResolvedValue(ZAI_LOGIN);
		const complete = spyOn(api, "completeZaiLogin").mockResolvedValue({
			message: "added",
			account: {} as Account,
		});
		const onSuccess = mock(() => {});
		await mountZaiLeg({ onSuccess });
		await act(async () => {
			byText<HTMLButtonElement>("button", "Sign in with Z.AI").click();
		});
		expect(
			byText<HTMLButtonElement>("button", "Complete Z.AI sign-in").disabled,
		).toBe(true);
		await act(async () => {
			typeInto(
				document.querySelector("#zai-redirect") as HTMLInputElement,
				` ${REDIRECT_URL} `,
			);
		});
		await act(async () => {
			byText<HTMLButtonElement>("button", "Complete Z.AI sign-in").click();
		});

		expect(complete).toHaveBeenCalledWith({
			sessionId: ZAI_LOGIN.sessionId,
			code: REDIRECT_URL,
		});
		expect(onSuccess).toHaveBeenCalledTimes(1);
		expect(openCalls).toBe(0);
	});

	it("reports a failed sign-in through the form's error channel", async () => {
		spyOn(api, "startZaiLogin").mockRejectedValue(
			new Error("Z.AI login limit reached; wait for existing links to expire"),
		);
		const onError = mock((_message: string) => {});
		await mountZaiLeg({ onError });
		await act(async () => {
			byText<HTMLButtonElement>("button", "Sign in with Z.AI").click();
		});

		expect(onError).toHaveBeenCalledWith(
			"Z.AI login limit reached; wait for existing links to expire",
		);
		expect(document.querySelector("#zai-redirect")).toBeNull();
	});

	it("keeps the paste-an-API-key path available", async () => {
		await mountZaiLeg();
		const key = document.querySelector<HTMLInputElement>("#apiKey");
		expect(key?.type).toBe("password");
		expect(key?.getAttribute("placeholder")).toBe("Enter your z.ai API key");
	});
});
