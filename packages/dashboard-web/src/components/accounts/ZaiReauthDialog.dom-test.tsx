import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type Account, api } from "../../api";
import { AccountList } from "./AccountList";
import { ZaiReauthDialog } from "./ZaiReauthDialog";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const account: Account = {
	id: "zai-a",
	name: "My z.ai",
	provider: "zai",
	identityEmail: "person@example.test",
	identityExternalId: "provider-account-a",
	identityPlanTier: "coding-plan",
	tokenExpiresAt: "2027-01-01T00:00:00Z",
	tokenStatus: "valid",
	rateLimitStatus: "OK",
	rateLimitCause: "ok",
	rateLimitCauseResetMs: null,
	rateLimitProviderStatus: null,
	usageData: null,
	usageThrottledWindows: [],
	requestCount: 0,
	totalRequests: 0,
	lastUsed: null,
	created: "2024-01-01T00:00:00Z",
	paused: false,
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
	usageRateLimitedUntil: null,
	usageThrottledUntil: null,
	hasRefreshToken: false,
	notes: null,
	sessionStats: null,
	isPrimary: false,
	identityOrganizationName: null,
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
const login = {
	sessionId: "session-a",
	authUrl: "https://chat.z.ai/api/oauth/authorize?state=test",
	expiresAt: Date.now() + 600_000,
};
const REDIRECT_URL =
	"https://zcode.z.ai/cn/oauth/callback?code=one-use-code&state=test";
let root: Root | null = null;
let host: HTMLElement | null = null;
let onClose = mock(() => {});
let onSuccess = mock(() => {});
async function render(current: Account | null = account, isOpen = true) {
	if (!root) {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	}
	await act(async () =>
		root?.render(
			<ZaiReauthDialog
				account={current}
				isOpen={isOpen}
				onClose={onClose}
				onSuccess={onSuccess}
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
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	host?.remove();
	host = null;
	mock.restore();
	onClose = mock(() => {});
	onSuccess = mock(() => {});
});

describe("Z.AI account reconnect", () => {
	it("shows the existing identity and a copyable hand-off instead of opening a tab", async () => {
		const start = spyOn(api, "startZaiReauth").mockResolvedValue(login);
		const open = spyOn(window, "open").mockReturnValue(null);
		await render();
		expect(document.body.textContent).toContain("person@example.test");
		expect(document.body.textContent).toContain("provider-account-a");
		await click("Sign in with Z.AI");
		expect(start).toHaveBeenCalledWith({ accountId: account.id });
		expect(document.querySelector(`a[href="${login.authUrl}"]`)).not.toBeNull();
		expect(document.body.textContent).toContain("zcode.z.ai");
		expect(
			document.querySelector<HTMLInputElement>("#zai-reauth-redirect"),
		).not.toBeNull();
		expect(open).not.toHaveBeenCalled();
	});

	it("guards duplicate starts and completes once against the open session", async () => {
		const gate = deferred<typeof login>();
		const start = spyOn(api, "startZaiReauth").mockReturnValue(gate.promise);
		const completeGate = deferred<{ success: boolean }>();
		const complete = spyOn(api, "completeZaiReauth").mockReturnValue(
			completeGate.promise,
		);
		await render();
		await act(async () => {
			const startButton = button("Sign in with Z.AI");
			startButton.click();
			startButton.click();
		});
		expect(start).toHaveBeenCalledTimes(1);
		expect(button("Sign in with Z.AI").disabled).toBe(true);
		await act(async () => gate.resolve(login));
		await type("zai-reauth-redirect", "   ");
		expect(button("Complete Z.AI sign-in").disabled).toBe(true);
		await type("zai-reauth-redirect", ` ${REDIRECT_URL} `);
		await act(async () => {
			const submit = button("Complete Z.AI sign-in");
			submit.click();
			submit.click();
		});
		expect(complete).toHaveBeenCalledTimes(1);
		expect(complete).toHaveBeenCalledWith({
			sessionId: login.sessionId,
			code: REDIRECT_URL,
		});
		await act(async () => completeGate.resolve({ success: true }));
		expect(onSuccess).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("reports a rejected sign-in and allows another attempt", async () => {
		spyOn(api, "startZaiReauth").mockResolvedValue(login);
		const complete = spyOn(api, "completeZaiReauth")
			.mockRejectedValueOnce(
				new Error(
					"Z.AI sign-in belongs to a different account; sign in with the account shown",
				),
			)
			.mockResolvedValue({ success: true });
		await render();
		await click("Sign in with Z.AI");
		await type("zai-reauth-redirect", REDIRECT_URL);
		await click("Complete Z.AI sign-in");
		expect(document.body.textContent).toContain("different account");
		expect(onSuccess).not.toHaveBeenCalled();
		await click("Sign in with Z.AI");
		await type("zai-reauth-redirect", REDIRECT_URL);
		await click("Complete Z.AI sign-in");
		expect(complete).toHaveBeenCalledTimes(2);
		expect(onSuccess).toHaveBeenCalledTimes(1);
	});

	it("discards an old account's pending login when another account opens", async () => {
		const gate = deferred<typeof login>();
		spyOn(api, "startZaiReauth").mockReturnValue(gate.promise);
		await render();
		await click("Sign in with Z.AI");
		await render({
			...account,
			id: "zai-b",
			identityEmail: "other@example.test",
		});
		await act(async () => gate.resolve(login));
		expect(document.querySelector(`a[href="${login.authUrl}"]`)).toBeNull();
		expect(document.body.textContent).toContain("other@example.test");
		expect(button("Sign in with Z.AI").disabled).toBe(false);
	});

	it("ignores a completion that lands after the dialog was closed and reopened", async () => {
		spyOn(api, "startZaiReauth").mockResolvedValue(login);
		const gate = deferred<{ success: boolean }>();
		spyOn(api, "completeZaiReauth").mockReturnValue(gate.promise);
		await render();
		await click("Sign in with Z.AI");
		await type("zai-reauth-redirect", REDIRECT_URL);
		await click("Complete Z.AI sign-in");
		await click("Cancel");
		await render(account, false);
		await render(account, true);
		await act(async () => gate.resolve({ success: true }));
		expect(onSuccess).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(document.querySelector("#zai-reauth-redirect")).toBeNull();
		expect(button("Sign in with Z.AI").disabled).toBe(false);
	});

	it("offers reconnect for a z.ai account from the accounts list", async () => {
		const reconnect = mock(() => {});
		const noop = () => {};
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () =>
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
					onZaiReauth={reconnect}
				/>,
			),
		);
		await act(async () =>
			document
				.querySelector('button[title="More actions"]')
				?.dispatchEvent(
					new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
				),
		);
		const item = [
			...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
		].find((node) => node.textContent?.trim() === "Reconnect");
		expect(item).toBeDefined();
		await act(async () => item?.click());
		expect(reconnect).toHaveBeenCalledWith(account);
	});
});
