import { afterEach, expect, it, mock, spyOn } from "bun:test";
import type { AccountResponse } from "@clankermux/types";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../../api";
import { AccountStatusChips } from "./AccountStatusChips";
import { APPLY_NOW_TITLE, RESET_HISTORY_HEADING } from "./UsageResetPanels";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const randomUUIDDescriptor = Object.getOwnPropertyDescriptor(
	crypto,
	"randomUUID",
);

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	mock.restore();
	if (randomUUIDDescriptor) {
		Object.defineProperty(crypto, "randomUUID", randomUUIDDescriptor);
	} else {
		Reflect.deleteProperty(crypto, "randomUUID");
	}
});

async function clickButton(label: string): Promise<void> {
	const button = Array.from(document.querySelectorAll("button")).find(
		(element) => element.textContent === label,
	);
	expect(button).toBeDefined();
	await act(async () => button?.click());
}

const account: AccountResponse = {
	id: "reset-account",
	name: "Codex test",
	provider: "codex",
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
	hasRefreshToken: false,
	notes: null,
	sessionStats: null,
	isPrimary: false,
	autoPauseOnOverageEnabled: false,
	peakHoursPauseEnabled: false,
	providerOverloadKey: null,
	providerOverloadedUntil: null,
	billingType: null,
	renewalAnchor: null,
	renewalCadence: null,
	identityExternalId: null,
	identityEmail: null,
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
	codexRateLimitResetCredits: {
		availableCount: 1,
		credits: [],
		fetchedAt: new Date().toISOString(),
	},
};

async function openPopover(): Promise<void> {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root?.render(<AccountStatusChips account={account} />));
	const trigger = document.querySelector<HTMLElement>(
		'[title$="Click for history."]',
	);
	expect(trigger).not.toBeNull();
	await act(async () => trigger?.click());
}

it.each([
	true,
	false,
])("confirms and retries a reset with one UUID (randomUUID available: %s)", async (hasRandomUUID) => {
	if (!hasRandomUUID) {
		// Plain HTTP LAN pages expose getRandomValues, but not randomUUID.
		Object.defineProperty(crypto, "randomUUID", {
			value: undefined,
			configurable: true,
		});
	}
	spyOn(api, "getAccountResetCreditEvents").mockResolvedValue([]);
	const consume = spyOn(api, "consumeAccountResetCredit")
		.mockRejectedValueOnce(new Error("Temporary failure"))
		.mockResolvedValue({
			success: true,
			message: "Usage limits reset",
			outcome: "reset",
			windowsReset: 1,
			resetMetadataRefreshed: true,
			availableResetCount: 0,
			localRateLimitStateCleared: true,
		});
	await openPopover();
	expect(document.body.textContent).toContain(RESET_HISTORY_HEADING);
	expect(
		Array.from(document.querySelectorAll("button")).find(
			(element) => element.textContent === "Apply now",
		)?.title,
	).toBe(APPLY_NOW_TITLE);
	await clickButton("Apply now");
	expect(document.body.textContent).toContain(
		"Use 1 banked reset for Codex test?",
	);
	expect(consume).not.toHaveBeenCalled();
	await clickButton("Confirm");
	expect(document.body.textContent).toContain(
		"Failed to apply reset: Temporary failure",
	);
	expect(consume).toHaveBeenCalledTimes(1);
	const key = consume.mock.calls[0]?.[1];
	expect(key).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	await clickButton("Retry");
	expect(consume).toHaveBeenNthCalledWith(2, "reset-account", key);
	await clickButton("Done");
	await clickButton("Apply now");
	await clickButton("Cancel");
	expect(consume).toHaveBeenCalledTimes(2);
	await clickButton("Apply now");
	await clickButton("Confirm");
	expect(consume).toHaveBeenCalledTimes(3);
	expect(consume.mock.calls[2]?.[1]).not.toBe(key);
});

it.each([
	["Reset applied", true],
	["Already used", false],
] as const)("settles an alreadyRedeemed answer as '%s'", async (message, success) => {
	spyOn(api, "getAccountResetCreditEvents").mockResolvedValue([]);
	spyOn(api, "consumeAccountResetCredit").mockResolvedValue({
		success,
		message: "This reset attempt already completed",
		outcome: "alreadyRedeemed",
		windowsReset: 0,
		resetMetadataRefreshed: true,
		availableResetCount: 0,
		localRateLimitStateCleared: false,
	});
	await openPopover();
	await clickButton("Apply now");
	await clickButton("Confirm");
	const outcome = Array.from(document.querySelectorAll("p")).find(
		(element) => element.textContent === message,
	);
	expect(outcome?.classList.contains("text-success-strong")).toBe(success);
});
