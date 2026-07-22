import { describe, expect, it } from "bun:test";
import { extractCodexIdentity } from "./identity";

function b64url(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function makeJwt(payload: unknown): string {
	return `header.${b64url(JSON.stringify(payload))}.sig`;
}

describe("extractCodexIdentity", () => {
	it("extracts external id, plan tier, and email from access+id tokens", () => {
		const accessToken = makeJwt({
			"https://api.openai.com/auth": {
				chatgpt_account_id: "acct-123",
				chatgpt_plan_type: "Plus",
			},
		});
		const idToken = makeJwt({
			email: "  Person@Example.COM ",
			name: "Person",
		});

		expect(extractCodexIdentity(accessToken, idToken)).toEqual({
			externalAccountId: "acct-123",
			email: "person@example.com",
			organizationName: null,
			planTier: "plus",
			rateLimitTier: null,
		});
	});

	it("leaves email null when no id token is provided", () => {
		const accessToken = makeJwt({
			"https://api.openai.com/auth": {
				chatgpt_account_id: "acct-abc",
				chatgpt_plan_type: "pro",
			},
		});

		expect(extractCodexIdentity(accessToken)).toEqual({
			externalAccountId: "acct-abc",
			email: null,
			organizationName: null,
			planTier: "pro",
			rateLimitTier: null,
		});
	});

	it("reads email from the access token profile claim when no id token is provided", () => {
		const accessToken = makeJwt({
			"https://api.openai.com/auth": {
				chatgpt_account_id: "acct-xyz",
				chatgpt_plan_type: "team",
			},
			"https://api.openai.com/profile": {
				email: "  Access@Example.COM ",
				email_verified: true,
			},
		});

		expect(extractCodexIdentity(accessToken)).toEqual({
			externalAccountId: "acct-xyz",
			email: "access@example.com",
			organizationName: null,
			planTier: "team",
			rateLimitTier: null,
		});
	});

	it("prefers the id token email over the access token profile claim", () => {
		const accessToken = makeJwt({
			"https://api.openai.com/auth": {
				chatgpt_account_id: "acct-both",
				chatgpt_plan_type: "pro",
			},
			"https://api.openai.com/profile": {
				email: "access@example.com",
			},
		});
		const idToken = makeJwt({ email: "  Id@Example.COM " });

		expect(extractCodexIdentity(accessToken, idToken)).toEqual({
			externalAccountId: "acct-both",
			email: "id@example.com",
			organizationName: null,
			planTier: "pro",
			rateLimitTier: null,
		});
	});

	it("falls back to the access token profile email when the id token lacks one", () => {
		const accessToken = makeJwt({
			"https://api.openai.com/auth": {
				chatgpt_account_id: "acct-fallback",
				chatgpt_plan_type: "plus",
			},
			"https://api.openai.com/profile": {
				email: "access@example.com",
			},
		});
		// id token present but carries no email claim.
		const idToken = makeJwt({ name: "No Email" });

		expect(extractCodexIdentity(accessToken, idToken)?.email).toBe(
			"access@example.com",
		);
	});

	it("leaves email null when neither token carries an email", () => {
		const accessToken = makeJwt({
			"https://api.openai.com/auth": {
				chatgpt_account_id: "acct-none",
				chatgpt_plan_type: "pro",
			},
		});

		expect(extractCodexIdentity(accessToken)?.email).toBeNull();
	});

	it("returns null when the access token cannot be decoded", () => {
		expect(extractCodexIdentity("not-a-jwt")).toBeNull();
	});

	it("returns null fields (not a throw) when the auth claim is missing", () => {
		const accessToken = makeJwt({ some: "other-claim" });
		expect(extractCodexIdentity(accessToken)).toEqual({
			externalAccountId: null,
			email: null,
			organizationName: null,
			planTier: null,
			rateLimitTier: null,
		});
	});

	it("tolerates a non-object auth claim without throwing", () => {
		const accessToken = makeJwt({ "https://api.openai.com/auth": "nope" });
		expect(extractCodexIdentity(accessToken)).toEqual({
			externalAccountId: null,
			email: null,
			organizationName: null,
			planTier: null,
			rateLimitTier: null,
		});
	});
});
