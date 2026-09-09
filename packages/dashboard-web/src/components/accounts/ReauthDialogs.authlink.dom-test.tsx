import {
	afterAll,
	afterEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Account } from "../../api";
import { api } from "../../api";
import { AnthropicReauthDialog } from "./AnthropicReauthDialog";
import { CodexReauthDialog } from "./CodexReauthDialog";
import { QwenReauthDialog } from "./QwenReauthDialog";

/**
 * The three re-auth dialogs must hand the authorization URL over instead of
 * opening it: the browser showing the dashboard is usually signed in to a
 * different account than the one being re-authenticated, so an auto-opened tab
 * lands in the wrong browser. The URL has to survive as a real anchor (for
 * right-click "copy link address") plus a Copy button, and `window.open` must
 * not be called at all.
 *
 * Mounted for real: Radix renders `DialogContent` through a portal, which
 * `renderToStaticMarkup` cannot see, and the link only exists after the init
 * call resolves.
 */

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const AUTH_URL =
	"https://claude.ai/oauth/authorize?code=true&client_id=abc123&state=xyz";
const USER_CODE = "ABCD-1234";
/** Failure the stubbed status poll reports, to send the dialog to its error step. */
const POLL_ERROR = "boom";
/** Poll cadence both device-flow dialogs hand to `setInterval`. */
const POLL_INTERVAL_MS = 3000;

interface ReauthDialogProps {
	account: Account | null;
	isOpen: boolean;
	onClose: () => void;
	onSuccess: () => void;
}

/**
 * Installs this dialog's init spy (plus its status poll, for device flows).
 * `gate` decides *when* the init resolves; the shape it resolves to belongs to
 * the dialog (`authUrl` vs `verificationUrl`).
 */
type StubInit = (gate: () => Promise<void>) => void;

/**
 * Re-points this dialog's status poll at a failure, so the next poll tick sends
 * it to its error step. Device flows only — the Anthropic dialog has no poll.
 */
type StubStatusError = () => void;

const DIALOGS: Array<
	[
		string,
		ComponentType<ReauthDialogProps>,
		string,
		StubInit,
		string | null,
		StubStatusError | null,
	]
> = [
	[
		"AnthropicReauthDialog",
		AnthropicReauthDialog,
		"anthropic",
		(gate) => {
			spyOn(api, "initAnthropicReauth").mockImplementation(async () => {
				await gate();
				return { authUrl: AUTH_URL, sessionId: "s1" };
			});
		},
		null,
		null,
	],
	[
		"CodexReauthDialog",
		CodexReauthDialog,
		"codex",
		(gate) => {
			spyOn(api, "initCodexReauth").mockImplementation(async () => {
				await gate();
				return {
					sessionId: "s1",
					verificationUrl: AUTH_URL,
					userCode: USER_CODE,
				};
			});
			spyOn(api, "getCodexAuthStatus").mockImplementation(async () => ({
				status: "pending" as const,
			}));
		},
		USER_CODE,
		() => {
			spyOn(api, "getCodexAuthStatus").mockImplementation(async () => ({
				status: "error" as const,
				error: POLL_ERROR,
			}));
		},
	],
	[
		"QwenReauthDialog",
		QwenReauthDialog,
		"qwen",
		(gate) => {
			spyOn(api, "initQwenReauth").mockImplementation(async () => {
				await gate();
				return { sessionId: "s1", authUrl: AUTH_URL, userCode: USER_CODE };
			});
			spyOn(api, "getQwenAuthStatus").mockImplementation(async () => ({
				status: "pending" as const,
			}));
		},
		USER_CODE,
		() => {
			spyOn(api, "getQwenAuthStatus").mockImplementation(async () => ({
				status: "error" as const,
				error: POLL_ERROR,
			}));
		},
	],
];

function makeAccount(provider: string): Account {
	return {
		id: "a1",
		name: "Backup1",
		provider,
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
		hasRefreshToken: true,
		notes: null,
		sessionStats: null,
		isPrimary: false,
		identityExternalId: null,
		identityEmail: null,
		identityOrganizationName: null,
		identityPlanTier: null,
		identityRateLimitTier: null,
		identityCapturedAt: null,
		identityProfileFetchedAt: null,
		isDuplicateAccount: false,
		duplicateAccountIds: [],
	};
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let openCalls = 0;
const realWindowOpen = globalThis.window.open;
globalThis.window.open = ((..._args: unknown[]) => {
	openCalls += 1;
	return null;
}) as unknown as typeof globalThis.window.open;

async function mount(
	Dialog: ComponentType<ReauthDialogProps>,
	provider: string,
): Promise<void> {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<Dialog
				account={makeAccount(provider)}
				isOpen={true}
				onClose={() => {}}
				onSuccess={() => {}}
			/>,
		);
	});
}

