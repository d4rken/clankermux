import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type Account, api } from "../../api";
import { AccountList } from "./AccountList";
import { DevinReauthDialog } from "./DevinReauthDialog";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const account: Account = {
	id: "devin-a",
	name: "My Devin",
	provider: "devin",
	identityEmail: "devin@example.test",
	identityExternalId: "provider-account-a",
	identityPlanTier: "free",
	tokenExpiresAt: "2027-01-01T00:00:00Z",
	tokenStatus: "valid",
	rateLimitStatus: "OK",
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
	modelMappings: null,
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
	identityCapturedAt: null,
	identityProfileFetchedAt: null,
	isDuplicateAccount: false,
	duplicateAccountIds: [],
};
const login = {
	sessionId: "session-a",
	authUrl: "https://app.devin.ai/authorize?state=test",
	expiresAt: Date.now() + 600_000,
};
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
			<DevinReauthDialog
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

describe("Devin account reconnect", () => {
	it("omits an expiry deadline for opaque sessions with no known expiry", async () => {
		await render({ ...account, tokenExpiresAt: null });
		expect(document.body.textContent).not.toContain("Session expires");
		expect(document.body.textContent).not.toContain("Session expired");
		expect(document.body.textContent).not.toContain("1970");
	});
	it("shows the existing identity, expiry and a copyable headless browser handoff", async () => {
		const start = spyOn(api, "startDevinReauth").mockResolvedValue(login);
		const open = spyOn(window, "open").mockReturnValue(null);
		await render();
		expect(document.body.textContent).toContain("devin@example.test");
		expect(document.body.textContent).toContain("provider-account-a");
		expect(document.body.textContent).toContain("Session expires");
		await click("Sign in with Devin");
		expect(start).toHaveBeenCalledWith({ accountId: account.id });
		expect(document.querySelector(`a[href="${login.authUrl}"]`)).not.toBeNull();
		expect(document.body.textContent).toContain("Copy your login code");
		expect(document.body.textContent).toContain("code expires after 5 minutes");
		expect(document.body.textContent).not.toContain("localhost");
		const input =
			document.querySelector<HTMLInputElement>("#devin-reauth-code");
		expect(input?.type).toBe("password");
		expect(input?.getAttribute("autocomplete")).toBe("off");
		expect(input?.getAttribute("autocorrect")).toBe("off");
		expect(input?.getAttribute("autocapitalize")).toBe("none");
		expect(input?.getAttribute("spellcheck")).toBe("false");
		expect(open).not.toHaveBeenCalled();
	});
	it("guards duplicate starts and completes once, clearing sensitive fields", async () => {
		const gate = deferred<typeof login>();
		const start = spyOn(api, "startDevinReauth").mockReturnValue(gate.promise);
		const completeGate = deferred<{ success: boolean }>();
		const complete = spyOn(api, "completeDevinReauth").mockReturnValue(
			completeGate.promise,
		);
		await render();
		await act(async () => {
			const startButton = button("Sign in with Devin");
			startButton.click();
			startButton.click();
		});
		expect(start).toHaveBeenCalledTimes(1);
		expect(button("Sign in with Devin").disabled).toBe(true);
		await act(async () => gate.resolve(login));
		await type("devin-reauth-code", "   ");
		expect(button("Complete Devin sign-in").disabled).toBe(true);
		await type("devin-reauth-code", " secret ");
		await act(async () => {
			const submit = button("Complete Devin sign-in");
			submit.click();
			submit.click();
		});
		expect(complete).toHaveBeenCalledTimes(1);
		expect(complete).toHaveBeenCalledWith({
			sessionId: login.sessionId,
			code: "secret",
		});
		expect(
			document.querySelector<HTMLInputElement>("#devin-reauth-code")?.value ??
				"",
		).toBe("");
		await act(async () => completeGate.resolve({ success: true }));
		expect(onSuccess).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
	});
	it("replaces the token on the selected account and permits retry after failure", async () => {
		const reconnect = spyOn(api, "reconnectDevinToken")
			.mockRejectedValueOnce(new Error("Account identity does not match"))
			.mockResolvedValue({ success: true });
		await render();
		await type("devin-reauth-token", " wrong-token ");
		await click("Reconnect with session token");
		expect(document.body.textContent).toContain(
			"Account identity does not match",
		);
		expect(
			(document.getElementById("devin-reauth-token") as HTMLInputElement).value,
		).toBe("");
		await type("devin-reauth-token", " fresh-token ");
		await click("Reconnect with session token");
		expect(reconnect).toHaveBeenLastCalledWith({
			accountId: account.id,
			apiKey: "fresh-token",
		});
		expect(onSuccess).toHaveBeenCalledTimes(1);
	});
	it("discards an old account's pending login when another account opens", async () => {
		const gate = deferred<typeof login>();
		spyOn(api, "startDevinReauth").mockReturnValue(gate.promise);
		await render();
		await click("Sign in with Devin");
		await render({
			...account,
			id: "devin-b",
			identityEmail: "other@example.test",
		});
		await act(async () => gate.resolve(login));
		expect(document.querySelector(`a[href="${login.authUrl}"]`)).toBeNull();
		expect(document.body.textContent).toContain("other@example.test");
		expect(button("Sign in with Devin").disabled).toBe(false);
	});
	it("ignores stale completion and clears token inputs after closing and reopening", async () => {
		const gate = deferred<{ success: boolean }>();
		spyOn(api, "reconnectDevinToken").mockReturnValue(gate.promise);
		await render();
		await type("devin-reauth-token", "pending-secret");
		await click("Reconnect with session token");
		await click("Cancel");
		await render(account, false);
		await render(account, true);
		await act(async () => gate.resolve({ success: true }));
		expect(onSuccess).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(
			(document.getElementById("devin-reauth-token") as HTMLInputElement).value,
		).toBe("");
		expect(button("Sign in with Devin").disabled).toBe(false);
	});
	it("forwards reconnect through the accounts list without requiring a refresh token", async () => {
		const reconnect = mock(() => {});
		const noop = () => {};
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () =>
			root?.render(
				<AccountList
					accounts={[account]}
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
					onDevinReauth={reconnect}
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
