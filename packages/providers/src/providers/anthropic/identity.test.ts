import { describe, expect, it } from "bun:test";
import { extractAnthropicIdentity } from "./identity";

describe("extractAnthropicIdentity", () => {
	it("extracts a full identity and normalizes the plan tier", () => {
		expect(
			extractAnthropicIdentity({
				account: {
					uuid: "acct-uuid-1",
					email_address: "Owner@Example.com",
				},
				organization: {
					name: "Acme Inc",
					organization_type: "claude_max",
				},
			}),
		).toEqual({
			externalAccountId: "acct-uuid-1",
			email: "owner@example.com",
			organizationName: "Acme Inc",
			planTier: "max",
		});
	});

	it("falls back to `email` when `email_address` is absent", () => {
		const identity = extractAnthropicIdentity({
			account: { uuid: "u2", email: "Fallback@Example.com" },
		});
		expect(identity?.email).toBe("fallback@example.com");
		expect(identity?.externalAccountId).toBe("u2");
	});

	it("falls back to organization.type and passes unknown tiers through lowercased", () => {
		const identity = extractAnthropicIdentity({
			organization: { name: "Org", type: "Claude_Something_New" },
		});
		expect(identity?.planTier).toBe("claude_something_new");
		expect(identity?.organizationName).toBe("Org");
	});

	it("maps each known tier", () => {
		const cases: Array<[string, string]> = [
			["claude_max", "max"],
			["claude_pro", "pro"],
			["claude_team", "team"],
			["claude_enterprise", "enterprise"],
		];
		for (const [raw, expected] of cases) {
			const identity = extractAnthropicIdentity({
				organization: { organization_type: raw },
			});
			expect(identity?.planTier).toBe(expected);
		}
	});

	it("returns null when both account and organization are absent", () => {
		expect(extractAnthropicIdentity({})).toBeNull();
		expect(extractAnthropicIdentity(null)).toBeNull();
		expect(extractAnthropicIdentity("nope")).toBeNull();
		expect(
			extractAnthropicIdentity({ account: "bad", organization: 3 }),
		).toBeNull();
	});

	it("yields null fields for present-but-empty account/organization objects", () => {
		expect(extractAnthropicIdentity({ account: {} })).toEqual({
			externalAccountId: null,
			email: null,
			organizationName: null,
			planTier: null,
		});
	});
});