function byText<T extends Element>(selector: string, text: string): T {
	const match = Array.from(document.querySelectorAll(selector)).find(
		(el) => el.textContent?.trim() === text,
	);
	if (!match) throw new Error(`no ${selector} with text "${text}"`);
	return match as unknown as T;
}

async function clickStart(): Promise<void> {
	await act(async () => {
		byText<HTMLButtonElement>("button", "Start Re-authentication").click();
	});
}

/**
 * Swaps `setInterval` for a pass-through that also hands back the dialog's poll
 * callback, so a test can drive one poll tick synchronously instead of waiting
 * out the 3 s cadence. Only the dialog's own interval is captured; every other
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

describe.each(
	DIALOGS,
)("%s — authorization hand-off", (_name, Dialog, provider, stubInit, userCode, stubStatusError) => {
	it("renders the URL as a copyable link and never opens it", async () => {
		stubInit(async () => {});
		await mount(Dialog, provider);
		await clickStart();

		expect(openCalls).toBe(0);
		const link = document.querySelector<HTMLAnchorElement>(
			`a[href="${AUTH_URL}"]`,
		);
		expect(link).not.toBeNull();
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(link?.textContent).toBe("Open authorization page");
		expect(
			document.querySelector('button[title="Copy authorization link"]'),
		).not.toBeNull();

		const codeButton = document.querySelector('button[title="Copy user code"]');
		if (userCode) {
			expect(codeButton).not.toBeNull();
			expect(document.body.textContent).toContain(userCode);
		} else {
			expect(codeButton).toBeNull();
		}
	});

	if (userCode) {
		it("shows no link or copy button while the init call is in flight", async () => {
			let release: (() => void) | null = null;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			stubInit(() => gate);
			await mount(Dialog, provider);
			await clickStart();

			// The device flow switches to its pending step before the init call
			// resolves, so a retry must not be showing the previous session's
			// link while the new one is still being fetched.
			expect(document.querySelector("a[href]")).toBeNull();
			expect(
				document.querySelector('button[title="Copy authorization link"]'),
			).toBeNull();
			expect(
				document.querySelector('button[title="Copy user code"]'),
			).toBeNull();

			await act(async () => {
				release?.();
				await gate;
			});

			expect(document.querySelector(`a[href="${AUTH_URL}"]`)).not.toBeNull();
			expect(openCalls).toBe(0);
		});
	}

	if (userCode && stubStatusError) {
		it("drops the failed attempt's link and code while the retry is in flight", async () => {
			// Attempt 1: the init resolves at once, then the first poll tick
			// reports a failure, so the dialog lands on its error step with the
			// URL and user code still held in component state.
			stubInit(async () => {});
			stubStatusError();
			const captured = capturePoll();

			await mount(Dialog, provider);
			await clickStart();
			expect(document.querySelector(`a[href="${AUTH_URL}"]`)).not.toBeNull();

			await captured.fire();
			expect(document.body.textContent).toContain(POLL_ERROR);
			// The error step renders no hand-off, so nothing is on screen yet.
			expect(document.querySelector("a[href]")).toBeNull();

			// Attempt 2, held open. The retry re-enters the pending step before
			// the new device code exists, and the failed attempt's link and code
			// belong to a session the server has finished with, so neither may
			// still be on screen while this init is in flight.
			let release: (() => void) | null = null;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			stubInit(() => gate);
			await clickStart();

			expect(document.querySelector("a[href]")).toBeNull();
			expect(
				document.querySelector('button[title="Copy authorization link"]'),
			).toBeNull();
			expect(
				document.querySelector('button[title="Copy user code"]'),
			).toBeNull();

			await act(async () => {
				release?.();
				await gate;
			});

			expect(document.querySelector(`a[href="${AUTH_URL}"]`)).not.toBeNull();
			expect(openCalls).toBe(0);
		});
	}
});
