/**
 * Tests for `shouldStopPollingPausedAccount` — the decision used by the usage
 * polling loop to STOP polling an account whose OAuth refresh token is
 * unrecoverable (terminal invalid_grant) and which is currently paused, since
 * recovery requires a manual reauth and further polling is pure waste + spam.
 */
import { describe, expect, it } from "bun:test";
import {
	OAuthRefreshTokenError,
	PAUSE_REASON_NEEDS_REAUTH,
	TokenRefreshError,
} from "@clankermux/core";
import type { Account } from "@clankermux/types";
import { shouldStopPollingPausedAccount } from "./usage-polling-halt";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
		access_token: "a",
		refresh_token: "r",
		expires_at: 1_000,
		paused: true,
		pause_reason: "subscription_expired",
		...overrides,
	} as Account;
}

const invalidGrantWrapped = new TokenRefreshError(
	"acc-1",
	new Error("OAuth tokens have expired for account 'x'. Re-authenticate."),
	true, // isInvalidGrant — marker stripped from message, flag carries the truth
);
const transientWrapped = new TokenRefreshError(
	"acc-1",
	new Error("network timeout"),
	false,
);

describe("shouldStopPollingPausedAccount", () => {
	it("halts: paused + wrapped TokenRefreshError flagged invalid_grant (e.g. subscription_expired + revoked token)", () => {
		expect(
			shouldStopPollingPausedAccount(makeAccount(), invalidGrantWrapped),
		).toBe(true);
	});

	it("halts: paused + raw OAuthRefreshTokenError", () => {
		const err = new OAuthRefreshTokenError("acc-1", "Refresh token expired");
		expect(shouldStopPollingPausedAccount(makeAccount(), err)).toBe(true);
	});

	it("halts: paused oauth_invalid_grant regardless of the error shape", () => {
		const acc = makeAccount({ pause_reason: PAUSE_REASON_NEEDS_REAUTH });
		expect(
			shouldStopPollingPausedAccount(acc, new Error("network timeout")),
		).toBe(true);
	});

	it("halts: paused + bare invalid_grant message string", () => {
		expect(
			shouldStopPollingPausedAccount(
				makeAccount(),
				"Refresh token not found or invalid",
			),
		).toBe(true);
	});

	it("does NOT halt: paused + transient wrapped error (keeps retrying)", () => {
		expect(
			shouldStopPollingPausedAccount(makeAccount(), transientWrapped),
		).toBe(false);
	});

	it("does NOT halt: paused subscription_expired + transient error (valid token, auto-recovery preserved)", () => {
		expect(
			shouldStopPollingPausedAccount(
				makeAccount({ pause_reason: "subscription_expired" }),
				new Error("Status 503 Service Unavailable"),
			),
		).toBe(false);
	});

	it("does NOT halt: active (non-paused) account even with invalid_grant", () => {
		const err = new OAuthRefreshTokenError("acc-1", "Refresh token expired");
		expect(
			shouldStopPollingPausedAccount(makeAccount({ paused: false }), err),
		).toBe(false);
	});

	it("does NOT halt when account is missing/null", () => {
		const err = new OAuthRefreshTokenError("acc-1", "Refresh token expired");
		expect(shouldStopPollingPausedAccount(null, err)).toBe(false);
		expect(shouldStopPollingPausedAccount(undefined, err)).toBe(false);
	});
});
