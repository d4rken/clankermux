import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { HttpError } from "@clankermux/http-common";
import type {
	AccountResponse,
	AnthropicBankedResetClaimResponse,
	AnthropicBankedResetEventResponse,
} from "@clankermux/types";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../../api";
import { AccountStatusChips } from "./AccountStatusChips";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	mock.restore();
});

const account: AccountResponse = {
	id: "claude-account",
	name: "Claude test",
	provider: "anthropic",
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
	billingType: null,
	autoPauseOnOverageEnabled: false,
	peakHoursPauseEnabled: false,
	providerOverloadKey: null,
	providerOverloadedUntil: null,
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
	anthropicBankedResets: {
		eligible: true,
		ineligibleReason: null,
		exhausted: ["seven_day"],
		cooldownUntil: null,
		weeklyResetsAt: null,
		nextGrantId: "grant-1",
		grants: [
			{
				id: "grant-1",
				label: "Welcome reset",
				resetsLeft: 1,
				resetsTotal: 1,
				endsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
				startsAt: null,
				clears: ["seven_day"],
				paused: false,
				usableNow: true,
				useRequiresLimit: true,
				isNext: true,
			},
		],
		resetsLeftTotal: 1,
		fetchedAt: new Date().toISOString(),
	},
};

function claimResponse(
	overrides: Partial<AnthropicBankedResetClaimResponse>,
): AnthropicBankedResetClaimResponse {
	return {
		success: false,
		message: "server message",
		eventId: "row-1",
		status: "pending",
		result: "unavailable",
		reason: null,
		resetsLeft: null,
		cleared: [],
		cooldownUntil: null,
		nextAttemptAt: null,
		statusRefreshed: false,
		...overrides,
	};
}

async function openPopover(): Promise<void> {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root?.render(<AccountStatusChips account={account} />));
	const trigger = document.querySelector<HTMLElement>(
		'[title$="Click for grants and reset history."]',
	);
	expect(trigger).not.toBeNull();
	await act(async () => trigger?.click());
}

async function clickButton(label: string): Promise<void> {
	const button = Array.from(document.querySelectorAll("button")).find(
		(element) => element.textContent === label,
	);
	expect(button).toBeDefined();
	await act(async () => button?.click());
}

it("keeps one request id across a transport failure and a pending answer", async () => {
	spyOn(api, "getAccountBankedResetEvents").mockResolvedValue([]);
	const claim = spyOn(api, "claimAccountBankedReset")
		.mockRejectedValueOnce(new HttpError(500, "Could not refresh token"))
		.mockResolvedValueOnce(
			claimResponse({
				status: "pending",
				nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
			}),
		)
		.mockResolvedValue(
			claimResponse({ success: true, status: "reset", result: "reset" }),
		);

	await openPopover();
	expect(document.body.textContent).toContain("Welcome reset");
	await clickButton("Apply now");
	expect(document.body.textContent).toContain(
		"Use 1 reset from Welcome reset for Claude test?",
	);
	expect(claim).not.toHaveBeenCalled();

	await clickButton("Confirm");
	expect(document.body.textContent).toContain(
		"Failed to apply reset: Could not refresh token",
	);
	const requestId = claim.mock.calls[0]?.[1].requestId;
	expect(requestId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
	expect(claim.mock.calls[0]?.[1].grantId).toBe("grant-1");

	await clickButton("Retry");
	expect(document.body.textContent).toContain(
		"Couldn't confirm — retry after ",
	);
	await clickButton("Retry");
	expect(document.body.textContent).toContain("Limits reset");
	expect(claim).toHaveBeenCalledTimes(3);
	for (const call of claim.mock.calls) {
		expect(call).toEqual([
			"claude-account",
			{ grantId: "grant-1", requestId: requestId as string },
		]);
	}

	// A settled claim drops its id: the next attempt is a new claim.
	await clickButton("Done");
	await clickButton("Apply now");
	await clickButton("Confirm");
	expect(claim.mock.calls[3]?.[1].requestId).not.toBe(requestId);
});

it("settles a rejected claim with the server's message and no Retry", async () => {
	spyOn(api, "getAccountBankedResetEvents").mockResolvedValue([]);
	spyOn(api, "claimAccountBankedReset").mockRejectedValue(
		new HttpError(409, "Another banked-reset claim is already in progress"),
	);
	await openPopover();
	await clickButton("Apply now");
	await clickButton("Confirm");
	expect(document.body.textContent).toContain(
		"Another banked-reset claim is already in progress",
	);
	expect(
		Array.from(document.querySelectorAll("button")).some(
			(button) => button.textContent === "Retry",
		),
	).toBe(false);
});

it("retries a claim left pending before a reload with its own request id", async () => {
	const pending: AnthropicBankedResetEventResponse = {
		id: "row-1",
		grantId: "grant-1",
		trigger: "manual",
		cause: null,
		attemptSeq: null,
		status: "pending",
		reason: null,
		cleared: [],
		resetsLeft: null,
		errorMessage: "Anthropic answered unavailable",
		grantEndsAt: null,
		nextAttemptAt: null,
		createdAt: new Date().toISOString(),
		resolvedAt: null,
		requestId: "earlier-request",
	};
	spyOn(api, "getAccountBankedResetEvents").mockResolvedValue([pending]);
	const claim = spyOn(api, "claimAccountBankedReset").mockResolvedValue(
		claimResponse({ success: true, status: "already_used" }),
	);

	await openPopover();
	expect(document.body.textContent).toContain("Couldn't confirm — retry");
	await clickButton("Retry");
	expect(claim).toHaveBeenCalledWith("claude-account", {
		grantId: "grant-1",
		requestId: "earlier-request",
	});
	expect(document.body.textContent).toContain("Already used");
});
