import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type Account, api } from "../../api";
import { AccountList } from "./AccountList";
import { GrokSubscriptionReauthDialog } from "./GrokSubscriptionReauthDialog";

/**
 * What the status poll does with each answer the backend can give. The
 * hand-off itself (anchor, copy buttons, nothing auto-opened) is pinned for
 * every dialog at once in `ReauthDialogs.authlink.dom-test.tsx`; this file is
 * about the three settled outcomes, one of which — the session store's TTL
 * expiring — arrives as a 404 rather than as a status body.
 *
 * Mounted for real: Radix renders `DialogContent` through a portal, which
 * `renderToStaticMarkup` cannot see.
 */

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const AUTH_URL = "https://accounts.x.ai/device?user_code=ABCD-1234";
const USER_CODE = "ABCD-1234";
/** Poll cadence the dialog hands to `setInterval`. */
const POLL_INTERVAL_MS = 3000;

const account: Account = {
	id: "grok-a",
	name: "SuperGrok",
	provider: "grok-subscription",
	requestCount: 0,
	totalRequests: 0,
	lastUsed: null,
	created: "2024-01-01T00:00:00Z",
	paused: false,
	tokenStatus: "valid",
	tokenExpiresAt: null,
	rateLimitStatus: "OK",
	rateLimitCause: "ok",
	rateLimitCauseResetMs: null,
	rateLimitProviderStatus: null,
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
	identityEmail: "person@example.test",
	identityOrganizationName: null,
	identityPlanTier: null,
	identityRateLimitTier: null,
	identitySubscriptionStatus: null,
	identitySubscriptionStartedAt: null,
	identitySubscriptionEndsAt: null,
	identitySubscriptionWillRenew: null,
	identitySubscriptionGraceEndsAt: null,
	identitySubscriptionCheckedAt: null,
	identityCapturedAt: null,
	identityProfileFetchedAt: null,
	isDuplicateAccount: false,
	duplicateAccountIds: [],
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let onSuccess = mock(() => {});

async function render(): Promise<void> {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<GrokSubscriptionReauthDialog
				account={account}
				isOpen={true}
				onClose={() => {}}
				onSuccess={onSuccess}
			/>,
		);
	});
}

function button(text: string): HTMLButtonElement {
	const found = [...document.querySelectorAll("button")].find(
		(node) => node.textContent?.trim() === text,
	);
	if (!found) throw new Error(`Missing button: ${text}`);
	return found as HTMLButtonElement;
}

function hasButton(text: string): boolean {
	return [...document.querySelectorAll("button")].some(
		(node) => node.textContent?.trim() === text,
	);
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

async function startAndPoll(
	status: Awaited<ReturnType<typeof api.getGrokSubscriptionAuthStatus>>,
): Promise<void> {
	spyOn(api, "initGrokSubscriptionReauth").mockResolvedValue({
		sessionId: "s1",
		authUrl: AUTH_URL,
		userCode: USER_CODE,
	});
	spyOn(api, "getGrokSubscriptionAuthStatus").mockResolvedValue(status);
	const captured = capturePoll();
	await render();
	await act(async () => {
		button("Start Re-authentication").click();
	});
	await captured.fire();
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	host?.remove();
	host = null;
	mock.restore();
	onSuccess = mock(() => {});
});

describe("GrokSubscriptionReauthDialog", () => {
	it("keeps waiting while the session is still pending", async () => {
		await startAndPoll({ status: "pending" });

		expect(document.body.textContent).toContain("Waiting for authorization");
		expect(document.querySelector(`a[href="${AUTH_URL}"]`)).not.toBeNull();
		expect(document.body.textContent).toContain(USER_CODE);
		expect(hasButton("Start Re-authentication")).toBe(false);
		expect(onSuccess).not.toHaveBeenCalled();
	});

	it("tells the operator the session expired rather than spinning on it", async () => {
		// The 404 the session store answers once its TTL passes is a settled
		// outcome, not a transient network failure: a poll that swallowed it
		// would leave the dialog waiting on a session the server has forgotten.
		await startAndPoll({ status: "expired" });

		expect(document.body.textContent).toContain("expired");
		expect(document.body.textContent).not.toContain(
			"Waiting for authorization",
		);
		expect(document.querySelector(`a[href="${AUTH_URL}"]`)).toBeNull();
		expect(hasButton("Start Re-authentication")).toBe(true);
		expect(onSuccess).not.toHaveBeenCalled();
	});

	it("shows the failure the backend reported", async () => {
		await startAndPoll({ status: "error", error: "device code denied" });

		expect(document.body.textContent).toContain("device code denied");
		expect(document.body.textContent).not.toContain("expired");
		expect(hasButton("Start Re-authentication")).toBe(true);
		expect(onSuccess).not.toHaveBeenCalled();
	});

	it("offers re-authentication for a grok-subscription account from the list", async () => {
		const reauth = mock(() => {});
		const noop = () => {};
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => {
			root?.render(
				<AccountList
					accounts={[account]}
					sortMode="default"
					onAutoFallbackToggle={noop}
					onAutoRefreshToggle={noop}
					onBillingTypeToggle={noop}
					onPauseToggle={noop}
					onForceResetRateLimit={noop}
					onRefreshUsage={async () => {}}
					onRemove={noop}
					onRename={noop}
					onPriorityChange={noop}
					onSaveNotes={noop}
					onRenewalChange={noop}
					onRecordPayment={noop}
					onGrokSubscriptionReauth={reauth}
				/>,
			);
		});
		await act(async () => {
			document
				.querySelector('button[title="More actions"]')
				?.dispatchEvent(
					new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
				);
		});
		const item = [
			...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
		].find((node) => node.textContent?.trim() === "Re-authenticate");
		expect(item).toBeDefined();
		await act(async () => item?.click());
		expect(reauth).toHaveBeenCalledWith(account);
	});
});
