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
		});
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
		});
	});

	it("tolerates a non-object auth claim without throwing", () => {
		const accessToken = makeJwt({ "https://api.openai.com/auth": "nope" });
		expect(extractCodexIdentity(accessToken)).toEqual({
			externalAccountId: null,
			email: null,
			organizationName: null,
			planTier: null,
		});
	});
});
