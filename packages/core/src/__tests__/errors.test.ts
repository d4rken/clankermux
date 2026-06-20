import { describe, expect, it } from "bun:test";
import {
	isInvalidGrantMessage,
	OAuthRefreshTokenError,
	PAUSE_REASON_NEEDS_REAUTH,
} from "../errors";

describe("isInvalidGrantMessage", () => {
	it("matches the terminal OAuth markers (case-insensitive)", () => {
		const positives = [
			"invalid_grant",
			'{"error":"invalid_grant","error_description":"..."}',
			"INVALID_GRANT",
			"invalid_refresh_token",
			"refresh_token_reused",
			"Refresh token not found or invalid",
			"refresh token NOT FOUND or invalid",
			"OAuth authentication is currently not supported",
		];
		for (const msg of positives) {
			expect(isInvalidGrantMessage(msg)).toBe(true);
		}
	});

	it("does not match transient / non-auth failures", () => {
		const negatives = [
			"Internal Server Error",
			"500",
			"fetch failed",
			"ETIMEDOUT",
			"rate limit exceeded",
			"Service Unavailable",
			"",
			null,
			undefined,
		];
		for (const msg of negatives) {
			expect(isInvalidGrantMessage(msg)).toBe(false);
		}
	});
});

describe("OAuthRefreshTokenError", () => {
	it("carries the OAUTH_INVALID_GRANT code and accountId", () => {
		const err = new OAuthRefreshTokenError("acct-1");
		expect(err).toBeInstanceOf(Error);
		expect(err.code).toBe("OAUTH_INVALID_GRANT");
		expect(err.statusCode).toBe(401);
		expect(err.accountId).toBe("acct-1");
	});
});

describe("PAUSE_REASON_NEEDS_REAUTH", () => {
	it("is the stable oauth_invalid_grant string", () => {
		expect(PAUSE_REASON_NEEDS_REAUTH).toBe("oauth_invalid_grant");
	});
});
